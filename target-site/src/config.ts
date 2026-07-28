/**
 * Configuration, parsed and validated once at boot.
 *
 * Every knob is an env var with a working default, so `docker compose up` needs no
 * .env file to produce a correct demo. Validation happens here rather than at each
 * use site: a container that is going to be misconfigured should die immediately and
 * say why, not surface it as a confusing runtime error twenty minutes in.
 */

import { z } from 'zod';

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  REDIS_URL: z.string().default('redis://redis:6379'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Token bucket sizing. Deliberately generous enough that a human browsing the demo
   * never trips it, and tight enough that a worker hammering from one IP does.
   */
  RATE_CAPACITY: z.coerce.number().int().positive().default(30),
  RATE_REFILL_PER_SECOND: z.coerce.number().positive().default(0.5),

  /** Region we expect the browser clock to agree with, for the timezone coherence check. */
  EXPECTED_TZ_REGION: z.string().default('Europe'),

  /**
   * When true, Sentinelle scores and reports but never actually blocks.
   *
   * Every real deployment starts here. You run in monitor mode against live traffic
   * for weeks, look at what *would* have been blocked, and only then turn on
   * enforcement — because the cost of a false positive is a customer who cannot buy.
   */
  MONITOR_ONLY: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

export type Config = z.infer<typeof Schema>;

export const config: Config = (() => {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid configuration:\n' + JSON.stringify(parsed.error.format(), null, 2));
    process.exit(1);
  }
  return parsed.data;
})();
