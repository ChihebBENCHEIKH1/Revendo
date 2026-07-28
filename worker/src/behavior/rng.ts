/**
 * Seeded randomness and the distributions the behaviour engine draws from.
 *
 * Two reasons this is not `Math.random()`:
 *
 *  1. **Testability.** Human-behaviour code is statistical, so the only meaningful
 *     assertions are statistical too — "the velocity profile has a coefficient of
 *     variation above 0.4", "keystroke intervals are right-skewed". Those tests are
 *     flaky against an unseedable generator and deterministic against this one.
 *
 *  2. **Distribution shape matters more than randomness.** Uniform jitter is not
 *     human. Human timing is right-skewed — a floor you cannot go below, a common
 *     case just above it, and a long tail where attention wandered. That is a
 *     log-normal, and using the wrong distribution is exactly the mistake
 *     `bhv.typing_uniform` is written to catch.
 */

/** mulberry32 — small, fast, statistically decent for simulation. Not cryptographic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  private readonly next: () => number;

  constructor(seed?: string) {
    this.next = mulberry32(
      seed === undefined ? (Math.random() * 2 ** 32) >>> 0 : hashSeed(seed),
    );
  }

  /** Uniform in [0, 1). */
  unit(): number {
    return this.next();
  }

  /** Uniform in [min, max). */
  between(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.between(min, maxInclusive + 1));
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() from empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Standard normal via Box–Muller. */
  gaussian(mean = 0, stddev = 1): number {
    // u must be non-zero; log(0) is -Infinity and would poison the whole path.
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Log-normal — the workhorse for human timing.
   *
   * Parameterised by the median (not the mean) because the median is the value you
   * can actually reason about: "half my keystrokes are faster than 110ms". `sigma`
   * controls skew; 0.3–0.5 matches observed human keying and dwell data well enough
   * for this purpose.
   */
  logNormal(median: number, sigma = 0.35): number {
    return median * Math.exp(this.gaussian(0, sigma));
  }

  /** Log-normal, clamped — timing that must stay inside physiological bounds. */
  timing(median: number, sigma: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, this.logNormal(median, sigma)));
  }
}
