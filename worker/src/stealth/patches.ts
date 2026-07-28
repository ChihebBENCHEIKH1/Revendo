/**
 * Fingerprint counter-measures.
 *
 * One entry per Sentinelle signal, each carrying the `signal` id it answers so the
 * two halves of the project stay joinable from either side — `npm run coverage` in
 * the worker reads these ids and asserts every fingerprint-layer signal in the
 * catalog has an answer here.
 *
 * Ordering matters: `nativeShim` runs first (everything below depends on `asNative`,
 * `defineGetter` and `patch`), and each patch is wrapped so one failure cannot take
 * the rest with it.
 *
 * A patch is a last resort. Where a launch flag or a CDP override can fix something
 * at the source it is done there instead — see the `handledElsewhere` entries, which
 * exist so the coverage check stays honest about what this file does *not* do.
 */

import type { Identity } from '../proxy/pool.js';

export interface Patch {
  /** Sentinelle signal id this answers. */
  readonly signal: string;
  readonly name: string;
  /** JS source, evaluated inside the shared prelude scope. Null when fixed elsewhere. */
  readonly source: ((id: Identity) => string) | null;
  /** For null-source entries: where the real fix lives. */
  readonly handledElsewhere?: string;
}

const json = (v: unknown) => JSON.stringify(v);

export const PATCHES: readonly Patch[] = [
  /* ------------------------------------------------------------------ *
   * Fixed at the source — no injected script at all.
   * ------------------------------------------------------------------ */
  {
    signal: 'http.ua_headless',
    name: 'user-agent',
    source: null,
    handledElsewhere: 'Network.setUserAgentOverride in cdp/session.ts (with matching platform + Client Hints)',
  },
  {
    signal: 'http.ch_ua_mismatch',
    name: 'client-hints',
    source: null,
    handledElsewhere: 'userAgentMetadata passed to Network.setUserAgentOverride — derived from the same persona as the UA string',
  },
  {
    signal: 'http.header_order',
    name: 'header-order',
    source: null,
    handledElsewhere: 'Fetch.continueRequest with an ordered header array — see cdp/headerOrder.ts',
  },
  {
    signal: 'http.missing_accept_language',
    name: 'accept-language',
    source: null,
    handledElsewhere: 'acceptLanguage in Network.setUserAgentOverride + Fetch header normalizer',
  },
  {
    signal: 'http.accept_encoding_narrow',
    name: 'accept-encoding',
    source: null,
    handledElsewhere: 'Fetch header normalizer adds br/zstd',
  },
  {
    signal: 'http.no_sec_fetch',
    name: 'fetch-metadata',
    source: null,
    handledElsewhere: 'Chrome emits Sec-Fetch-* itself on real navigations; the normalizer preserves them',
  },
  {
    signal: 'fp.timezone_mismatch',
    name: 'timezone',
    source: null,
    handledElsewhere: 'Emulation.setTimezoneOverride + setLocaleOverride in cdp/session.ts — a real clock, not a lie about one',
  },
  {
    signal: 'http.rate_exceeded',
    name: 'rate',
    source: null,
    handledElsewhere: 'proxy/pool.ts — one egress IP per identity, plus pacing in behavior/dwell.ts',
  },
  {
    signal: 'http.datacenter_asn',
    name: 'egress',
    source: null,
    handledElsewhere: 'proxy/pool.ts residential egress',
  },
  {
    signal: 'probe.silent',
    name: 'run-a-real-browser',
    source: null,
    handledElsewhere:
      'nothing to patch: the browser profiles execute the page script because they are a browser. ' +
      'This is the signal that cannot be defeated by formatting requests better — it is why the ' +
      'raw-http profile exists as a baseline and why it is the one that never gets through.',
  },
  {
    signal: 'fp.automation_artifacts',
    name: 'chromedriver-artifacts',
    source: null,
    handledElsewhere:
      'nothing to remove: $cdc_ globals come from ChromeDriver, and driving Chrome over raw CDP never loads it. ' +
      'A whole signal class avoided for free by not using WebDriver.',
  },

  /* ------------------------------------------------------------------ *
   * Injected patches.
   * ------------------------------------------------------------------ */
  {
    signal: 'fp.webdriver',
    name: 'webdriver',
    source: () => `
    patch('webdriver', function () {
      // --disable-blink-features=AutomationControlled should already have handled
      // this. Only patch if it did not: an unpatched-but-correct property is
      // strictly better than a patched one, because there is nothing to detect.
      if (navigator.webdriver !== true) return;
      defineGetter(Navigator.prototype, 'webdriver', function () { return false; }, 'get webdriver');
    });`,
  },
  {
    signal: 'fp.chrome_object_missing',
    name: 'chrome-object',
    source: () => `
    patch('chrome-object', function () {
      if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
          value: {}, writable: true, enumerable: true, configurable: true,
        });
      }
      const chrome = window.chrome;

      if (!chrome.runtime) {
        // On an ordinary page (no extension context) chrome.runtime exists but is
        // essentially inert. Reproduce that shape rather than inventing a rich API
        // that would not survive being poked at.
        Object.defineProperty(chrome, 'runtime', {
          value: Object.create(null, {
            id: { value: undefined, enumerable: true },
            connect: { value: asNative(function connect() {}, 'connect'), enumerable: true },
            sendMessage: { value: asNative(function sendMessage() {}, 'sendMessage'), enumerable: true },
          }),
          writable: true, enumerable: true, configurable: true,
        });
      }

      if (!chrome.csi) chrome.csi = asNative(function csi() {
        return { onloadT: Date.now(), startE: Date.now(), pageT: performance.now(), tran: 15 };
      }, 'csi');

      if (!chrome.loadTimes) chrome.loadTimes = asNative(function loadTimes() {
        const t = performance.timing || {};
        return {
          commitLoadTime: (t.responseStart || Date.now()) / 1000,
          finishDocumentLoadTime: (t.domContentLoadedEventEnd || Date.now()) / 1000,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
        };
      }, 'loadTimes');

      if (!chrome.app) {
        chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: asNative(function getDetails() { return null; }, 'getDetails'),
          getIsInstalled: asNative(function getIsInstalled() { return false; }, 'getIsInstalled'),
        };
      }
    });`,
  },
  {
    signal: 'fp.plugins_empty',
    name: 'plugins',
    source: () => `
    patch('plugins', function () {
      if (navigator.plugins && navigator.plugins.length > 0) return;

      // Chrome's five built-in PDF entries. They are aliases of one viewer, which is
      // why the filenames repeat — reproducing that detail matters, because a
      // detector that knows the real list checks the filenames too.
      const specs = [
        ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
        ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
        ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
        ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
        ['WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'],
      ];
      const mimeSpecs = [
        ['application/pdf', 'pdf', 'Portable Document Format'],
        ['text/pdf', 'pdf', 'Portable Document Format'],
      ];

      const hasPluginCtor = typeof Plugin !== 'undefined' && typeof MimeType !== 'undefined';

      const mimes = mimeSpecs.map(function (m) {
        const mt = Object.create(hasPluginCtor ? MimeType.prototype : Object.prototype);
        Object.defineProperties(mt, {
          type:        { value: m[0], enumerable: true },
          suffixes:    { value: m[1], enumerable: true },
          description: { value: m[2], enumerable: true },
        });
        return mt;
      });

      const plugins = specs.map(function (p) {
        const pl = Object.create(hasPluginCtor ? Plugin.prototype : Object.prototype);
        Object.defineProperties(pl, {
          name:        { value: p[0], enumerable: true },
          filename:    { value: p[1], enumerable: true },
          description: { value: p[2], enumerable: true },
          length:      { value: mimes.length, enumerable: true },
        });
        mimes.forEach(function (m, i) {
          Object.defineProperty(pl, i, { value: m, enumerable: true });
        });
        pl.item = asNative(function item(i) { return mimes[i] || null; }, 'item');
        pl.namedItem = asNative(function namedItem(n) {
          return mimes.filter(function (m) { return m.type === n; })[0] || null;
        }, 'namedItem');
        return pl;
      });

      // Back-reference: a MimeType knows which Plugin serves it. Detectors that
      // bother to check plugins[0][0].enabledPlugin === plugins[0] exist.
      mimes.forEach(function (m) {
        Object.defineProperty(m, 'enabledPlugin', { value: plugins[0], enumerable: true });
      });

      function makeArray(items, proto) {
        const arr = Object.create(proto || Object.prototype);
        items.forEach(function (it, i) {
          Object.defineProperty(arr, i, { value: it, enumerable: true });
        });
        Object.defineProperty(arr, 'length', { value: items.length, enumerable: false });
        arr.item = asNative(function item(i) { return items[i] || null; }, 'item');
        arr.namedItem = asNative(function namedItem(n) {
          return items.filter(function (x) { return x.name === n || x.type === n; })[0] || null;
        }, 'namedItem');
        arr.refresh = asNative(function refresh() {}, 'refresh');
        Object.defineProperty(arr, Symbol.iterator, {
          value: function () { return items[Symbol.iterator](); },
          enumerable: false, configurable: true,
        });
        return arr;
      }

      const pluginArray = makeArray(
        plugins,
        typeof PluginArray !== 'undefined' ? PluginArray.prototype : null,
      );
      const mimeArray = makeArray(
        mimes,
        typeof MimeTypeArray !== 'undefined' ? MimeTypeArray.prototype : null,
      );

      defineGetter(Navigator.prototype, 'plugins', function () { return pluginArray; }, 'get plugins');
      defineGetter(Navigator.prototype, 'mimeTypes', function () { return mimeArray; }, 'get mimeTypes');
    });`,
  },
  {
    signal: 'fp.languages_empty',
    name: 'languages',
    source: (id) => {
      // Derived from the same Accept-Language the transport layer sends. Two sources
      // of truth here would be a self-contradiction, which is the thing we are trying
      // hardest to avoid.
      const languages = id.acceptLanguage
        .split(',')
        .map((part) => part.split(';')[0]!.trim())
        .filter(Boolean);
      return `
    patch('languages', function () {
      const langs = Object.freeze(${json(languages)});
      defineGetter(Navigator.prototype, 'languages', function () { return langs; }, 'get languages');
      defineGetter(Navigator.prototype, 'language', function () { return langs[0]; }, 'get language');
    });`;
    },
  },
  {
    signal: 'fp.permissions_anomaly',
    name: 'permissions',
    source: () => `
    patch('permissions', function () {
      // The anomaly is a *contradiction*, not either value on its own. A fresh
      // profile has Notification.permission === 'default' and query() === 'prompt';
      // headless reports 'denied' and 'prompt'. Make both agree on the fresh-profile
      // answer rather than patching one of them into a different disagreement.
      if (typeof Notification !== 'undefined') {
        defineGetter(Notification, 'permission', function () { return 'default'; }, 'get permission');
      }
      if (navigator.permissions && navigator.permissions.query) {
        wrapMethod(navigator.permissions, 'query', function (original) {
          return function query(descriptor) {
            if (descriptor && descriptor.name === 'notifications') {
              return Promise.resolve({
                state: 'prompt', name: 'notifications', onchange: null,
                addEventListener: function () {}, removeEventListener: function () {},
                dispatchEvent: function () { return false; },
              });
            }
            return original.call(this, descriptor);
          };
        });
      }
    });`,
  },
  {
    signal: 'fp.webgl_software_renderer',
    name: 'webgl',
    source: (id) => `
    patch('webgl', function () {
      const VENDOR = ${json(id.webgl.vendor)};
      const RENDERER = ${json(id.webgl.renderer)};
      const UNMASKED_VENDOR = 37445;
      const UNMASKED_RENDERER = 37446;

      [
        typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null,
        typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null,
      ].forEach(function (proto) {
        if (!proto) return;
        wrapMethod(proto, 'getParameter', function (original) {
          return function getParameter(parameter) {
            if (parameter === UNMASKED_VENDOR) return VENDOR;
            if (parameter === UNMASKED_RENDERER) return RENDERER;
            // VENDOR/RENDERER (0x1F00/0x1F01) are left alone: real Chrome reports
            // 'WebKit'/'WebKit WebGL' there regardless of GPU, so "fixing" them
            // would introduce a discrepancy rather than remove one.
            return original.call(this, parameter);
          };
        });
      });
    });`,
  },
  {
    signal: 'fp.canvas_known_headless',
    name: 'canvas',
    source: (id) => `
    patch('canvas', function () {
      // Per-identity, DETERMINISTIC noise.
      //
      // The common mistake is randomising on every read. A detector that reads the
      // canvas twice and gets two different hashes has caught something far more
      // specific than a shared hash — no real browser's canvas changes between
      // consecutive reads. So the perturbation is seeded from the identity and is
      // stable for the whole session: different across the fleet, constant within it.
      let seed = 0;
      const label = ${json(id.label + id.egressIp)};
      for (let i = 0; i < label.length; i++) seed = (seed * 31 + label.charCodeAt(i)) >>> 0;

      const dx = seed % 3;
      const dy = (seed >> 3) % 3;
      const alpha = 0.01 + ((seed >> 6) % 5) / 1000;

      function perturb(canvas) {
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = 'rgb(' + (seed % 256) + ',' + ((seed >> 8) % 256) + ',' + ((seed >> 16) % 256) + ')';
          ctx.fillRect(dx, dy, 1, 1);
          ctx.restore();
        } catch (e) { /* tainted or context-less canvas: nothing to perturb */ }
      }

      if (typeof HTMLCanvasElement !== 'undefined') {
        wrapMethod(HTMLCanvasElement.prototype, 'toDataURL', function (original) {
          return function toDataURL() {
            perturb(this);
            return original.apply(this, arguments);
          };
        });
      }
      if (typeof CanvasRenderingContext2D !== 'undefined') {
        wrapMethod(CanvasRenderingContext2D.prototype, 'getImageData', function (original) {
          return function getImageData() {
            perturb(this.canvas);
            return original.apply(this, arguments);
          };
        });
      }
    });`,
  },
  {
    signal: 'fp.screen_impossible',
    name: 'screen',
    source: (id) => `
    patch('screen', function () {
      // Emulation.setDeviceMetricsOverride already gives correct inner/screen values.
      // What headless cannot produce is the *window frame*: with no window manager,
      // outerWidth/outerHeight stay 0. Derive them from the viewport plus a realistic
      // browser chrome height so the geometry is internally consistent.
      const CHROME_UI_HEIGHT = 88;   // tab strip + omnibox + bookmarks
      const OS_TASKBAR = 40;

      const w = ${id.viewport.width};
      const h = ${id.viewport.height};

      if (window.outerWidth === 0 || window.outerHeight === 0) {
        defineGetter(window, 'outerWidth', function () { return w; }, 'get outerWidth');
        defineGetter(window, 'outerHeight', function () { return h + CHROME_UI_HEIGHT; }, 'get outerHeight');
      }
      if (screen.availHeight >= screen.height) {
        defineGetter(Screen.prototype, 'availHeight', function () { return screen.height - OS_TASKBAR; }, 'get availHeight');
      }
      // screenX/screenY of 0,0 means the window is pinned to the top-left corner of
      // the display — possible, but every session doing it is a pattern.
      defineGetter(window, 'screenX', function () { return ${8 + (id.egressIp.length % 40)}; }, 'get screenX');
      defineGetter(window, 'screenY', function () { return ${25 + (id.label.length % 30)}; }, 'get screenY');
    });`,
  },
  {
    signal: 'fp.media_devices_empty',
    name: 'media-devices',
    source: () => `
    patch('media-devices', function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      wrapMethod(navigator.mediaDevices, 'enumerateDevices', function (original) {
        return function enumerateDevices() {
          return original.call(this).then(function (devices) {
            if (devices && devices.length > 0) return devices;
            // Without permission a real browser returns entries with empty labels and
            // empty deviceIds — the *kinds* are visible, the identities are not.
            // Returning populated labels here would be a different tell.
            return [
              { deviceId: '', kind: 'audioinput',  label: '', groupId: '' },
              { deviceId: '', kind: 'videoinput',  label: '', groupId: '' },
              { deviceId: '', kind: 'audiooutput', label: '', groupId: '' },
            ];
          });
        };
      });
    });`,
  },
  {
    signal: 'fp.hardware_implausible',
    name: 'hardware',
    source: (id) => `
    patch('hardware', function () {
      defineGetter(Navigator.prototype, 'hardwareConcurrency', function () {
        return ${id.hardwareConcurrency};
      }, 'get hardwareConcurrency');
      if ('deviceMemory' in Navigator.prototype || 'deviceMemory' in navigator) {
        defineGetter(Navigator.prototype, 'deviceMemory', function () {
          return ${id.deviceMemory};
        }, 'get deviceMemory');
      }
      defineGetter(Navigator.prototype, 'platform', function () {
        return ${json(platformStringFor(id.platform))};
      }, 'get platform');
    });`,
  },
  {
    signal: 'fp.function_tostring_tampered',
    name: 'native-shim',
    source: null,
    handledElsewhere: 'stealth/nativeShim.ts — every patch above registers through asNative/defineGetter/wrapMethod',
  },
  {
    signal: 'fp.error_stack_injection',
    name: 'stack-hygiene',
    source: null,
    handledElsewhere:
      'the prelude is one IIFE that installs handlers and returns; it never remains on the stack when page code throws',
  },
];

/**
 * `navigator.platform` for a persona.
 *
 * Legacy and deprecated, but still widely read, and still checked against the UA
 * string. Getting it wrong is a free contradiction to hand a detector.
 */
function platformStringFor(platform: string): string {
  switch (platform) {
    case 'macOS':
      return 'MacIntel';
    case 'Windows':
      return 'Win32';
    default:
      return 'Linux x86_64';
  }
}

/** Signal ids answered here, for the coverage check. */
export function coveredSignals(): string[] {
  return PATCHES.map((p) => p.signal);
}
