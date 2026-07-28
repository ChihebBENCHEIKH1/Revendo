import { z } from 'zod';

/**
 * Worker configuration.
 *
 * `PROFILE` is the demo's central dial. It is a first-class config value rather than
 * a flag buried in code because the entire point of the exercise is to run the same
 * automation twice — once naked, once dressed — against the same detector and read
 * the difference.
 */
const Schema = z.object({
  TARGET_BASE_URL: z.string().default('http://target-site:8080'),
  RABBITMQ_URL: z.string().default('amqp://guest:guest@rabbitmq:5672'),
  REDIS_URL: z.string().default('redis://redis:6379'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  /**
   * naive     — a browser with no countermeasures at all. The baseline.
   * stealth   — every fingerprint patch and the full behavioural engine.
   * raw-http  — no browser: plain HTTP requests. Shows what the transport layer alone catches.
   */
  PROFILE: z.enum(['naive', 'stealth', 'raw-http']).default('stealth'),

  CHROME_PATH: z.string().default('/usr/bin/chromium'),
  CHROME_PORT: z.coerce.number().int().positive().default(9222),
  HEADLESS: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

  /** Jobs consumed concurrently. One browser context per job, so this is also a memory dial. */
  CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),

  /**
   * Seed for the behaviour RNG.
   *
   * Set it and a run is byte-for-byte reproducible, which is what makes the
   * behavioural code testable at all. Leave it empty and each worker draws its own
   * entropy — a fleet that shares a seed produces identical mouse paths, which is a
   * fingerprint in its own right.
   */
  BEHAVIOR_SEED: z.string().optional(),

  /**
   * Multiplier on every dwell, pause and reading delay.
   *
   * 1.0 finishes the demo in about a minute. A real deployment runs at 3-5 and takes
   * the time, because patience is the countermeasure nothing else substitutes for.
   */
  BEHAVIOR_PACE: z.coerce.number().positive().max(20).default(1),

  DEMO_EMAIL: z.string().default('seller@vitrine.test'),
  DEMO_PASSWORD: z.string().default('hunter2'),
});

export type Config = z.infer<typeof Schema>;
export type Profile = Config['PROFILE'];

export const config: Config = (() => {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid worker configuration:\n' + JSON.stringify(parsed.error.format(), null, 2));
    process.exit(1);
  }
  return parsed.data;
})();
