import test from 'node:test';
import assert from 'node:assert/strict';
import { CHROME_HEADER_ORDER, orderHeaders } from './headerOrder.js';

/**
 * Header order is invisible in every tool a developer normally uses — devtools,
 * `curl -v` and every framework's `headers` object all present it as a map. That is
 * exactly why it needs a test: nothing else in the workflow would ever show it
 * breaking.
 */

/** Mirrors the LIS-based conformance check in target-site/src/sentinelle/transport.ts. */
function conformance(names: readonly string[]): number {
  const rank = new Map(CHROME_HEADER_ORDER.map((h, i) => [h, i]));
  const ranked = names.map((n) => rank.get(n.toLowerCase())).filter((r): r is number => r !== undefined);
  if (ranked.length === 0) return 1;

  const tails: number[] = [];
  for (const v of ranked) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((tails[mid] as number) <= v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
  }
  return tails.length / ranked.length;
}

const CHROME_LIKE = {
  host: 'vitrine.local',
  connection: 'keep-alive',
  'sec-ch-ua': '"Chromium";v="126"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'upgrade-insecure-requests': '1',
  'user-agent': 'Mozilla/5.0 ... Chrome/126.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'fr-FR,fr;q=0.9',
  cookie: 'vitrine_sid=abc',
};

test('reordering satisfies the detector where the original order does not', () => {
  // Alphabetical is what a naive HTTP client emits, and what a spoofer that builds
  // headers from a sorted map produces without noticing.
  const alphabetical = Object.fromEntries(
    Object.entries(CHROME_LIKE).sort(([a], [b]) => a.localeCompare(b)),
  );

  const before = conformance(Object.keys(alphabetical));
  const after = conformance(orderHeaders(alphabetical).map((h) => h.name));

  assert.ok(before < 0.8, `alphabetical order already conforms (${before.toFixed(2)}) — the fixture is wrong`);
  assert.equal(after, 1, `reordered headers should fully conform, got ${after.toFixed(2)}`);
});

test('ordering is idempotent', () => {
  const once = orderHeaders(CHROME_LIKE);
  const twice = orderHeaders(Object.fromEntries(once.map((h) => [h.name, h.value])));
  assert.deepEqual(once, twice);
});

test('unknown headers keep their relative order and go last', () => {
  const withExtras = {
    'x-forwarded-for': '78.1.2.3',
    'user-agent': 'Chrome',
    'x-custom-b': '2',
    host: 'vitrine.local',
    'x-custom-a': '1',
  };

  const ordered = orderHeaders(withExtras).map((h) => h.name);

  // Chrome's own headers first, in canonical order.
  assert.equal(ordered[0], 'host');
  assert.equal(ordered[1], 'user-agent');

  // Unknown ones after, in the order they were given — a shuffle between requests
  // would itself be a signal.
  const unknown = ordered.slice(2);
  assert.deepEqual(unknown, ['x-forwarded-for', 'x-custom-b', 'x-custom-a']);
});

test('no header is lost or duplicated', () => {
  const ordered = orderHeaders(CHROME_LIKE);
  assert.equal(ordered.length, Object.keys(CHROME_LIKE).length);
  for (const { name, value } of ordered) {
    assert.equal(value, (CHROME_LIKE as Record<string, string>)[name]);
  }
});

test('header casing does not affect ordering', () => {
  const mixedCase = { 'User-Agent': 'Chrome', HOST: 'vitrine.local', Accept: 'text/html' };
  const ordered = orderHeaders(mixedCase).map((h) => h.name);
  assert.deepEqual(ordered, ['HOST', 'User-Agent', 'Accept']);
});
