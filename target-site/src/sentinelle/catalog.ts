/**
 * Sentinelle — signal catalog.
 *
 * This file is deliberately data, not logic. Every signal Sentinelle can raise is
 * declared here once, with its weight and — importantly — the *rationale*: why a
 * real browser driven by a real human would not trip it.
 *
 * Commercial vendors (DataDome, PerimeterX, Kasada, Akamai BM) run the same shape
 * of pipeline: cheap transport-layer signals gate the request, a JS probe collects
 * a fingerprint, and a behavioural stream scores the session over time. The weights
 * here are illustrative, not reverse-engineered — the *structure* is the point.
 *
 * Every signal below has a matching counter-measure in `worker/src/stealth` or
 * `worker/src/behavior`. That symmetry is the whole exercise: you cannot reliably
 * evade a detector you could not have written yourself.
 */

export type SignalLayer = 'transport' | 'fingerprint' | 'behavior';

export interface SignalSpec {
  /** Stable id, namespaced by layer. Used as the join key with the worker's counter-measures. */
  readonly id: string;
  readonly layer: SignalLayer;
  /** Contribution to the suspicion score when raised. Scores are clamped to [0,100]. */
  readonly weight: number;
  /** What tripped. */
  readonly description: string;
  /** Why a genuine human-driven Chrome would not trip it. */
  readonly rationale: string;
  /** Where the counter-measure lives, so the two halves stay navigable from either side. */
  readonly counteredBy: string;
}

/**
 * Layer 1 — transport.
 *
 * Evaluated on every request before a single byte of JS runs. Cheap, and enough on
 * its own to stop the overwhelming majority of naive scrapers (curl, requests,
 * unconfigured HTTP clients). Real anti-bot stacks also fingerprint the TLS
 * ClientHello (JA3/JA4) and the HTTP/2 SETTINGS frame here; Node's `http` module
 * does not surface either, so Sentinelle approximates transport identity with
 * header order and Client Hints consistency. See docs/ANTI-BOT.md § "What this
 * intentionally does not model".
 */
const TRANSPORT: SignalSpec[] = [
  {
    id: 'http.ua_headless',
    layer: 'transport',
    weight: 30,
    description: 'User-Agent advertises HeadlessChrome',
    rationale: 'Chrome only emits this token when launched headless. No human browser sends it.',
    counteredBy: 'worker/src/stealth/patches/userAgent.ts',
  },
  {
    id: 'http.header_order',
    layer: 'transport',
    weight: 12,
    description: 'Request header order deviates from Chrome canonical order',
    rationale:
      'Chrome emits headers in a stable, version-specific order. HTTP libraries emit them in ' +
      'insertion or alphabetical order. Order is free to observe and expensive to fake blindly.',
    counteredBy: 'worker/src/stealth/patches/headerOrder.ts',
  },
  {
    id: 'http.missing_accept_language',
    layer: 'transport',
    weight: 10,
    description: 'Accept-Language absent or empty',
    rationale: 'Every consumer browser sends a locale preference. Its absence is a scripted client.',
    counteredBy: 'worker/src/stealth/patches/headerOrder.ts',
  },
  {
    id: 'http.ch_ua_mismatch',
    layer: 'transport',
    weight: 18,
    description: 'Sec-CH-UA brand/version disagrees with the User-Agent string',
    rationale:
      'Chrome derives both from the same build. A spoofer that rewrites the UA string but ' +
      'leaves Client Hints untouched contradicts itself — one of the most common stealth bugs.',
    counteredBy: 'worker/src/stealth/patches/clientHints.ts',
  },
  {
    id: 'http.no_sec_fetch',
    layer: 'transport',
    weight: 10,
    description: 'Sec-Fetch-* request metadata missing on a navigation',
    rationale: 'Chrome attaches Fetch Metadata to every navigation. Absence implies a non-browser client.',
    counteredBy: 'worker/src/stealth/patches/headerOrder.ts',
  },
  {
    id: 'http.accept_encoding_narrow',
    layer: 'transport',
    weight: 6,
    description: 'Accept-Encoding omits brotli',
    rationale: 'Chrome has advertised br since v50. Its absence suggests a hand-rolled client.',
    counteredBy: 'worker/src/stealth/patches/headerOrder.ts',
  },
  {
    id: 'http.rate_exceeded',
    layer: 'transport',
    weight: 25,
    description: 'Per-IP request budget exhausted (Redis token bucket)',
    rationale:
      'Humans browse at human rates. This is the signal residential proxy rotation exists to ' +
      'defeat, which is exactly why it is priced per-GB.',
    counteredBy: 'worker/src/proxy/pool.ts',
  },
  {
    id: 'probe.silent',
    layer: 'transport',
    // The heaviest signal in the catalog, and it earns it. Every other transport
    // check can be satisfied by formatting a request more carefully; this one
    // requires actually executing JavaScript, which is a categorically more
    // expensive thing to fake. It is the ceiling on header spoofing.
    weight: 40,
    description: 'Programmatic API call from a session that was served HTML but never ran its script',
    rationale:
      'The single most reliable way to catch a client that fakes headers well but has no browser. ' +
      'A real browser that loads a page executes the script in it; a session that received the ' +
      'probe, never reported, and then calls the API directly did not run any JavaScript at all. ' +
      'Timing-independent, because it keys on the request carrying no Fetch Metadata rather than ' +
      'on how quickly telemetry arrived.',
    counteredBy: 'run an actual browser — worker/src/cdp/session.ts',
  },
  {
    id: 'http.datacenter_asn',
    layer: 'transport',
    weight: 20,
    description: 'Client IP resolves to a hosting/datacenter ASN',
    rationale:
      'Shoppers do not browse from AWS. Simulated here via a prefix table — in production this ' +
      'is an IP intelligence feed (ASN, proxy/VPN reputation, residential-vs-hosting class).',
    counteredBy: 'worker/src/proxy/pool.ts',
  },
];

/**
 * Layer 2 — browser fingerprint.
 *
 * Collected by an in-page probe (`public/probe.js`) and posted to /api/telemetry.
 * These are the classic automation tells. Note `fp.function_tostring` and
 * `fp.error_stack`: those do not detect automation directly, they detect *sloppy
 * evasion*. A naive stealth layer that redefines properties without laundering
 * `Function.prototype.toString` is louder than no stealth at all, because a real
 * Chrome never has a tampered native function.
 */
const FINGERPRINT: SignalSpec[] = [
  {
    id: 'fp.webdriver',
    layer: 'fingerprint',
    weight: 35,
    description: 'navigator.webdriver is true',
    rationale: 'Set by the W3C WebDriver spec whenever the browser is under automation control.',
    counteredBy: 'worker/src/stealth/patches/webdriver.ts',
  },
  {
    id: 'fp.automation_artifacts',
    layer: 'fingerprint',
    weight: 35,
    description: 'Selenium/ChromeDriver artifacts present on window ($cdc_, cdc_ keys)',
    rationale: 'ChromeDriver injects uniquely-named globals. Their presence is conclusive.',
    counteredBy: 'worker/src/stealth/patches/artifacts.ts',
  },
  {
    id: 'fp.chrome_object_missing',
    layer: 'fingerprint',
    weight: 15,
    description: 'window.chrome absent, or chrome.runtime missing on a Chrome UA',
    rationale: 'Headless Chrome historically omits the chrome object that headful Chrome always exposes.',
    counteredBy: 'worker/src/stealth/patches/chromeObject.ts',
  },
  {
    id: 'fp.plugins_empty',
    layer: 'fingerprint',
    weight: 12,
    description: 'navigator.plugins is empty',
    rationale: 'Headful Chrome ships a fixed set of internal PDF plugins. Headless ships none.',
    counteredBy: 'worker/src/stealth/patches/plugins.ts',
  },
  {
    id: 'fp.languages_empty',
    layer: 'fingerprint',
    weight: 12,
    description: 'navigator.languages is empty',
    rationale: 'Mirrors Accept-Language. Empty means no locale was ever configured.',
    counteredBy: 'worker/src/stealth/patches/languages.ts',
  },
  {
    id: 'fp.permissions_anomaly',
    layer: 'fingerprint',
    weight: 20,
    description: "Notification.permission is 'denied' while permissions.query() reports 'prompt'",
    rationale:
      'A genuine browser keeps these two APIs consistent. Headless Chrome does not, and this ' +
      'contradiction is one of the oldest reliable headless tells.',
    counteredBy: 'worker/src/stealth/patches/permissions.ts',
  },
  {
    id: 'fp.webgl_software_renderer',
    layer: 'fingerprint',
    weight: 18,
    description: 'WebGL renderer is SwiftShader / llvmpipe / software',
    rationale: 'Real consumer hardware reports a real GPU. Software rasterisation means no GPU, i.e. a server.',
    counteredBy: 'worker/src/stealth/patches/webgl.ts',
  },
  {
    id: 'fp.canvas_known_headless',
    layer: 'fingerprint',
    weight: 14,
    description: 'Canvas fingerprint matches a known headless-render hash',
    rationale:
      'Font stack and rasteriser differences make canvas output machine-specific. A fleet of ' +
      'identical containers produces one identical hash — which is itself the signal.',
    counteredBy: 'worker/src/stealth/patches/canvas.ts',
  },
  {
    id: 'fp.screen_impossible',
    layer: 'fingerprint',
    weight: 16,
    description: 'Screen/window geometry is impossible (outerHeight 0, or window larger than screen)',
    rationale: 'Headless has no window manager, so chrome-less geometry leaks through as zeroes.',
    counteredBy: 'worker/src/stealth/patches/screen.ts',
  },
  {
    id: 'fp.function_tostring_tampered',
    layer: 'fingerprint',
    weight: 25,
    description: 'A patched native function does not stringify as [native code]',
    rationale:
      'THIS DETECTS BAD STEALTH, NOT AUTOMATION. Redefining navigator.webdriver with a plain ' +
      'getter leaves a JS function where a native one belongs. Evasion must launder toString ' +
      'or it is louder than doing nothing.',
    counteredBy: 'worker/src/stealth/nativeShim.ts',
  },
  {
    id: 'fp.error_stack_injection',
    layer: 'fingerprint',
    weight: 20,
    description: 'Error stack traces reference injected/eval sources',
    rationale:
      'Also a bad-stealth detector. Scripts added via Page.addScriptToEvaluateOnNewDocument can ' +
      'surface in stack traces if they are not careful about where they throw.',
    counteredBy: 'worker/src/stealth/nativeShim.ts',
  },
  {
    id: 'fp.timezone_mismatch',
    layer: 'fingerprint',
    weight: 10,
    description: 'Intl timezone contradicts the geo-IP region of the exit node',
    rationale:
      'A residential IP in Lyon paired with a UTC browser clock is a proxy giveaway. Identity must ' +
      'be coherent across every layer, not just the ones you remembered to patch.',
    counteredBy: 'worker/src/stealth/patches/timezone.ts',
  },
  {
    id: 'fp.media_devices_empty',
    layer: 'fingerprint',
    weight: 8,
    description: 'enumerateDevices() returns no audio/video devices',
    rationale: 'Consumer laptops have a camera and a microphone. Servers have neither.',
    counteredBy: 'worker/src/stealth/patches/mediaDevices.ts',
  },
  {
    id: 'fp.hardware_implausible',
    layer: 'fingerprint',
    weight: 6,
    description: 'hardwareConcurrency / deviceMemory outside plausible consumer range',
    rationale: 'A 96-core, 2 GB machine is a container, not a MacBook.',
    counteredBy: 'worker/src/stealth/patches/hardware.ts',
  },
];

/**
 * Layer 3 — behaviour.
 *
 * The layer that actually matters, and the one most scrapers ignore. Fingerprints
 * are a static puzzle you solve once; behaviour is a continuous signal you have to
 * keep producing convincingly for the whole session. This is why "human-like
 * behaviour" is a first-class subsystem in the worker rather than a sleep() call.
 */
const BEHAVIOR: SignalSpec[] = [
  {
    id: 'bhv.click_without_movement',
    layer: 'behavior',
    weight: 30,
    description: 'Click dispatched with no preceding mousemove in the session',
    rationale:
      'A human must move a pointer to a target before pressing it. Automation that calls .click() ' +
      'produces a click event with no kinematic history at all.',
    counteredBy: 'worker/src/behavior/mouse.ts',
  },
  {
    id: 'bhv.linear_path',
    layer: 'behavior',
    weight: 22,
    description: 'Pointer path is near-perfectly straight (R² > 0.99 on a linear fit)',
    rationale:
      'Human reaching follows a curved, corrected trajectory (Fitts\'s law: ballistic launch, ' +
      'overshoot, homing correction). Interpolating A→B in a straight line is a machine artefact.',
    counteredBy: 'worker/src/behavior/mouse.ts',
  },
  {
    id: 'bhv.constant_velocity',
    layer: 'behavior',
    weight: 18,
    description: 'Pointer speed has near-zero variance across the path',
    rationale:
      'Human pointer velocity is bell-shaped: accelerate, peak, decelerate into the target. ' +
      'Constant velocity means linear interpolation on a timer.',
    counteredBy: 'worker/src/behavior/mouse.ts',
  },
  {
    id: 'bhv.teleport',
    layer: 'behavior',
    weight: 25,
    description: 'Pointer jumped a large distance between consecutive samples',
    rationale: 'A single event moving the cursor 800px is a coordinate assignment, not a hand.',
    counteredBy: 'worker/src/behavior/mouse.ts',
  },
  {
    id: 'bhv.typing_uniform',
    layer: 'behavior',
    weight: 22,
    description: 'Inter-keystroke intervals have implausibly low variation (CV < 0.15)',
    rationale:
      'Human typing intervals are log-normal and digraph-dependent — "th" is fast, "qp" is slow. ' +
      'A fixed delay between keys has a coefficient of variation near zero.',
    counteredBy: 'worker/src/behavior/typing.ts',
  },
  {
    id: 'bhv.typing_superhuman',
    layer: 'behavior',
    weight: 20,
    description: 'Mean inter-keystroke interval below human floor (<25ms)',
    rationale: 'Sustained sub-25ms keying is ~480 WPM. World record territory, for an entire form.',
    counteredBy: 'worker/src/behavior/typing.ts',
  },
  {
    id: 'bhv.instant_interaction',
    layer: 'behavior',
    weight: 15,
    description: 'First interaction occurred <150ms after DOMContentLoaded',
    rationale: 'Below human visual reaction time. Nobody has read the page yet.',
    counteredBy: 'worker/src/behavior/dwell.ts',
  },
  {
    id: 'bhv.scroll_uniform',
    layer: 'behavior',
    weight: 10,
    description: 'Scroll deltas are perfectly uniform',
    rationale: 'Wheel input is quantised and noisy; smooth constant deltas indicate scripted scrollTo.',
    counteredBy: 'worker/src/behavior/scroll.ts',
  },
  {
    id: 'bhv.no_ambient_events',
    layer: 'behavior',
    weight: 6,
    description: 'No focus/blur/visibilitychange/resize for the whole session',
    rationale:
      'Weak on its own — a focused user generates none either. Included precisely to show that ' +
      'not every signal deserves a heavy weight; stacking weak signals is how false positives happen.',
    counteredBy: 'worker/src/behavior/ambient.ts',
  },
];

export const SIGNAL_CATALOG: readonly SignalSpec[] = Object.freeze([
  ...TRANSPORT,
  ...FINGERPRINT,
  ...BEHAVIOR,
]);

const BY_ID = new Map(SIGNAL_CATALOG.map((s) => [s.id, s]));

export function signalSpec(id: string): SignalSpec {
  const spec = BY_ID.get(id);
  // A raised signal with no catalog entry is a programming error, not a runtime condition:
  // it means a detector and the catalog have drifted apart. Fail loudly in dev rather than
  // silently scoring zero in production.
  if (!spec) throw new Error(`Sentinelle: unknown signal id "${id}" — add it to catalog.ts`);
  return spec;
}

export function signalsByLayer(layer: SignalLayer): readonly SignalSpec[] {
  return SIGNAL_CATALOG.filter((s) => s.layer === layer);
}
