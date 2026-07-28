/**
 * Sentinelle — layer 3, behavioural analysis.
 *
 * Fingerprints are a static puzzle: solve them once and the answer keeps working
 * until the vendor ships a new probe. Behaviour is a *continuous* signal — the
 * session has to keep looking human for as long as it lasts, and there is no
 * one-time patch for it. This is the layer that separates scrapers that work for a
 * week from scrapers that work for a year, and it is the reason human behaviour is
 * a first-class subsystem in the worker rather than a `sleep()` call.
 *
 * Everything here is descriptive statistics over an event stream. No ML, on purpose:
 * a handful of well-chosen moments (variance, curvature, velocity profile) is
 * interpretable, debuggable and adversarially honest, whereas a model would let the
 * demo hide its reasoning behind a number nobody can argue with.
 */

import { z } from 'zod';
import type { Detection } from './scoring.js';

export const BehaviorPayload = z.object({
  /** Pointer samples, in event order. */
  mouse: z.array(z.object({ x: z.number(), y: z.number(), t: z.number() })),
  clicks: z.array(z.object({ x: z.number(), y: z.number(), t: z.number() })),
  /** Timestamps of keydown events, in order. */
  keys: z.array(z.number()),
  scrolls: z.array(z.object({ dy: z.number(), t: z.number() })),
  /** ms between DOMContentLoaded and the first user-ish event. */
  firstInteractionDelayMs: z.number().nullable(),
  /** focus / blur / visibilitychange / resize count. */
  ambientEvents: z.number(),
});

export type BehaviorPayload = z.infer<typeof BehaviorPayload>;

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Coefficient of variation — stddev/mean.
 *
 * Scale-free, which is what we need: it must not matter whether a typist averages
 * 90ms or 190ms between keys, only whether the spread around that average looks
 * like a nervous system or a timer.
 */
function coefficientOfVariation(xs: readonly number[]): number {
  const m = mean(xs);
  return m === 0 ? 0 : stddev(xs) / m;
}

/**
 * R² of a least-squares line fit through the pointer path.
 *
 * A human reaching for a target traces a curve — Fitts's law describes it as a fast
 * ballistic launch, an overshoot, and one or more homing corrections. Linear
 * interpolation between two coordinates fits a straight line essentially perfectly,
 * so R² ≈ 1.0 is the tell. Note this is fit against the *path shape*, not against
 * time, so it catches straightness independently of pacing.
 */
function pathLinearity(points: readonly { x: number; y: number }[]): number {
  if (points.length < 8) return 0;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const mx = mean(xs);
  const my = mean(ys);

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < points.length; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  // A perfectly vertical or horizontal drag is degenerate for a y-on-x fit but is
  // still perfectly straight, so treat zero variance on either axis as linear.
  if (sxx === 0 || syy === 0) return 1;
  return (sxy * sxy) / (sxx * syy);
}

/** Per-segment speeds in px/ms. */
function speeds(points: readonly { x: number; y: number; t: number }[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as { x: number; y: number; t: number };
    const b = points[i] as { x: number; y: number; t: number };
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    out.push(Math.hypot(b.x - a.x, b.y - a.y) / dt);
  }
  return out;
}

/** Largest single-sample displacement, in px. */
function maxJump(points: readonly { x: number; y: number }[]): number {
  let worst = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as { x: number; y: number };
    const b = points[i] as { x: number; y: number };
    worst = Math.max(worst, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return worst;
}

/** Successive differences — used to turn absolute timestamps into intervals. */
function diffs(xs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push((xs[i] as number) - (xs[i - 1] as number));
  return out.filter((d) => d >= 0);
}

export function inspectBehavior(b: BehaviorPayload): Detection[] {
  const at = Date.now();
  const out: Detection[] = [];
  const raise = (id: string, evidence: string) => out.push({ id, evidence, at });

  // A click that no pointer ever travelled to. The single loudest behavioural signal,
  // and the default outcome of every `element.click()` in every automation library.
  if (b.clicks.length > 0 && b.mouse.length === 0) {
    raise('bhv.click_without_movement', `${b.clicks.length} click(s), 0 mousemove events`);
  }

  // Guard every statistic on a minimum sample size. Scoring a 3-point path would be
  // reading tea leaves, and a bot detector that guesses is a bot detector that bans
  // customers.
  if (b.mouse.length >= 12) {
    const r2 = pathLinearity(b.mouse);
    if (r2 > 0.99) {
      raise('bhv.linear_path', `path R²=${r2.toFixed(4)} over ${b.mouse.length} samples`);
    }

    const v = speeds(b.mouse);
    if (v.length >= 8) {
      const cv = coefficientOfVariation(v);
      if (cv < 0.2) {
        raise('bhv.constant_velocity', `speed CV=${cv.toFixed(3)} (human ≈ 0.5–1.2)`);
      }
    }

    const jump = maxJump(b.mouse);
    if (jump > 300) {
      raise('bhv.teleport', `${Math.round(jump)}px between consecutive samples`);
    }
  } else if (b.clicks.length > 0 && b.mouse.length > 0 && b.mouse.length < 4) {
    // Too few to fit, but "two mousemoves then a click" is its own kind of obvious.
    raise('bhv.teleport', `only ${b.mouse.length} pointer sample(s) before a click`);
  }

  const intervals = diffs(b.keys);
  if (intervals.length >= 6) {
    const cv = coefficientOfVariation(intervals);
    if (cv < 0.15) {
      raise('bhv.typing_uniform', `keystroke interval CV=${cv.toFixed(3)} over ${intervals.length} keys`);
    }
    const m = mean(intervals);
    if (m < 25) {
      raise('bhv.typing_superhuman', `mean interval ${m.toFixed(1)}ms ≈ ${Math.round(12000 / m)} WPM`);
    }
  }

  if (b.firstInteractionDelayMs !== null && b.firstInteractionDelayMs < 150) {
    raise('bhv.instant_interaction', `first interaction ${b.firstInteractionDelayMs}ms after load`);
  }

  const scrollDeltas = b.scrolls.map((s) => s.dy);
  if (scrollDeltas.length >= 5 && coefficientOfVariation(scrollDeltas) < 0.05) {
    raise('bhv.scroll_uniform', `${scrollDeltas.length} scroll deltas with no variation`);
  }

  // Deliberately cheap. A genuinely focused human generates no ambient events either,
  // so this is only ever a tiebreaker — included to make the point that not every
  // signal deserves a heavy weight, and that stacking weak ones is how you ban
  // real customers.
  if (b.ambientEvents === 0 && b.mouse.length > 0) {
    raise('bhv.no_ambient_events', 'no focus/blur/visibility/resize events all session');
  }

  return out;
}
