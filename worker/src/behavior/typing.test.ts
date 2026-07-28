/**
 * Typing statistics, asserted against the detector's actual thresholds.
 *
 * The interesting failure this guards against is the *plausible* one: replacing the
 * log-normal draw with `sleep(random(80, 120))`. That passes a "does it type?" test,
 * passes the mean-interval check, and fails `bhv.typing_uniform` — uniform noise
 * over that range has a coefficient of variation around 0.12, under the detector's
 * 0.15 floor. The test below would catch it; a smoke test would not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from './rng.js';
import { DEFAULT_TYPING, intervalFor } from './typing.js';

/** Sentinelle's thresholds, from target-site/src/sentinelle/behavior.ts. */
const DETECTOR = {
  typingUniformCv: 0.15,
  typingSuperhumanMeanMs: 25,
} as const;

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function intervalsFor(text: string, seed: string): number[] {
  const rng = new Rng(seed);
  const out: number[] = [];
  let previous: string | null = null;
  for (const ch of text) {
    out.push(intervalFor(ch, previous, rng, DEFAULT_TYPING));
    previous = ch;
  }
  return out;
}

const SAMPLES = [
  'Blouson aviateur B-3 doublé mouton',
  'seller@vitrine.test',
  "Porté deux hivers, cuir nourri chaque année. Doublure intacte, fermeture d'origine.",
  '189.00',
  'Avirex',
];

test('keystroke intervals vary far more than bhv.typing_uniform tolerates', () => {
  for (const text of SAMPLES) {
    const intervals = intervalsFor(text, `type-${text.length}`);
    if (intervals.length < 6) continue;

    const cv = stddev(intervals) / mean(intervals);
    assert.ok(
      cv > DETECTOR.typingUniformCv,
      `CV=${cv.toFixed(3)} for ${JSON.stringify(text.slice(0, 24))} is under the detector's ` +
        `${DETECTOR.typingUniformCv} floor — the distribution is too flat`,
    );
  }
});

test('typing is never superhuman', () => {
  for (const text of SAMPLES) {
    const intervals = intervalsFor(text, `speed-${text.length}`);
    const m = mean(intervals);
    assert.ok(
      m > DETECTOR.typingSuperhumanMeanMs,
      `mean interval ${m.toFixed(1)}ms is at or under the ${DETECTOR.typingSuperhumanMeanMs}ms human floor`,
    );
    // Nothing should get through the clamp either.
    assert.ok(Math.min(...intervals) >= 28, 'an individual interval escaped the lower clamp');
    assert.ok(Math.max(...intervals) <= 1400, 'an individual interval escaped the upper clamp');
  }
});

test('the interval distribution is right-skewed, not symmetric', () => {
  // Human timing has a hard floor and a long tail — a few keys are much slower than
  // typical because attention wandered. Symmetric (Gaussian or uniform) jitter has
  // no tail, and the median sitting below the mean is the cheapest way to see it.
  const rng = new Rng('skew');
  const samples = Array.from({ length: 5000 }, () => intervalFor('e', 'r', rng, DEFAULT_TYPING));

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const average = mean(samples);

  assert.ok(average > median, `mean ${average.toFixed(1)} should exceed median ${median.toFixed(1)} for a right-skewed draw`);
  assert.ok(sorted[sorted.length - 1]! > median * 2, 'expected a long upper tail');
});

test('digraph effects move the distribution in the right directions', () => {
  const trials = 4000;
  const avg = (ch: string, prev: string | null, seed: string) => {
    const rng = new Rng(seed);
    return mean(Array.from({ length: trials }, () => intervalFor(ch, prev, rng, DEFAULT_TYPING)));
  };

  // Alternating hands overlaps two movements: the next finger is already travelling
  // while the current key is still going down.
  const alternating = avg('u', 'd', 'alt'); // d = left hand, u = right hand
  const sameHand = avg('f', 'd', 'same'); // both left
  assert.ok(alternating < sameHand, `alternating hands (${alternating.toFixed(0)}ms) should beat same-hand (${sameHand.toFixed(0)}ms)`);

  // Same finger, same key — the slowest digraph there is.
  const doubled = avg('l', 'l', 'double');
  assert.ok(doubled > sameHand, `a repeated key (${doubled.toFixed(0)}ms) should be the slowest`);

  // Shift costs a beat.
  const capital = avg('A', 'a', 'shift');
  const lower = avg('a', 'a', 'noshift');
  assert.ok(capital > lower, `reaching for shift (${capital.toFixed(0)}ms) should cost time vs ${lower.toFixed(0)}ms`);

  // Retrieving the next word after a space takes longer than continuing one.
  const afterSpace = avg('m', ' ', 'space');
  const midWord = avg('m', 'o', 'midword');
  assert.ok(afterSpace > midWord, 'the first key of a word should be slower than a mid-word key');
});

test('the same seed reproduces the same intervals', () => {
  assert.deepEqual(intervalsFor('bonjour', 'fixed'), intervalsFor('bonjour', 'fixed'));
  assert.notDeepEqual(intervalsFor('bonjour', 'fixed'), intervalsFor('bonjour', 'other'));
});
