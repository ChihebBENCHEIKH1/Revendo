import test from 'node:test';
import assert from 'node:assert/strict';
import { combine, verdictFor, THRESHOLDS, type Detection } from './scoring.js';
import { SIGNAL_CATALOG, signalSpec } from './catalog.js';
import { inspectBehavior } from './behavior.js';

const detection = (id: string): Detection => ({ id, evidence: 'test', at: 1 });

test('noisy-OR saturates instead of overflowing', () => {
  // A weighted sum of every signal in the catalog would be several hundred and would
  // have to be clamped, throwing away the difference between "suspicious" and
  // "certain". Noisy-OR approaches 100 without ever exceeding it.
  const everything = SIGNAL_CATALOG.map((s) => detection(s.id));
  const assessment = combine(everything);

  assert.ok(assessment.score <= 100, `score ${assessment.score} exceeded 100`);
  assert.ok(assessment.score > 95, 'every signal at once should be near-certain');
});

test('a single signal scores exactly its own weight', () => {
  // The interpretability property: a weight of 35 means "on its own, 35% of the way
  // to certainty", and that reading survives adding new signals to the catalog later.
  for (const spec of SIGNAL_CATALOG) {
    const { score } = combine([detection(spec.id)]);
    assert.equal(score, spec.weight, `${spec.id} scored ${score}, expected its weight ${spec.weight}`);
  }
});

test('evidence accumulates but with diminishing returns', () => {
  const one = combine([detection('fp.webdriver')]).score;
  const two = combine([detection('fp.webdriver'), detection('fp.plugins_empty')]).score;
  const three = combine([
    detection('fp.webdriver'),
    detection('fp.plugins_empty'),
    detection('fp.languages_empty'),
  ]).score;

  assert.ok(two > one && three > two, 'more evidence must raise the score');

  // Sub-additive: the third signal moves it less than the second did. This is what
  // stops correlated tells — empty plugins AND empty languages AND no media devices
  // are all "this is headless" — from being triple-counted at full strength.
  assert.ok(three - two < two - one, 'later signals should contribute less than earlier ones');
});

test('duplicate detections count once', () => {
  const once = combine([detection('fp.webdriver')]);
  const thrice = combine([detection('fp.webdriver'), detection('fp.webdriver'), detection('fp.webdriver')]);
  assert.equal(once.score, thrice.score);
  assert.equal(thrice.detections.length, 1);
});

test('an empty session scores zero and is allowed', () => {
  const assessment = combine([]);
  assert.equal(assessment.score, 0);
  assert.equal(assessment.verdict, 'allow');
});

test('verdict bands are contiguous with no gap', () => {
  assert.equal(verdictFor(THRESHOLDS.challenge - 1), 'allow');
  assert.equal(verdictFor(THRESHOLDS.challenge), 'challenge');
  assert.equal(verdictFor(THRESHOLDS.block - 1), 'challenge');
  assert.equal(verdictFor(THRESHOLDS.block), 'block');
  assert.equal(verdictFor(100), 'block');
});

test('a naive automated session is blocked', () => {
  // The signals an unpatched headless Chrome actually raises. If this stops reaching
  // the block band, the detector has been weakened.
  const naive = [
    'fp.webdriver',
    'fp.plugins_empty',
    'fp.languages_empty',
    'fp.permissions_anomaly',
    'fp.webgl_software_renderer',
    'fp.screen_impossible',
    'fp.media_devices_empty',
    'bhv.click_without_movement',
    'bhv.typing_superhuman',
    'bhv.instant_interaction',
  ].map(detection);

  const assessment = combine(naive);
  assert.equal(assessment.verdict, 'block', `naive session scored only ${assessment.score}`);
});

test('a single weak signal never blocks a real customer', () => {
  // False positives cost a sale. No individual low-weight signal may push a session
  // past the challenge threshold on its own.
  for (const spec of SIGNAL_CATALOG.filter((s) => s.weight < THRESHOLDS.challenge)) {
    const { verdict } = combine([detection(spec.id)]);
    assert.equal(verdict, 'allow', `${spec.id} alone produced a ${verdict}`);
  }
});

test('detections are reported strongest first', () => {
  const assessment = combine([
    detection('fp.hardware_implausible'), // 6
    detection('fp.webdriver'), // 35
    detection('fp.plugins_empty'), // 12
  ]);
  const weights = assessment.detections.map((d) => d.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
});

test('an unknown signal id fails loudly rather than scoring zero', () => {
  // A detector and its catalog drifting apart must be a crash in development, not a
  // silent zero in production.
  assert.throws(() => signalSpec('fp.does_not_exist'), /unknown signal/);
});

test('behavioural analysis ignores samples too small to mean anything', () => {
  // Scoring a three-point path would be reading tea leaves, and a bot detector that
  // guesses is a bot detector that bans customers.
  const sparse = inspectBehavior({
    mouse: [
      { x: 1, y: 1, t: 0 },
      { x: 2, y: 2, t: 16 },
    ],
    clicks: [],
    keys: [1000, 1100],
    scrolls: [],
    firstInteractionDelayMs: 900,
    ambientEvents: 1,
  });

  assert.deepEqual(
    sparse.filter((d) => d.id === 'bhv.linear_path' || d.id === 'bhv.constant_velocity'),
    [],
    'path statistics must not be computed on a two-point sample',
  );
});

test('a click with no pointer history is caught', () => {
  const detections = inspectBehavior({
    mouse: [],
    clicks: [{ x: 10, y: 10, t: 500 }],
    keys: [],
    scrolls: [],
    firstInteractionDelayMs: 500,
    ambientEvents: 0,
  });

  assert.ok(
    detections.some((d) => d.id === 'bhv.click_without_movement'),
    'element.click() with no mousemove must be detected',
  );
});

test('a perfectly straight, constant-velocity path is caught', () => {
  // Linear interpolation between two points — what every naive "move the mouse"
  // implementation produces.
  const mouse = Array.from({ length: 40 }, (_, i) => ({ x: 100 + i * 10, y: 100 + i * 5, t: i * 16 }));

  const detections = inspectBehavior({
    mouse,
    clicks: [{ x: 490, y: 295, t: 700 }],
    keys: [],
    scrolls: [],
    firstInteractionDelayMs: 800,
    ambientEvents: 1,
  });

  const ids = detections.map((d) => d.id);
  assert.ok(ids.includes('bhv.linear_path'), 'a straight path must be detected');
  assert.ok(ids.includes('bhv.constant_velocity'), 'constant velocity must be detected');
});

test('uniformly-timed keystrokes are caught', () => {
  // sleep(100) between keys: passes the mean check, fails the variation check.
  const keys = Array.from({ length: 20 }, (_, i) => 1000 + i * 100);

  const detections = inspectBehavior({
    mouse: [],
    clicks: [],
    keys,
    scrolls: [],
    firstInteractionDelayMs: 900,
    ambientEvents: 1,
  });

  assert.ok(
    detections.some((d) => d.id === 'bhv.typing_uniform'),
    'fixed-delay typing must be detected even though its mean is human',
  );
  assert.ok(
    !detections.some((d) => d.id === 'bhv.typing_superhuman'),
    'a 100ms mean is not superhuman — only the variation check should fire',
  );
});
