/**
 * Sentinelle — evidence combination and verdict.
 *
 * Signals are combined with a **noisy-OR**, not a sum:
 *
 *     score = 100 · (1 − Π(1 − wᵢ/100))
 *
 * Each signal is read as "probability this session is automated, given only this
 * evidence". Noisy-OR asks the complementary question — what is the chance *every*
 * signal is independently a false alarm — and takes one minus that.
 *
 * Why this and not a weighted sum:
 *
 *  - It saturates. Twelve weak signals cannot add up past 100 and manufacture
 *    certainty out of noise; a sum has to be clamped, which silently discards the
 *    difference between "suspicious" and "wildly suspicious".
 *  - It is monotone but sub-additive. Evidence still accumulates, but the tenth
 *    signal moves the score far less than the first — which matches reality, since
 *    correlated tells (empty plugins AND empty languages AND no media devices are
 *    all "this is headless") should not be triple-counted at full strength.
 *  - Weights stay interpretable in isolation. `fp.webdriver = 35` means "on its own,
 *    this is 35% of the way to certainty", and that reading survives adding new
 *    signals later. With a sum, every new signal silently reweights every old one.
 *
 * The independence assumption is wrong — these signals are correlated in exactly
 * the way described above — so this under-penalises correlated evidence. That is the
 * safe direction to be wrong in for a bot detector, where a false positive is a lost
 * customer and a false negative is one more scrape. See docs/ANTI-BOT.md.
 */

import { signalSpec, type SignalLayer } from './catalog.js';

export type Verdict = 'allow' | 'challenge' | 'block';

/** A signal raised against a specific session, with the observation that raised it. */
export interface Detection {
  readonly id: string;
  /** Human-readable proof, surfaced in the dashboard. Keep it short and concrete. */
  readonly evidence: string;
  readonly at: number;
}

/** A raised signal with its catalog metadata resolved, ready for the console. */
export interface EnrichedDetection extends Detection {
  readonly weight: number;
  readonly layer: SignalLayer;
  readonly description: string;
}

export interface Assessment {
  readonly score: number;
  readonly verdict: Verdict;
  readonly detections: readonly EnrichedDetection[];
  readonly byLayer: Record<SignalLayer, number>;
}

/**
 * Verdict bands.
 *
 * `challenge` exists so the system has a middle gear. A detector with only
 * allow/block has to pick a single threshold and eat either false positives or
 * false negatives; a challenge band lets ambiguous sessions prove themselves
 * cheaply, which is what every real vendor does (the DataDome interstitial, the
 * Cloudflare turnstile). It also gives the worker something interesting to handle:
 * a challenge is recoverable, a block requires a new identity.
 */
export const THRESHOLDS = Object.freeze({
  challenge: 30,
  block: 60,
});

export function verdictFor(score: number): Verdict {
  if (score >= THRESHOLDS.block) return 'block';
  if (score >= THRESHOLDS.challenge) return 'challenge';
  return 'allow';
}

/** Noisy-OR over the distinct signals raised. Duplicates of the same id count once. */
export function combine(detections: readonly Detection[]): Assessment {
  const distinct = new Map<string, Detection>();
  for (const d of detections) {
    // Keep the first observation of each signal: it is the one with the earliest
    // timestamp, which makes the dashboard timeline read in causal order.
    if (!distinct.has(d.id)) distinct.set(d.id, d);
  }

  const byLayer: Record<SignalLayer, number> = { transport: 0, fingerprint: 0, behavior: 0 };
  // Mutable while building, exposed as readonly on the way out — `Assessment` is a
  // value the caller must not be able to edit after the fact.
  const enriched: EnrichedDetection[] = [];

  let survivingInnocence = 1;
  for (const d of distinct.values()) {
    const spec = signalSpec(d.id);
    survivingInnocence *= 1 - spec.weight / 100;
    byLayer[spec.layer] += spec.weight;
    enriched.push({ ...d, weight: spec.weight, layer: spec.layer, description: spec.description });
  }

  const score = Math.round((1 - survivingInnocence) * 100);
  enriched.sort((a, b) => b.weight - a.weight || a.at - b.at);

  return { score, verdict: verdictFor(score), detections: enriched, byLayer };
}
