/**
 * Job execution.
 *
 * Owns the browser lifecycle and assembles the pieces per job: an identity, a
 * bootstrap script, a session, an actuator, an adapter.
 *
 * **One Chrome process, many browser contexts.** A context is a cookie jar, a
 * storage partition and a cache — a few hundred KB. A Chrome *process* is a few
 * hundred MB. Running one browser per job is the most common way a scraping fleet
 * runs a host out of memory, and it buys nothing: contexts already give complete
 * isolation between identities.
 *
 * The browser is launched lazily and kept for the process lifetime, because launch
 * is the single most expensive operation here (~1s) and the profile — which
 * determines the launch flags — is fixed per worker process.
 */

import type Redis from 'ioredis';
import { config, type Profile } from './config.js';
import { logger } from './logger.js';
import { launchChrome, type ChromeInstance } from './cdp/chrome.js';
import { Session } from './cdp/session.js';
import { buildBootstrap } from './stealth/index.js';
import { IdentityPool } from './proxy/pool.js';
import { HumanActuator, ScriptedActuator, type Actuator } from './behavior/actuator.js';
import { Rng } from './behavior/rng.js';
import { VitrineAdapter, type PublishJob, type PublishOutcome } from './adapters/vitrine.js';
import { rawHttpPublish } from './adapters/rawHttp.js';

export class BrowserHost {
  private chrome: ChromeInstance | null = null;
  private launching: Promise<ChromeInstance> | null = null;

  constructor(private readonly profile: Profile) {}

  /**
   * Launch on first use, and make concurrent callers share one launch.
   *
   * Without the `launching` promise, N jobs starting together would each spawn a
   * browser on the same debugging port and all but one would fail.
   */
  private async ensure(): Promise<ChromeInstance> {
    if (this.chrome) return this.chrome;
    this.launching ??= launchChrome(this.profile).then((instance) => {
      this.chrome = instance;
      this.launching = null;
      return instance;
    });
    return this.launching;
  }

  async openSession(identity: ReturnType<IdentityPool['mint']>): Promise<Session> {
    const chrome = await this.ensure();
    const bootstrap = buildBootstrap(identity, this.profile);

    if (bootstrap.source) {
      logger.debug(
        { patches: bootstrap.appliedPatches, bytes: bootstrap.sourceBytes },
        'stealth bootstrap assembled',
      );
    }

    return Session.open({
      port: chrome.port,
      identity,
      bootstrapScript: bootstrap.source,
      // Both are consequences of the same decision — the stealth profile presents a
      // constructed identity, the naive one presents whatever the browser is.
      normalizeHeaderOrder: this.profile === 'stealth',
      applyIdentityOverrides: this.profile === 'stealth',
      viewport: identity.viewport,
    });
  }

  async close(): Promise<void> {
    await this.chrome?.close();
    this.chrome = null;
  }
}

export interface RunOptions {
  readonly profile: Profile;
  readonly seed?: string;
  readonly redis?: Redis;
}

export interface RunResult extends Record<string, unknown> {
  readonly outcome: PublishOutcome;
  readonly profile: Profile;
  readonly identity: string | null;
  readonly egressIp: string | null;
  readonly durationMs: number;
}

/**
 * Run one publish job end to end.
 *
 * The browser host is passed in rather than created here so a long-lived consumer
 * reuses one Chrome across every job it handles, while the CLI can create one, run a
 * single job and tear it down.
 */
export async function runPublishJob(
  job: PublishJob,
  host: BrowserHost | null,
  opts: RunOptions,
): Promise<RunResult> {
  const startedAt = Date.now();

  if (opts.profile === 'raw-http') {
    const outcome = await rawHttpPublish(job, config.TARGET_BASE_URL, {
      email: config.DEMO_EMAIL,
      password: config.DEMO_PASSWORD,
    });
    return {
      outcome,
      profile: opts.profile,
      identity: 'raw-http (no browser)',
      egressIp: null,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!host) throw new Error('a BrowserHost is required for browser profiles');

  const pool = new IdentityPool(
    // Residential egress is the expensive countermeasure, so only the stealth profile
    // gets it. The naive profile runs from datacenter space, which is what an
    // unconfigured scraper actually does.
    { residential: opts.profile === 'stealth', seed: opts.seed },
    opts.redis,
  );

  // Identity is pinned to the seller account, not to the job: the same "person"
  // must come back on the same device from the same city every time.
  const identity = await pool.forAccount(config.DEMO_EMAIL);

  const session = await host.openSession(identity);

  try {
    const rng = new Rng(opts.seed ? `${opts.seed}:${job.listingId}` : undefined);
    const actuator: Actuator =
      opts.profile === 'stealth' ? new HumanActuator(session, rng) : new ScriptedActuator(session);

    logger.info(
      { listingId: job.listingId, profile: opts.profile, actuator: actuator.kind, identity: identity.label },
      'starting publish job',
    );

    const adapter = new VitrineAdapter(session, actuator, config.TARGET_BASE_URL, {
      email: config.DEMO_EMAIL,
      password: config.DEMO_PASSWORD,
    });

    const outcome = await adapter.publish(job);

    // A blocked identity is a burned identity. Reusing it means the next job starts
    // with the reputation the last one earned.
    if (outcome.kind === 'blocked') {
      await pool.retire(config.DEMO_EMAIL);
    }

    return {
      outcome,
      profile: opts.profile,
      identity: identity.label,
      egressIp: identity.egressIp,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await session.close();
  }
}
