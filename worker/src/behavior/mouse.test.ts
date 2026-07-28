/**
 * The behaviour engine is statistical, so its tests are statistical too.
 *
 * These do not assert "the mouse moved". They assert that generated paths land
 * **outside Sentinelle's actual detection thresholds** — the same numbers the
 * detector uses, restated here as constants. That is what makes this a real test
 * rather than a smoke test: if someone tunes the Bézier bow down or swaps
 * minimum-jerk for linear interpolation, these fail, and they fail with the reason.
 *
 * The statistics below are deliberately reimplemented rather than imported.
 * `target-site` and `worker` are separate packages that would be separate
 * deployments, so a shared import would be a false coupling — but the duplication
 * is the point: this file encodes *the worker's belief about what the detector
 * measures*, and if the detector's math changes, these tests should stop agreeing
 * with it. That disagreement is the signal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from './rng.js';
import { aimPointIn, fittsDurationMs, generatePath, minimumJerk, type Sample } from './mouse.js';

/** Sentinelle's thresholds, from target-site/src/sentinelle/behavior.ts. */
const DETECTOR = {
  linearPathR2: 0.99,
  constantVelocityCv: 0.2,
  teleportPx: 300,
} as const;

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function coefficientOfVariation(xs: readonly number[]): number {
  const m = mean(xs);
  return m === 0 ? 0 : stddev(xs) / m;
}

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
  if (sxx === 0 || syy === 0) return 1;
  return (sxy * sxy) / (sxx * syy);
}

function speeds(points: readonly Sample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Sample;
    const b = points[i] as Sample;
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    out.push(Math.hypot(b.x - a.x, b.y - a.y) / dt);
  }
  return out;
}

function maxJump(points: readonly Sample[]): number {
  let worst = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Sample;
    const b = points[i] as Sample;
    worst = Math.max(worst, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return worst;
}

/**
 * A spread of realistic UI movements: short hops between adjacent fields, long
 * traversals across a 1440x900 viewport, and every angle in between. Angle matters
 * — a path at 45° is the hardest case for the R² check, because a bow contributes
 * to both axes and the fit stays tighter than it does on an axis-aligned move.
 */
function* movements(): Generator<{ from: { x: number; y: number }; to: { x: number; y: number }; width: number; seed: string }> {
  const distances = [80, 150, 300, 500, 750, 1000];
  const angles = [0, 22.5, 45, 67.5, 90, 135, 180, 225, 270, 315];
  for (const d of distances) {
    for (const deg of angles) {
      const rad = (deg * Math.PI) / 180;
      yield {
        from: { x: 700, y: 450 },
        to: { x: 700 + d * Math.cos(rad), y: 450 + d * Math.sin(rad) },
        width: 120,
        seed: `path-${d}-${deg}`,
      };
    }
  }
}

test('generated paths are never straight enough to trip bhv.linear_path', () => {
  let worst = 0;
  let worstCase = '';

  for (const m of movements()) {
    const path = generatePath(m.from, m.to, m.width, new Rng(m.seed));
    // The detector only scores paths with enough samples to fit; short hops that
    // fall below that are not evaluated, so they are not a failure here.
    if (path.length < 12) continue;

    const r2 = pathLinearity(path);
    if (r2 > worst) {
      worst = r2;
      worstCase = m.seed;
    }
  }

  assert.ok(
    worst < DETECTOR.linearPathR2,
    `worst-case path R²=${worst.toFixed(5)} (${worstCase}) exceeds the detector's ${DETECTOR.linearPathR2} threshold — ` +
      'the Bézier bow in controlPoints() is too shallow',
  );
});

test('velocity varies far more than bhv.constant_velocity tolerates', () => {
  let worst = Number.POSITIVE_INFINITY;
  let worstCase = '';

  for (const m of movements()) {
    const path = generatePath(m.from, m.to, m.width, new Rng(m.seed));
    const v = speeds(path);
    if (v.length < 8) continue;

    const cv = coefficientOfVariation(v);
    if (cv < worst) {
      worst = cv;
      worstCase = m.seed;
    }
  }

  assert.ok(
    worst > DETECTOR.constantVelocityCv,
    `lowest speed CV=${worst.toFixed(3)} (${worstCase}) is under the detector's ${DETECTOR.constantVelocityCv} floor — ` +
      'the minimum-jerk profile is not being applied',
  );
});

test('no single sample ever teleports', () => {
  for (const m of movements()) {
    const path = generatePath(m.from, m.to, m.width, new Rng(m.seed));
    const jump = maxJump(path);
    assert.ok(
      jump <= DETECTOR.teleportPx,
      `${m.seed} moved ${Math.round(jump)}px in one sample, over the ${DETECTOR.teleportPx}px threshold`,
    );
  }
});

test('paths land inside the target', () => {
  for (const m of movements()) {
    const path = generatePath(m.from, m.to, m.width, new Rng(m.seed));
    const last = path[path.length - 1]!;
    const error = Math.hypot(last.x - m.to.x, last.y - m.to.y);
    // Sub-pixel: the final sample has tremor suppressed precisely so the pointer
    // arrives where it was aimed.
    assert.ok(error < 1, `${m.seed} ended ${error.toFixed(2)}px from its target`);
  }
});

test("movement time follows Fitts's law", () => {
  const rng = new Rng('fitts');

  // Same distance, bigger target → faster. This is the whole content of the law,
  // and a scraper using a fixed or distance-only duration gets it wrong.
  const narrow = mean(Array.from({ length: 400 }, () => fittsDurationMs(500, 20, rng)));
  const wide = mean(Array.from({ length: 400 }, () => fittsDurationMs(500, 200, rng)));
  assert.ok(wide < narrow, `a wide target (${wide.toFixed(0)}ms) should be faster than a narrow one (${narrow.toFixed(0)}ms)`);

  // Same target, further away → slower, but sub-linearly (log₂, not proportional).
  const near = mean(Array.from({ length: 400 }, () => fittsDurationMs(100, 60, rng)));
  const far = mean(Array.from({ length: 400 }, () => fittsDurationMs(1600, 60, rng)));
  assert.ok(far > near, 'a longer reach should take longer');
  assert.ok(
    far < near * 16,
    `16x the distance took ${(far / near).toFixed(1)}x the time — that is linear, not logarithmic`,
  );
});

test('minimum-jerk profile has the right shape', () => {
  assert.equal(minimumJerk(0), 0);
  assert.equal(minimumJerk(1), 1);
  assert.ok(Math.abs(minimumJerk(0.5) - 0.5) < 1e-9, 'should be symmetric about the midpoint');

  // Monotone: the pointer never reverses along its own path.
  let previous = -1;
  for (let i = 0; i <= 100; i++) {
    const s = minimumJerk(i / 100);
    assert.ok(s >= previous, 'minimum-jerk must be monotonically increasing');
    previous = s;
  }

  // Velocity is bell-shaped — near zero at both ends, peaked in the middle.
  const dt = 0.001;
  const vStart = (minimumJerk(dt) - minimumJerk(0)) / dt;
  const vMid = (minimumJerk(0.5 + dt) - minimumJerk(0.5)) / dt;
  const vEnd = (minimumJerk(1) - minimumJerk(1 - dt)) / dt;
  assert.ok(vMid > vStart * 50, 'velocity should peak in the middle, not start there');
  assert.ok(vMid > vEnd * 50, 'velocity should decay into the target');
});

test('aim points cluster near the centre but are not the centre', () => {
  const rng = new Rng('aim');
  const rect = { x: 100, y: 200, width: 160, height: 40 };
  const points = Array.from({ length: 500 }, () => aimPointIn(rect, rng));

  // Never outside the element — a click that misses is not stealth, it is a bug.
  for (const p of points) {
    assert.ok(p.x >= rect.x && p.x <= rect.x + rect.width, 'aim point escaped horizontally');
    assert.ok(p.y >= rect.y && p.y <= rect.y + rect.height, 'aim point escaped vertically');
  }

  // Centred on average...
  const cx = rect.x + rect.width / 2;
  assert.ok(Math.abs(mean(points.map((p) => p.x)) - cx) < 4, 'aim should be centred on average');

  // ...but essentially never *at* the centre. Every session clicking the exact
  // centroid of every button is a cross-session pattern even when each click looks
  // fine in isolation.
  const dead = points.filter((p) => Math.abs(p.x - cx) < 0.5).length;
  assert.ok(dead < points.length * 0.05, `${dead}/500 clicks landed dead-centre — the spread is too tight`);
});

test('the same seed reproduces the same path', () => {
  // Reproducibility is what makes every assertion above meaningful rather than
  // flaky, and it is why the engine takes an Rng instead of calling Math.random().
  const a = generatePath({ x: 0, y: 0 }, { x: 400, y: 300 }, 100, new Rng('fixed'));
  const b = generatePath({ x: 0, y: 0 }, { x: 400, y: 300 }, 100, new Rng('fixed'));
  assert.deepEqual(a, b);

  const c = generatePath({ x: 0, y: 0 }, { x: 400, y: 300 }, 100, new Rng('different'));
  assert.notDeepEqual(a, c, 'different seeds must produce different paths');
});
