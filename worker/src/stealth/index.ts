/**
 * Bootstrap script assembly.
 *
 * Every patch is concatenated into a single IIFE and installed with
 * `Page.addScriptToEvaluateOnNewDocument`, so it runs before any page script in
 * every new document.
 *
 * One IIFE rather than one script per patch, for two reasons: the patches share the
 * `asNative` / `defineGetter` machinery from the prelude, and each additional
 * injected script is another entry that can surface in a stack trace. Fewer, larger
 * injections leave a smaller footprint than many small ones.
 */

import type { Profile } from '../config.js';
import type { Identity } from '../proxy/pool.js';
import { nativeShimSource } from './nativeShim.js';
import { PATCHES } from './patches.js';

export interface BootstrapResult {
  /** Null for profiles that inject nothing. */
  readonly source: string | null;
  readonly appliedPatches: readonly string[];
  readonly sourceBytes: number;
}

export function buildBootstrap(identity: Identity, profile: Profile): BootstrapResult {
  // The naive profile is naive on purpose. It is the control in the experiment, and
  // an experiment whose control has been quietly improved measures nothing.
  if (profile !== 'stealth') {
    return { source: null, appliedPatches: [], sourceBytes: 0 };
  }

  const active = PATCHES.filter((p) => p.source !== null);
  const body = active.map((p) => p.source!(identity)).join('\n');

  const source = `(function () {
  'use strict';
${nativeShimSource()}
${body}
})();`;

  return {
    source,
    appliedPatches: active.map((p) => p.name),
    sourceBytes: Buffer.byteLength(source, 'utf8'),
  };
}

/**
 * Which Sentinelle signals this worker claims to answer.
 *
 * Exported so the coverage test can compare it against the live catalog served at
 * `/__sentinelle/catalog`. If the detector grows a signal and the worker does not
 * grow an answer, that test fails — which is the only way a claim like "every signal
 * has a counter-measure" stays true past the day it was written.
 */
export function claimedCoverage(): { signal: string; via: string }[] {
  return PATCHES.map((p) => ({
    signal: p.signal,
    via: p.source ? `stealth/patches.ts:${p.name}` : (p.handledElsewhere ?? 'unknown'),
  }));
}
