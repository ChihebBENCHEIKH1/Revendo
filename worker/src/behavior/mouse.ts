/**
 * Human pointer motion.
 *
 * Sentinelle's behavioural layer measures three things about a pointer path: how
 * straight it is (R² of a line fit), how uniform its speed is (coefficient of
 * variation), and whether it exists at all before a click. Each corresponds to a
 * property of real human reaching, and each is modelled here explicitly rather than
 * approximated with noise.
 *
 * ## The model
 *
 * **Duration — Fitts's law (Shannon formulation).**
 *
 *     MT = a + b · log₂(D / W + 1)
 *
 * Movement time grows with distance and shrinks with target size: a big button far
 * away is about as fast to hit as a small one nearby. A scraper that uses a fixed
 * duration, or one proportional to distance alone, has the wrong *shape* — and shape
 * is what a detector with a few hundred samples measures.
 *
 * **Trajectory — cubic Bézier.** Human reaching curves. The arm rotates about the
 * elbow and shoulder, so the hand traces an arc, and the curvature direction varies
 * with approach angle. Control points are offset perpendicular to the straight line
 * by a distance-proportional amount with a random sign.
 *
 * **Velocity — minimum-jerk.** Given the path, we still have to choose *when* along
 * it to be. Human reaching follows the minimum-jerk profile
 *
 *     s(t) = 10t³ − 15t⁴ + 6t⁵
 *
 * which produces the bell-shaped velocity curve found in the motor-control
 * literature: accelerate, peak near the midpoint, decelerate into the target. Walking
 * the Bézier at constant t instead is what makes `bhv.constant_velocity` fire.
 *
 * **Overshoot and correction.** Fast aimed movements frequently overshoot and need a
 * corrective submovement. Modelling it costs a few lines and produces exactly the
 * velocity discontinuity a real hand makes.
 *
 * **Tremor.** Sub-pixel physiological noise, so consecutive samples are never
 * perfectly collinear even on a short segment.
 *
 * Path generation is a pure function of `(from, to, targetWidth, rng)` so it can be
 * tested statistically without a browser — see mouse.test.ts, which asserts the
 * generated paths land outside the detector's thresholds.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { Rect, Session } from '../cdp/session.js';
import { Rng } from './rng.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Sample extends Point {
  /** Milliseconds since the start of the movement. */
  readonly t: number;
}

/** Fitts's law constants, in ms. Within the range commonly reported for mouse pointing. */
const FITTS_INTERCEPT = 90;
const FITTS_SLOPE = 135;

/** Pointer events are sampled at roughly 60Hz, like a real mouse on a 60Hz display. */
const SAMPLE_INTERVAL_MS = 16;

export function fittsDurationMs(distance: number, targetWidth: number, rng: Rng): number {
  // Guard the log: a zero-width target or zero distance would give -Infinity / 0.
  const w = Math.max(targetWidth, 8);
  const indexOfDifficulty = Math.log2(distance / w + 1);
  const nominal = FITTS_INTERCEPT + FITTS_SLOPE * indexOfDifficulty;
  // Between-trial variance is itself log-normal: most movements near nominal, a few
  // much slower because attention wandered.
  return rng.timing(nominal, 0.22, 60, 3000);
}

/** Minimum-jerk position profile. s(0)=0, s(1)=1, zero velocity and acceleration at both ends. */
export function minimumJerk(t: number): number {
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Control points offset perpendicular to the straight line.
 *
 * The offset scales with distance (a long reach curves more in absolute terms) and
 * the two control points get independent magnitudes, so the arc is asymmetric the way
 * a real one is.
 */
function controlPoints(from: Point, to: Point, rng: Rng): [Point, Point] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;

  // Unit normal to the direction of travel.
  const nx = -dy / distance;
  const ny = dx / distance;

  // Bow magnitude, as a fraction of the straight-line distance.
  //
  // These numbers are load-bearing, not decorative. Sentinelle flags a path whose
  // linear-fit R² exceeds 0.99, and the relationship is sharp: an arc whose sagitta
  // is under ~5% of the movement distance still fits a straight line above that
  // threshold. Values this size put the generated paths safely outside it while
  // staying inside the 5-15% curvature range reported for human reaching.
  // mouse.test.ts asserts the resulting R² against the detector's actual threshold,
  // so tightening these will fail the build rather than silently produce
  // detectable paths.
  const sign = rng.bool(0.5) ? 1 : -1;
  const bow1 = sign * distance * rng.between(0.12, 0.26);
  const bow2 = sign * distance * rng.between(0.08, 0.2);

  return [
    {
      x: from.x + dx * rng.between(0.2, 0.4) + nx * bow1,
      y: from.y + dy * rng.between(0.2, 0.4) + ny * bow1,
    },
    {
      x: from.x + dx * rng.between(0.6, 0.8) + nx * bow2,
      y: from.y + dy * rng.between(0.6, 0.8) + ny * bow2,
    },
  ];
}

/** One ballistic segment: curved path, minimum-jerk timing, physiological tremor. */
function segment(from: Point, to: Point, durationMs: number, rng: Rng, startT: number): Sample[] {
  const [c1, c2] = controlPoints(from, to, rng);
  const steps = Math.max(6, Math.round(durationMs / SAMPLE_INTERVAL_MS));
  const samples: Sample[] = [];

  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const eased = minimumJerk(u);
    const p = cubicBezier(from, c1, c2, to, eased);

    // Tremor: ~0.4px stddev. Enough to break perfect collinearity, small enough that
    // the path still lands where it was aimed.
    const tremor = i === steps ? 0 : 0.4;

    samples.push({
      x: p.x + rng.gaussian(0, tremor),
      y: p.y + rng.gaussian(0, tremor),
      // Sample timestamps jitter: a real event loop does not deliver on an exact grid.
      t: startT + u * durationMs + rng.gaussian(0, 1.5),
    });
  }
  return samples;
}

export interface PathOptions {
  /** Probability the movement overshoots and needs a correction. */
  readonly overshootProbability?: number;
}

/**
 * Full pointer path from `from` to a point inside a target of width `targetWidth`.
 *
 * Pure — no browser, no clock. Everything statistical about the behaviour engine is
 * testable through this function.
 */
export function generatePath(
  from: Point,
  to: Point,
  targetWidth: number,
  rng: Rng,
  options: PathOptions = {},
): Sample[] {
  const overshootProbability = options.overshootProbability ?? 0.35;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);

  if (distance < 2) return [{ x: to.x, y: to.y, t: 0 }];

  const totalDuration = fittsDurationMs(distance, targetWidth, rng);

  // Short movements are single submovements; only a reach long enough to build speed
  // overshoots.
  if (distance < 60 || !rng.bool(overshootProbability)) {
    return segment(from, to, totalDuration, rng, 0);
  }

  // Ballistic phase aims past the target, then a slower corrective phase homes in.
  const overshootFactor = rng.between(0.06, 0.18);
  const overshoot: Point = {
    x: to.x + (to.x - from.x) * overshootFactor,
    y: to.y + (to.y - from.y) * overshootFactor,
  };

  const ballisticDuration = totalDuration * rng.between(0.68, 0.82);
  const first = segment(from, overshoot, ballisticDuration, rng, 0);

  // The correction is short and slow — it covers little ground but takes real time,
  // which is what puts the second bump in the velocity profile.
  const correctionDuration = rng.timing(totalDuration - ballisticDuration, 0.3, 45, 600);
  const second = segment(overshoot, to, correctionDuration, rng, ballisticDuration);

  return [...first, ...second];
}

/**
 * Pick where inside an element a human would actually click.
 *
 * Not the centre. Aim points cluster near the middle with a spread that scales with
 * the target, and every session clicking the exact centroid of every button is a
 * pattern a detector can see across sessions even when each one looks fine alone.
 */
export function aimPointIn(rect: Rect, rng: Rng): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  // σ = ¼ of the half-extent keeps ~95% of aim points inside the element.
  const x = cx + rng.gaussian(0, rect.width / 8);
  const y = cy + rng.gaussian(0, rect.height / 8);
  const margin = 2;
  return {
    x: Math.min(rect.x + rect.width - margin, Math.max(rect.x + margin, x)),
    y: Math.min(rect.y + rect.height - margin, Math.max(rect.y + margin, y)),
  };
}

export class HumanMouse {
  /** Where the pointer currently is. Starts somewhere plausible, not at the origin. */
  private position: Point;

  constructor(
    private readonly session: Session,
    private readonly rng: Rng,
  ) {
    this.position = {
      x: rng.between(session.viewport.width * 0.2, session.viewport.width * 0.8),
      y: rng.between(session.viewport.height * 0.2, session.viewport.height * 0.6),
    };
  }

  get current(): Point {
    return this.position;
  }

  /** Walk a generated path, dispatching real mouseMoved events with real delays. */
  async moveTo(target: Point, targetWidth = 40): Promise<void> {
    const path = generatePath(this.position, target, targetWidth, this.rng);

    let previousT = 0;
    for (const sample of path) {
      const wait = Math.max(0, sample.t - previousT);
      previousT = sample.t;
      if (wait >= 1) await delay(wait);
      await this.session.dispatchMouse({
        type: 'mouseMoved',
        x: Math.round(sample.x),
        y: Math.round(sample.y),
        button: 'none',
        buttons: 0,
      });
    }
    this.position = { x: path[path.length - 1]!.x, y: path[path.length - 1]!.y };
  }

  async moveToElement(selector: string): Promise<Rect> {
    const rect = await this.session.waitForSelector(selector);
    const aim = aimPointIn(rect, this.rng);
    await this.moveTo(aim, rect.width);
    return rect;
  }

  /**
   * Move to an element and press it.
   *
   * The dwell between arriving and pressing is not decoration: a human decelerates
   * into a target, confirms it visually, and only then commits. Clicking on the same
   * millisecond the pointer arrives is a machine signature even when the path itself
   * is perfect.
   */
  async click(selector: string): Promise<void> {
    await this.moveToElement(selector);

    await delay(this.rng.timing(120, 0.4, 40, 600));

    const { x, y } = this.position;
    const px = Math.round(x);
    const py = Math.round(y);

    await this.session.dispatchMouse({
      type: 'mousePressed',
      x: px,
      y: py,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });

    // Press-to-release hold. Reported human means cluster around 80-100ms.
    await delay(this.rng.timing(85, 0.3, 35, 260));

    await this.session.dispatchMouse({
      type: 'mouseReleased',
      x: px,
      y: py,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
  }

  /**
   * Small aimless movements while ostensibly reading.
   *
   * A pointer that is perfectly still between actions and then travels in a straight
   * purposeful line to the next button is a state machine. Humans fidget, and the
   * fidgeting is what makes the *gaps* between actions look occupied.
   */
  async drift(durationMs: number): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const target: Point = {
        x: clamp(this.position.x + this.rng.gaussian(0, 45), 5, this.session.viewport.width - 5),
        y: clamp(this.position.y + this.rng.gaussian(0, 35), 5, this.session.viewport.height - 5),
      };
      await this.moveTo(target, 80);
      await delay(this.rng.timing(220, 0.6, 80, 800));
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
