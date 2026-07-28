/**
 * Sentinelle — session state, rate limiting and the live event bus.
 *
 * All of it lives in Redis rather than in process memory, for the same reason a real
 * edge detector does: the thing making the decision is horizontally scaled and
 * disposable, and a session's evidence has to survive the request that produced it
 * landing on a different instance.
 */

import Redis from 'ioredis';
import type { Detection } from './scoring.js';

const SESSION_TTL_SECONDS = 60 * 30;
const COHORT_TTL_SECONDS = 60 * 15;

/**
 * Token bucket, as a Lua script so refill-check-consume is a single atomic step.
 *
 * The naive implementation — GET the count, decide in application code, SET it back —
 * is a read-modify-write race. Under concurrency it lets through roughly as many
 * extra requests as you have workers, which is precisely the situation a rate limiter
 * exists to prevent. Redis executes a script atomically against a single keyspace,
 * so the check and the decrement cannot interleave.
 *
 * Continuous refill (rather than fixed windows) also removes the boundary burst
 * where a client spends its whole budget at 0:59 and its whole next budget at 1:01.
 *
 * KEYS[1] bucket key
 * ARGV[1] capacity, ARGV[2] refill tokens/sec, ARGV[3] now (ms), ARGV[4] cost
 * returns {allowed 0|1, tokens_remaining}
 */
const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

-- Refill continuously for the time elapsed since we last looked.
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * rate)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Expire well after a full refill so idle buckets are reclaimed but active ones never
-- lose their state mid-session.
redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 2000))

return { allowed, math.floor(tokens) }
`;

export interface SessionRecord {
  readonly id: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly createdAt: number;
  readonly detections: Detection[];
  /** Set once the session has been served a challenge, so we can tell recovery from luck. */
  challengedAt?: number;
  solvedAt?: number;
  /** HTML pages served to this session — each one carried the probe script tag. */
  htmlServed?: number;
  /** Requests for /probe.js. Zero after an HTML page means nothing parsed the HTML. */
  probeFetched?: number;
  /** Telemetry reports received. Proof that JavaScript executed, not merely loaded. */
  telemetryReceived?: number;
}

export class SentinelleStore {
  private readonly redis: Redis;
  /** Separate connection: a client in subscriber mode cannot issue normal commands. */
  private readonly subscriber: Redis;
  private readonly listeners = new Set<(event: string) => void>();

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    this.subscriber = this.redis.duplicate();
    this.redis.defineCommand('takeToken', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });

    void this.subscriber.subscribe('sentinelle:events');
    this.subscriber.on('message', (_channel, message) => {
      for (const listener of this.listeners) listener(message);
    });
  }

  /**
   * Consume one token for `identity`. Returns false when the budget is exhausted.
   *
   * Keyed by egress IP, which is exactly why residential proxy rotation is worth
   * paying for: it turns one budget into thousands.
   */
  async takeToken(identity: string, capacity: number, refillPerSecond: number): Promise<boolean> {
    const [allowed] = (await (this.redis as unknown as {
      takeToken(key: string, capacity: number, rate: number, now: number, cost: number): Promise<[number, number]>;
    }).takeToken(`sentinelle:bucket:${identity}`, capacity, refillPerSecond, Date.now(), 1)) ?? [1, 0];
    return allowed === 1;
  }

  async loadSession(id: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(`sentinelle:session:${id}`);
    return raw ? (JSON.parse(raw) as SessionRecord) : null;
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.redis.set(
      `sentinelle:session:${session.id}`,
      JSON.stringify(session),
      'EX',
      SESSION_TTL_SECONDS,
    );
  }

  /**
   * Record this session against a canvas hash and report how many *distinct* sessions
   * now share it.
   *
   * This is the honest version of canvas fingerprinting. Matching a hardcoded
   * known-bad hash only catches yesterday's containers; watching for one hash worn by
   * many identities catches a fleet the first time it scales, because a thousand
   * identical containers cannot render a thousand different canvases.
   */
  async recordCanvasCohort(hash: string, sessionId: string): Promise<number> {
    const key = `sentinelle:canvas:${hash}`;
    const pipeline = this.redis.multi();
    pipeline.sadd(key, sessionId);
    pipeline.expire(key, COHORT_TTL_SECONDS);
    pipeline.scard(key);
    const results = await pipeline.exec();
    const card = results?.[2]?.[1];
    return typeof card === 'number' ? card : 0;
  }

  /** Fan out an assessment to every connected dashboard. */
  async publishEvent(event: unknown): Promise<void> {
    await this.redis.publish('sentinelle:events', JSON.stringify(event));
  }

  onEvent(listener: (event: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Recent assessments, newest first — used to hydrate the dashboard on load. */
  async recentEvents(limit = 50): Promise<unknown[]> {
    const raw = await this.redis.lrange('sentinelle:recent', 0, limit - 1);
    return raw.map((r) => JSON.parse(r) as unknown);
  }

  async pushRecent(event: unknown): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.lpush('sentinelle:recent', JSON.stringify(event));
    pipeline.ltrim('sentinelle:recent', 0, 199);
    pipeline.expire('sentinelle:recent', SESSION_TTL_SECONDS);
    await pipeline.exec();
  }

  /** Wipe every Sentinelle key. Used by `make demo` so runs are reproducible. */
  async reset(): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'sentinelle:*', 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) deleted += await this.redis.del(...keys);
    } while (cursor !== '0');
    return deleted;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.redis.quit(), this.subscriber.quit()]);
  }
}
