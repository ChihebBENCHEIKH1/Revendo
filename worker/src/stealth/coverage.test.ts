/**
 * The claim this project makes is "every signal Sentinelle raises has a
 * counter-measure". This test is what stops that claim from quietly becoming false.
 *
 * `EXPECTED_SIGNALS` mirrors `target-site/src/sentinelle/catalog.ts`. When the
 * detector grows a signal, this list must grow with it — and a signal added here
 * with no answer in `PATCHES` fails the build. The two halves of the project cannot
 * drift apart silently.
 *
 * A live version of the same check runs against `/__sentinelle/catalog` in
 * `make verify`, which catches the case where someone edits the catalog and forgets
 * this file too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PATCHES, coveredSignals } from './patches.js';
import { buildBootstrap, claimedCoverage } from './index.js';
import type { Identity } from '../proxy/pool.js';

/** Every signal id in the detector's catalog, by layer. */
const EXPECTED_SIGNALS = {
  transport: [
    'http.ua_headless',
    'http.header_order',
    'http.missing_accept_language',
    'http.ch_ua_mismatch',
    'http.no_sec_fetch',
    'http.accept_encoding_narrow',
    'http.rate_exceeded',
    'http.datacenter_asn',
    'probe.silent',
  ],
  fingerprint: [
    'fp.webdriver',
    'fp.automation_artifacts',
    'fp.chrome_object_missing',
    'fp.plugins_empty',
    'fp.languages_empty',
    'fp.permissions_anomaly',
    'fp.webgl_software_renderer',
    'fp.canvas_known_headless',
    'fp.screen_impossible',
    'fp.function_tostring_tampered',
    'fp.error_stack_injection',
    'fp.timezone_mismatch',
    'fp.media_devices_empty',
    'fp.hardware_implausible',
  ],
  /**
   * Behavioural signals are answered by `behavior/`, not by injected script, so they
   * are excluded from the patch-coverage assertion and asserted statistically in
   * mouse.test.ts and typing.test.ts instead.
   */
  behavior: [
    'bhv.click_without_movement',
    'bhv.linear_path',
    'bhv.constant_velocity',
    'bhv.teleport',
    'bhv.typing_uniform',
    'bhv.typing_superhuman',
    'bhv.instant_interaction',
    'bhv.scroll_uniform',
    'bhv.no_ambient_events',
  ],
} as const;

const TEST_IDENTITY: Identity = {
  label: 'test-persona',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  acceptLanguage: 'fr-FR,fr;q=0.9,en-US;q=0.8',
  platform: 'macOS',
  timezoneId: 'Europe/Paris',
  egressIp: '78.12.34.56',
  residential: true,
  viewport: { width: 1440, height: 810, deviceScaleFactor: 2 },
  screen: { width: 2560, height: 1440, positionX: 220, positionY: 140 },
  hardwareConcurrency: 10,
  deviceMemory: 16,
  webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
  uaMetadata: {
    brands: [{ brand: 'Chromium', version: '126' }],
    fullVersion: '126.0.6478.127',
    platform: 'macOS',
    platformVersion: '14.5.0',
    architecture: 'arm',
    model: '',
    mobile: false,
  },
  proxyUrl: null,
};

test('every transport and fingerprint signal has a counter-measure', () => {
  const covered = new Set(coveredSignals());
  const missing = [...EXPECTED_SIGNALS.transport, ...EXPECTED_SIGNALS.fingerprint].filter(
    (id) => !covered.has(id),
  );

  assert.deepEqual(
    missing,
    [],
    `these detector signals have no answer in stealth/patches.ts: ${missing.join(', ')}`,
  );
});

test('no patch claims a signal that does not exist', () => {
  const known = new Set<string>([
    ...EXPECTED_SIGNALS.transport,
    ...EXPECTED_SIGNALS.fingerprint,
    ...EXPECTED_SIGNALS.behavior,
  ]);
  const orphans = coveredSignals().filter((id) => !known.has(id));

  // A patch answering a signal the detector no longer raises is dead code that still
  // costs a detectable surface every time it runs.
  assert.deepEqual(orphans, [], `patches answer signals not in the catalog: ${orphans.join(', ')}`);
});

test('every patch entry either injects script or names where the fix lives', () => {
  for (const patch of PATCHES) {
    if (patch.source === null) {
      assert.ok(
        patch.handledElsewhere && patch.handledElsewhere.length > 10,
        `${patch.signal} has no source and no explanation of where it is handled`,
      );
    }
  }
});

test('signal ids are unique across patches', () => {
  const seen = new Set<string>();
  for (const patch of PATCHES) {
    assert.ok(!seen.has(patch.signal), `duplicate counter-measure for ${patch.signal}`);
    seen.add(patch.signal);
  }
});

test('the naive profile injects nothing', () => {
  // The control in the experiment must stay uncontrolled. A naive profile that
  // quietly picked up one patch would make every comparison in the demo meaningless.
  for (const profile of ['naive', 'raw-http'] as const) {
    const bootstrap = buildBootstrap(TEST_IDENTITY, profile);
    assert.equal(bootstrap.source, null, `${profile} must not inject a bootstrap script`);
    assert.deepEqual(bootstrap.appliedPatches, []);
  }
});

test('the stealth bootstrap is syntactically valid JavaScript', () => {
  const bootstrap = buildBootstrap(TEST_IDENTITY, 'stealth');
  assert.ok(bootstrap.source, 'stealth profile must produce a bootstrap');
  assert.ok(bootstrap.sourceBytes > 2000, 'bootstrap looks suspiciously small');

  // Parse without executing. The script only runs inside a browser, so a syntax
  // error would otherwise surface as a silently unpatched session — the worst
  // possible failure mode, because the run still completes and just gets caught.
  assert.doesNotThrow(
    () => new Function(bootstrap.source as string),
    'the assembled bootstrap does not parse',
  );
});

test('the bootstrap installs the native-function shim before any patch uses it', () => {
  const source = buildBootstrap(TEST_IDENTITY, 'stealth').source as string;

  const shimIndex = source.indexOf('function asNative');
  const firstUse = source.indexOf("patch('");

  assert.ok(shimIndex >= 0, 'asNative helper is missing');
  assert.ok(firstUse >= 0, 'no patches were emitted');
  assert.ok(
    shimIndex < firstUse,
    'the native shim must be defined before the first patch that registers through it',
  );
});

test('the bootstrap carries the identity, not hardcoded values', () => {
  const source = buildBootstrap(TEST_IDENTITY, 'stealth').source as string;

  // Every identity-derived value must actually reach the injected script — a patch
  // that ignores the identity produces a fleet that all looks identical, which is
  // the fingerprint fp.canvas_known_headless is watching for.
  assert.ok(source.includes(TEST_IDENTITY.webgl.renderer), 'WebGL renderer not carried into the bootstrap');
  assert.ok(source.includes(String(TEST_IDENTITY.hardwareConcurrency)), 'hardwareConcurrency not carried');
  assert.ok(source.includes('MacIntel'), 'navigator.platform not derived from the persona');
  assert.ok(source.includes('fr-FR'), 'languages not derived from the identity Accept-Language');
});

test('two identities produce different canvas perturbations', () => {
  const other: Identity = { ...TEST_IDENTITY, label: 'other-persona', egressIp: '82.99.1.2' };
  const a = buildBootstrap(TEST_IDENTITY, 'stealth').source as string;
  const b = buildBootstrap(other, 'stealth').source as string;

  assert.notEqual(a, b, 'two identities must not produce byte-identical bootstraps');
});

test('claimed coverage is reportable for every signal', () => {
  for (const claim of claimedCoverage()) {
    assert.ok(claim.via !== 'unknown', `${claim.signal} does not say how it is answered`);
  }
});
