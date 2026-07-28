/**
 * Queue consumer — the worker's production entrypoint.
 *
 * The control plane owns the topology (exchanges, retry queues, dead-letter routing);
 * this side only asserts what it needs to consume and publish. Assertions are
 * idempotent as long as the arguments match, so both services can declare the same
 * objects without fighting — and a mismatch fails loudly at boot rather than silently
 * routing messages nowhere.
 *
 * The consumer is deliberately dumb about retries. It acks on completion — including
 * a *blocked* completion, which is a real answer, not a failure — and nacks without
 * requeue on an unexpected error, letting the broker's dead-letter routing hand the
 * message back to the control plane's retry ladder. Retry policy is a control-plane
 * decision; a worker that invents its own is how you get two competing backoff
 * schedules and a poison message that never dies.
 */

import amqplib, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';
import { BrowserHost, runPublishJob } from './runner.js';
import type { PublishJob } from './adapters/vitrine.js';

export const TOPOLOGY = {
  jobsExchange: 'revendo.jobs',
  publishQueue: 'revendo.publish.q',
  publishRoutingKey: 'publish',
  resultsExchange: 'revendo.results',
  resultRoutingKey: 'publish.result',
} as const;

const JobMessage = z.object({
  jobId: z.string(),
  listingId: z.string(),
  attempt: z.number().int().nonnegative().default(0),
  payload: z.object({
    title: z.string(),
    brand: z.string(),
    size: z.string(),
    condition: z.string(),
    priceEur: z.number().positive(),
    description: z.string().default(''),
  }),
});

const WORKER_ID = `${config.PROFILE}-${randomUUID().slice(0, 8)}`;

async function main(): Promise<void> {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const host = config.PROFILE === 'raw-http' ? null : new BrowserHost(config.PROFILE);

  const connection: ChannelModel = await amqplib.connect(config.RABBITMQ_URL);
  const channel: Channel = await connection.createChannel();

  await channel.assertExchange(TOPOLOGY.jobsExchange, 'direct', { durable: true });
  await channel.assertExchange(TOPOLOGY.resultsExchange, 'topic', { durable: true });
  await channel.assertQueue(TOPOLOGY.publishQueue, {
    durable: true,
    deadLetterExchange: TOPOLOGY.jobsExchange,
    deadLetterRoutingKey: 'publish.failed',
  });
  await channel.bindQueue(TOPOLOGY.publishQueue, TOPOLOGY.jobsExchange, TOPOLOGY.publishRoutingKey);

  // Prefetch bounds in-flight work to what this process can actually run. Each job
  // holds a browser context; without a limit, RabbitMQ would happily push a thousand
  // messages at one worker and the browser would take the host down with it.
  await channel.prefetch(config.CONCURRENCY);

  logger.info(
    { workerId: WORKER_ID, queue: TOPOLOGY.publishQueue, prefetch: config.CONCURRENCY },
    'worker consuming',
  );

  await channel.consume(TOPOLOGY.publishQueue, (message) => {
    if (message) void handle(channel, message, host, redis);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      // Cancel the consumer first so no new work arrives, then let in-flight jobs
      // finish before the channel closes under them.
      await channel.close();
      await connection.close();
    } catch (err) {
      logger.debug({ err }, 'error during broker shutdown');
    }
    await host?.close();
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function handle(
  channel: Channel,
  message: ConsumeMessage,
  host: BrowserHost | null,
  redis: Redis,
): Promise<void> {
  let jobId = 'unknown';
  try {
    const parsed = JobMessage.safeParse(JSON.parse(message.content.toString('utf8')));
    if (!parsed.success) {
      // A malformed message will never become well-formed. Requeueing it is an
      // infinite loop; dead-lettering it keeps the evidence without the loop.
      logger.error({ issues: parsed.error.issues }, 'malformed job message, dead-lettering');
      channel.nack(message, false, false);
      return;
    }

    const job = parsed.data;
    jobId = job.jobId;

    const publishJob: PublishJob = { listingId: job.listingId, ...job.payload };
    const result = await runPublishJob(publishJob, host, {
      profile: config.PROFILE,
      seed: config.BEHAVIOR_SEED,
      redis,
    });

    channel.publish(
      TOPOLOGY.resultsExchange,
      TOPOLOGY.resultRoutingKey,
      Buffer.from(JSON.stringify({ jobId: job.jobId, listingId: job.listingId, workerId: WORKER_ID, ...result })),
      { persistent: true, contentType: 'application/json' },
    );

    logger.info(
      { jobId: job.jobId, outcome: result.outcome.kind, durationMs: result.durationMs },
      'job complete',
    );

    // Ack even when blocked. "Sentinelle refused this" is a result the control plane
    // needs in order to change strategy — retrying it unchanged would just burn
    // another identity to learn the same thing.
    channel.ack(message);
  } catch (err) {
    logger.error({ err, jobId }, 'job failed, dead-lettering for control-plane retry');
    channel.nack(message, false, false);
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
