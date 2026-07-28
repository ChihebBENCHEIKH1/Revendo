/**
 * Sentinelle in-page probe.
 *
 * Runs in the visitor's browser, collects a fingerprint and a behavioural stream,
 * and posts both to /api/telemetry. It makes no decisions: the client is hostile by
 * construction, so the probe is a sensor and the server is the judge. Everything
 * here is trivially readable by an attacker — that is fine, and true of real vendors
 * too once you get past the obfuscation. The defence is not secrecy, it is that
 * producing *convincing* values for all of it simultaneously is expensive.
 *
 * Deliberately dependency-free and served unminified so the demo stays legible.
 */
(function () {
  'use strict';

  var TELEMETRY_URL = '/api/telemetry';
  var loadedAt = Date.now();

  /* ------------------------------------------------------------------ *
   * Fingerprint
   * ------------------------------------------------------------------ */

  /** FNV-1a, 64-bit-ish via two 32-bit lanes. Only needs to be stable, not secure. */
  function hashString(str) {
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 ^= c;
      h1 = (h1 * 0x01000193) >>> 0;
      h2 ^= c + i;
      h2 = (h2 * 0x85ebca6b) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  /**
   * Canvas fingerprint.
   *
   * Text rasterisation depends on the font stack, the renderer and subpixel
   * hinting, so the same drawing produces machine-specific bytes. The interesting
   * property for a defender is not the value but its *cardinality*: a fleet of
   * identical containers all report one hash.
   */
  function canvasHash() {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 260;
      canvas.height = 60;
      var ctx = canvas.getContext('2d');
      if (!ctx) return 'nocanvas';
      ctx.textBaseline = 'top';
      ctx.font = '14px "Arial"';
      ctx.fillStyle = '#f60';
      ctx.fillRect(this === undefined ? 0 : 0, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Vitrine — Sentinelle 🔒', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('Vitrine — Sentinelle 🔒', 4, 17);
      ctx.globalCompositeOperation = 'multiply';
      ctx.beginPath();
      ctx.arc(50, 40, 18, 0, Math.PI * 2, true);
      ctx.fill();
      return hashString(canvas.toDataURL());
    } catch (e) {
      return 'canvaserror';
    }
  }

  function webglInfo() {
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return { vendor: null, renderer: null };
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) };
      return {
        vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
      };
    } catch (e) {
      return { vendor: null, renderer: null };
    }
  }

  /**
   * Automation artefacts.
   *
   * ChromeDriver injects uniquely-named globals ($cdc_asdjflasutopfhvcZLmcfl_ and
   * friends). Their presence is conclusive, and cheap to scan for.
   */
  function automationKeys() {
    var found = [];
    try {
      for (var key in window) {
        if (/^[$_]?cdc_|^\$wdc_|^__webdriver|^__selenium|^__nightmare|^__playwright|^_phantom|^callPhantom|^domAutomation/i.test(key)) {
          found.push(key);
        }
      }
    } catch (e) { /* cross-origin or exotic window; absence of proof, not proof of absence */ }
    return found.slice(0, 5);
  }

  /**
   * Native-function integrity.
   *
   * This does not detect automation. It detects *sloppy evasion*, which is a louder
   * and more distinctive population. Redefining navigator.webdriver with a plain
   * getter leaves an ordinary JS function where the engine guarantees a native one,
   * and `Function.prototype.toString` will say so.
   *
   * Note the last check: `toString` applied to itself. A stealth layer that patches
   * toString to lie about other functions has to make that patched toString lie
   * about itself too, or it is the very thing it was written to hide.
   */
  function nativeToStringOk() {
    function isNative(fn) {
      if (typeof fn !== 'function') return true; // absent is a different signal, handled elsewhere
      try {
        return /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn));
      } catch (e) {
        return false;
      }
    }

    var suspects = [];
    try {
      var wd = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
      if (wd && wd.get) suspects.push(wd.get);
      var plug = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
      if (plug && plug.get) suspects.push(plug.get);
      var langs = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
      if (langs && langs.get) suspects.push(langs.get);
      if (navigator.permissions) suspects.push(navigator.permissions.query);
      if (window.HTMLCanvasElement) suspects.push(HTMLCanvasElement.prototype.toDataURL);
      if (window.WebGLRenderingContext) suspects.push(WebGLRenderingContext.prototype.getParameter);
      if (navigator.mediaDevices) suspects.push(navigator.mediaDevices.enumerateDevices);
      suspects.push(Function.prototype.toString);
    } catch (e) {
      return false;
    }

    for (var i = 0; i < suspects.length; i++) {
      if (!isNative(suspects[i])) return false;
    }
    return true;
  }

  /**
   * Injected-script leak.
   *
   * Scripts installed via Page.addScriptToEvaluateOnNewDocument execute with a
   * synthetic source URL. If any of them ends up on the stack when an error is
   * constructed, the filename leaks into the trace.
   */
  function stackLeak() {
    try {
      var stack = new Error('probe').stack || '';
      return /__puppeteer|__playwright|evaluateOnNewDocument|<anonymous>:1:1|injectedScript|__stealth/i.test(stack);
    } catch (e) {
      return false;
    }
  }

  function permissionsState(done) {
    if (!navigator.permissions || !navigator.permissions.query) return done(null);
    try {
      navigator.permissions
        .query({ name: 'notifications' })
        .then(function (status) { done(status && status.state ? status.state : null); })
        .catch(function () { done(null); });
    } catch (e) {
      done(null);
    }
  }

  function mediaDeviceKinds(done) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return done([]);
    try {
      navigator.mediaDevices
        .enumerateDevices()
        .then(function (devices) {
          var kinds = [];
          for (var i = 0; i < devices.length; i++) {
            if (kinds.indexOf(devices[i].kind) === -1) kinds.push(devices[i].kind);
          }
          done(kinds);
        })
        .catch(function () { done([]); });
    } catch (e) {
      done([]);
    }
  }

  function collectFingerprint(done) {
    var gl = webglInfo();
    var base = {
      webdriver: navigator.webdriver === true,
      automationKeys: automationKeys(),
      hasChromeObject: typeof window.chrome === 'object' && window.chrome !== null,
      hasChromeRuntime: !!(window.chrome && window.chrome.runtime),
      pluginCount: navigator.plugins ? navigator.plugins.length : 0,
      languages: navigator.languages ? Array.prototype.slice.call(navigator.languages) : [],
      notificationPermission: window.Notification ? Notification.permission : null,
      permissionsQueryState: null,
      webglVendor: gl.vendor,
      webglRenderer: gl.renderer,
      canvasHash: canvasHash(),
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      nativeToStringOk: nativeToStringOk(),
      stackLeak: stackLeak(),
      timezone: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'; }
        catch (e) { return 'unknown'; }
      })(),
      mediaDeviceKinds: [],
      hardwareConcurrency: navigator.hardwareConcurrency || 0,
      deviceMemory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
      userAgent: navigator.userAgent,
    };

    // Both async probes must land before we report, so a slow enumerateDevices does
    // not silently turn into "no devices" — which would be a false positive.
    var pending = 2;
    function maybeDone() { if (--pending === 0) done(base); }
    permissionsState(function (state) { base.permissionsQueryState = state; maybeDone(); });
    mediaDeviceKinds(function (kinds) { base.mediaDeviceKinds = kinds; maybeDone(); });
  }

  /* ------------------------------------------------------------------ *
   * Behaviour
   * ------------------------------------------------------------------ */

  var behavior = {
    mouse: [],
    clicks: [],
    keys: [],
    scrolls: [],
    firstInteractionDelayMs: null,
    ambientEvents: 0,
  };

  // Cap every buffer. An unbounded collector is a memory leak on a long session and a
  // trivial DoS on the endpoint that receives it.
  var MAX_SAMPLES = 400;

  function markFirstInteraction() {
    if (behavior.firstInteractionDelayMs === null) {
      behavior.firstInteractionDelayMs = Date.now() - loadedAt;
    }
  }

  // Sample pointer movement at ~60Hz rather than on every event: enough resolution to
  // measure curvature and a velocity profile, without shipping thousands of points.
  var lastMouseSample = 0;
  document.addEventListener('mousemove', function (e) {
    markFirstInteraction();
    var now = Date.now();
    if (now - lastMouseSample < 16) return;
    lastMouseSample = now;
    if (behavior.mouse.length < MAX_SAMPLES) {
      behavior.mouse.push({ x: e.clientX, y: e.clientY, t: now });
    }
  }, { passive: true, capture: true });

  document.addEventListener('mousedown', function (e) {
    markFirstInteraction();
    if (behavior.clicks.length < 50) {
      behavior.clicks.push({ x: e.clientX, y: e.clientY, t: Date.now() });
    }
  }, { passive: true, capture: true });

  document.addEventListener('keydown', function () {
    markFirstInteraction();
    if (behavior.keys.length < MAX_SAMPLES) behavior.keys.push(Date.now());
  }, { passive: true, capture: true });

  var lastScrollY = window.scrollY;
  document.addEventListener('scroll', function () {
    markFirstInteraction();
    var y = window.scrollY;
    if (behavior.scrolls.length < MAX_SAMPLES) {
      behavior.scrolls.push({ dy: y - lastScrollY, t: Date.now() });
    }
    lastScrollY = y;
  }, { passive: true, capture: true });

  ['focus', 'blur', 'visibilitychange', 'resize'].forEach(function (name) {
    window.addEventListener(name, function () { behavior.ambientEvents++; }, { passive: true });
  });

  /* ------------------------------------------------------------------ *
   * Reporting
   * ------------------------------------------------------------------ */

  var fingerprint = null;
  var inFlight = false;

  function report(reason) {
    if (!fingerprint || inFlight) return;
    inFlight = true;
    var body = JSON.stringify({ reason: reason, fingerprint: fingerprint, behavior: behavior });
    fetch(TELEMETRY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      credentials: 'same-origin',
      keepalive: true,
    })
      .then(function (res) { return res.json(); })
      .then(function (verdict) {
        window.__sentinelle = verdict;
        document.dispatchEvent(new CustomEvent('sentinelle:verdict', { detail: verdict }));
      })
      .catch(function () { /* telemetry is best-effort; never break the page over it */ })
      .then(function () { inFlight = false; });
  }

  collectFingerprint(function (fp) {
    fingerprint = fp;
    report('initial');
  });

  // Re-report as behaviour accumulates. The first report is nearly all fingerprint;
  // later ones are what let the behavioural layer actually say anything.
  setInterval(function () { report('interval'); }, 2500);
  document.addEventListener('submit', function () { report('submit'); }, { capture: true });
  window.addEventListener('beforeunload', function () { report('unload'); });
})();
