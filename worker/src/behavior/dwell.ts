/**
 * Pacing.
 *
 * `bhv.instant_interaction` catches a first interaction under 150ms — below human
 * visual reaction time, so nobody has actually looked at the page yet. But pacing
 * matters well beyond that one signal: it is also what keeps a session under the
 * per-IP token bucket, and it is the difference between a worker that reads like a
 * shopper and one that reads like a load test.
 *
 * The unglamorous truth of this whole subsystem is that **the most effective
 * anti-anti-bot measure is being slower**. Every evasion technique in this codebase
 * is cheaper to detect than patience is to fake.
 *
 * Which is why the pace is a dial rather than a constant. `BEHAVIOR_PACE` scales
 * every interval here: the default of `1.0` is tuned so the demo finishes in about a
 * minute, and a real deployment would run at `3`–`5` and take the time. Making that
 * an explicit knob is more honest than hardcoding demo-speed numbers and calling
 * them human — the demo *is* faster than a real person, and the dial is where you
 * buy that back.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { Rng } from './rng.js';

/** Adult silent reading, words per minute. 200-250 is the usual range for screens. */
const READING_WPM = 225;

export class Pacing {
  constructor(
    private readonly rng: Rng,
    /** Multiplier on every interval. 1 = demo pace, 3-5 = production patience. */
    private readonly scale: number = 1,
  ) {}

  private async wait(median: number, sigma: number, min: number, max: number): Promise<void> {
    await delay(this.rng.timing(median * this.scale, sigma, min * this.scale, max * this.scale));
  }

  /**
   * Time to take in a page before doing anything.
   *
   * Not proportional to the whole document — people skim. This models "long enough
   * to find what I came for", with a floor that keeps us clear of the reaction-time
   * threshold.
   */
  async readPage(visibleWordCount: number): Promise<void> {
    const skimFraction = this.rng.between(0.1, 0.25);
    const words = Math.max(10, visibleWordCount * skimFraction);
    const nominalMs = (words / READING_WPM) * 60_000;
    await this.wait(Math.max(600, nominalMs), 0.4, 400, 3_500);
  }

  /** Beat between two related actions — clicking a field then starting to type. */
  async betweenActions(): Promise<void> {
    await this.wait(320, 0.5, 120, 1_200);
  }

  /** Beat between two unrelated steps — finishing a form, deciding to submit. */
  async betweenSteps(): Promise<void> {
    await this.wait(900, 0.55, 350, 3_000);
  }

  /**
   * Occasional long pause: a notification, a coffee, another tab.
   *
   * Rare by design — every session containing a 40-second gap is as much a pattern
   * as no session containing one. Off at demo pace, which is exactly the kind of
   * realism a one-minute demo cannot afford and a production run should keep.
   */
  async maybeDistraction(): Promise<boolean> {
    if (this.scale < 2 || !this.rng.bool(0.15)) return false;
    await this.wait(9_000, 0.6, 3_000, 40_000);
    return true;
  }
}
