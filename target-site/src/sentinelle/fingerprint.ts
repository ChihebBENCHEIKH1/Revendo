/**
 * Sentinelle — layer 2, browser fingerprint evaluation.
 *
 * The probe (`public/probe.js`) runs in the page and posts this payload. Everything
 * here is evaluated server-side: the client is hostile by definition, so the client
 * is only ever a sensor, never a judge. A payload that fails to parse is itself
 * suspicious — a real browser running our own script produces our own shape.
 */

import { z } from 'zod';
import type { Detection } from './scoring.js';

export const FingerprintPayload = z.object({
  webdriver: z.boolean(),
  automationKeys: z.array(z.string()),
  hasChromeObject: z.boolean(),
  hasChromeRuntime: z.boolean(),
  pluginCount: z.number(),
  languages: z.array(z.string()),
  notificationPermission: z.string().nullable(),
  permissionsQueryState: z.string().nullable(),
  webglVendor: z.string().nullable(),
  webglRenderer: z.string().nullable(),
  canvasHash: z.string(),
  screen: z.object({
    width: z.number(),
    height: z.number(),
    availWidth: z.number(),
    availHeight: z.number(),
    innerWidth: z.number(),
    innerHeight: z.number(),
    outerWidth: z.number(),
    outerHeight: z.number(),
    devicePixelRatio: z.number(),
  }),
  nativeToStringOk: z.boolean(),
  stackLeak: z.boolean(),
  timezone: z.string(),
  mediaDeviceKinds: z.array(z.string()),
  hardwareConcurrency: z.number(),
  deviceMemory: z.number().nullable(),
  userAgent: z.string(),
});

export type FingerprintPayload = z.infer<typeof FingerprintPayload>;

/**
 * Canvas hashes produced by our own reference headless container.
 *
 * A defender with real traffic does not hardcode these — they learn them, because a
 * scraping fleet of identical containers renders identically and that shared hash
 * becomes the cohort key that unmasks the whole fleet at once. See
 * `cohortSize` below, which is the honest version of this check.
 */
const KNOWN_HEADLESS_CANVAS = new Set([
  'c0ffee00deadbeef',
  '9e107d9d372bb682',
]);

const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|software|mesa offscreen|generic renderer/i;

/** Rough geo-IP region for the exit node, used only for the timezone coherence check. */
export interface FingerprintContext {
  /** IANA zone we would expect given where the request appears to come from. */
  readonly expectedTimezoneRegion: string | null;
  /**
   * How many *distinct* sessions have reported this exact canvas hash recently.
   * A shared hash across many identities means one machine wearing many hats.
   */
  readonly canvasCohortSize: number;
  /**
   * Whether the page was served from a secure context.
   *
   * `navigator.mediaDevices` is a secure-context API — on a plain-HTTP origin it is
   * `undefined` in *every* browser, so `enumerateDevices()` returning nothing says
   * nothing about the client. Scoring it there is a guaranteed false positive, and
   * it is the same class of mistake as scoring absent Sec-Fetch headers: penalising
   * a client for something the platform refused to give it.
   */
  readonly secureOrigin: boolean;
}

export function inspectFingerprint(fp: FingerprintPayload, ctx: FingerprintContext): Detection[] {
  const at = Date.now();
  const out: Detection[] = [];
  const raise = (id: string, evidence: string) => out.push({ id, evidence, at });

  if (fp.webdriver) raise('fp.webdriver', 'navigator.webdriver === true');

  if (fp.automationKeys.length > 0) {
    raise('fp.automation_artifacts', `window has ${fp.automationKeys.slice(0, 3).join(', ')}`);
  }

  if (!fp.hasChromeObject) {
    raise('fp.chrome_object_missing', 'window.chrome is undefined');
  } else if (!fp.hasChromeRuntime && /Chrome\/\d+/.test(fp.userAgent)) {
    raise('fp.chrome_object_missing', 'window.chrome present but chrome.runtime missing');
  }

  if (fp.pluginCount === 0) raise('fp.plugins_empty', 'navigator.plugins.length === 0');
  if (fp.languages.length === 0) raise('fp.languages_empty', 'navigator.languages is empty');

  // The classic: two APIs backed by the same permission store disagreeing with each other.
  if (fp.notificationPermission === 'denied' && fp.permissionsQueryState === 'prompt') {
    raise('fp.permissions_anomaly', "Notification.permission='denied' but query()='prompt'");
  }

  if (fp.webglRenderer && SOFTWARE_RENDERERS.test(fp.webglRenderer)) {
    raise('fp.webgl_software_renderer', `renderer=${fp.webglRenderer}`);
  }

  if (KNOWN_HEADLESS_CANVAS.has(fp.canvasHash)) {
    raise('fp.canvas_known_headless', `canvas=${fp.canvasHash} (reference headless render)`);
  } else if (ctx.canvasCohortSize >= 5) {
    raise(
      'fp.canvas_known_headless',
      `canvas=${fp.canvasHash} shared by ${ctx.canvasCohortSize} distinct sessions`,
    );
  }

  const s = fp.screen;
  const impossible =
    s.outerHeight === 0 ||
    s.outerWidth === 0 ||
    s.width === 0 ||
    s.innerWidth > s.width ||
    s.innerHeight > s.height ||
    s.availWidth > s.width ||
    s.availHeight > s.height;
  if (impossible) {
    raise(
      'fp.screen_impossible',
      `screen=${s.width}x${s.height} inner=${s.innerWidth}x${s.innerHeight} outer=${s.outerWidth}x${s.outerHeight}`,
    );
  }

  // Bad-stealth detectors. These fire on evasion that was attempted and botched,
  // which is a different — and louder — population than "no evasion at all".
  if (!fp.nativeToStringOk) {
    raise('fp.function_tostring_tampered', 'a patched native function does not stringify as [native code]');
  }
  if (fp.stackLeak) {
    raise('fp.error_stack_injection', 'Error stack references an injected script source');
  }

  if (ctx.expectedTimezoneRegion && fp.timezone) {
    const sameRegion = fp.timezone.split('/')[0] === ctx.expectedTimezoneRegion.split('/')[0];
    if (!sameRegion) {
      raise('fp.timezone_mismatch', `browser tz=${fp.timezone}, IP suggests ${ctx.expectedTimezoneRegion}`);
    }
  }

  if (ctx.secureOrigin && fp.mediaDeviceKinds.length === 0) {
    raise('fp.media_devices_empty', 'enumerateDevices() returned nothing');
  }

  const cores = fp.hardwareConcurrency;
  const mem = fp.deviceMemory;
  if (cores < 2 || cores > 32 || (mem !== null && (mem < 2 || mem > 64))) {
    raise('fp.hardware_implausible', `cores=${cores} deviceMemory=${mem ?? 'n/a'}`);
  }

  return out;
}
