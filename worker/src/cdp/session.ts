/**
 * A single browsing identity, driven over raw CDP.
 *
 * Deliberately not Playwright or Puppeteer. Three reasons, in order of how much they
 * actually matter:
 *
 *  1. **Header order.** `Fetch.continueRequest` takes an *ordered array* of headers,
 *     which is the only way to control the exact order Chrome puts on the wire.
 *     High-level APIs expose headers as a map, and a map has no order. Since header
 *     order is one of the cheapest signals a defender has, giving it up to save a few
 *     lines is a bad trade.
 *  2. **Input fidelity.** `Input.dispatchMouseEvent` at a chosen coordinate and a
 *     chosen timestamp is the substrate the whole behaviour engine is built on.
 *     `page.click()` is the thing we are specifically trying not to do.
 *  3. **Surface control.** Frameworks add their own flags, their own injected
 *     bindings and their own bridge objects, each of which is a detectable artefact
 *     you did not choose and cannot easily remove.
 *
 * One `Session` owns one browser *context* — Chrome's incognito-like partition, with
 * its own cookie jar, storage and cache. That is the unit of identity: contexts are
 * cheap, processes are not, so a fleet runs many contexts per browser rather than
 * many browsers.
 */

import CDP from 'chrome-remote-interface';
import type { Identity } from '../proxy/pool.js';
import { logger } from '../logger.js';
import { orderHeaders } from './headerOrder.js';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SessionOptions {
  readonly port: number;
  readonly identity: Identity;
  /** JS evaluated in every new document, before any page script. Null for the naive profile. */
  readonly bootstrapScript: string | null;
  /** When true, requests are intercepted and re-emitted in Chrome's canonical header order. */
  readonly normalizeHeaderOrder: boolean;
  readonly viewport: { width: number; height: number; deviceScaleFactor: number };
  /**
   * Apply the identity's UA, locale and timezone via CDP overrides.
   *
   * False for the naive profile, which must report the browser's true self —
   * HeadlessChrome UA, container timezone and all. The control in an experiment has
   * to stay uncontrolled or the experiment measures nothing.
   */
  readonly applyIdentityOverrides: boolean;
}

type CdpClient = Awaited<ReturnType<typeof CDP>>;

export class Session {
  private constructor(
    private readonly browser: CdpClient,
    private readonly client: CdpClient,
    private readonly browserContextId: string,
    readonly identity: Identity,
    readonly viewport: SessionOptions['viewport'],
  ) {}

  static async open(opts: SessionOptions): Promise<Session> {
    // Connect to the **browser** endpoint, not a page.
    //
    // `CDP({port})` attaches to the first page target, where browser-scoped commands
    // are rejected with a bare `Not allowed`. Target.createBrowserContext — the
    // command that creates an isolated identity — is browser-scoped, so it needs the
    // websocket from /json/version. This distinction is invisible in the protocol
    // docs and is the first wall you hit driving CDP directly.
    const { webSocketDebuggerUrl } = (await CDP.Version({ port: opts.port })) as {
      webSocketDebuggerUrl: string;
    };
    const browser = await CDP({ target: webSocketDebuggerUrl });

    // A fresh browser context per identity. Cookies, storage and cache do not leak
    // between them, so two "people" browsing from one Chrome stay two people.
    const { browserContextId } = await browser.Target.createBrowserContext({
      disposeOnDetach: false,
    });
    const { targetId } = await browser.Target.createTarget({
      url: 'about:blank',
      browserContextId,
    });

    const client = await CDP({ port: opts.port, target: targetId });
    const { Page, Runtime, Network, Emulation } = client;

    await Promise.all([Page.enable(), Runtime.enable(), Network.enable({})]);

    // Give the page a plausible consumer viewport. Doing it through Emulation rather
    // than JS means innerWidth/innerHeight are genuinely correct rather than lied
    // about — nothing to detect because nothing was patched.
    // screenWidth/screenHeight are not optional extras.
    //
    // setDeviceMetricsOverride without them sets the *viewport* and leaves
    // `screen.width`/`screen.height` at the headless default of 800x600 — so a
    // 1920-wide window reports itself as living on an 800-wide display. That is
    // `fp.screen_impossible`, and it fired on the stealth profile until this was
    // added. Overriding here rather than patching `screen` in JS means the values
    // are genuinely consistent instead of merely claimed to be.
    await Emulation.setDeviceMetricsOverride({
      width: opts.viewport.width,
      height: opts.viewport.height,
      deviceScaleFactor: opts.viewport.deviceScaleFactor,
      mobile: false,
      screenWidth: opts.identity.screen.width,
      screenHeight: opts.identity.screen.height,
      positionX: opts.identity.screen.positionX,
      positionY: opts.identity.screen.positionY,
    });

    if (opts.applyIdentityOverrides) {
      // setUserAgentOverride carries acceptLanguage and platform too. Setting all
      // three together is the point: a UA that says macOS while platform says Linux
      // is worse than not spoofing at all.
      await Network.setUserAgentOverride({
        userAgent: opts.identity.userAgent,
        acceptLanguage: opts.identity.acceptLanguage,
        platform: opts.identity.platform,
        userAgentMetadata: opts.identity.uaMetadata,
      });

      // Timezone and locale at the CDP layer rather than by patching Intl. This gives
      // the page a genuinely different clock — Date, Intl and everything downstream
      // agree — instead of a lie that only holds until someone cross-checks
      // Date.prototype.getTimezoneOffset against Intl.DateTimeFormat.
      //
      // Not every Chrome build exposes these; a missing override is a smaller problem
      // than a session that refuses to start, so they degrade rather than throw.
      await Emulation.setTimezoneOverride({ timezoneId: opts.identity.timezoneId }).catch((err: unknown) =>
        logger.debug({ err }, 'setTimezoneOverride unsupported'),
      );
      await Emulation.setLocaleOverride({
        locale: opts.identity.acceptLanguage.split(',')[0],
      }).catch((err: unknown) => logger.debug({ err }, 'setLocaleOverride unsupported'));
    }

    if (opts.bootstrapScript) {
      // Runs before any page script in every new document, including iframes. This is
      // the only reliable injection point: a script added after load has already lost
      // the race to whatever the page read at parse time.
      await Page.addScriptToEvaluateOnNewDocument({ source: opts.bootstrapScript });
    }

    const session = new Session(browser, client, browserContextId, opts.identity, opts.viewport);

    if (opts.normalizeHeaderOrder) {
      await session.installHeaderNormalizer();
    } else if (opts.identity.egressIp) {
      // Even without ordering we still need the simulated egress IP on the wire.
      await Network.setExtraHTTPHeaders({ headers: { 'x-forwarded-for': opts.identity.egressIp } });
    }

    return session;
  }

  /**
   * Intercept every request and re-emit its headers in Chrome's canonical order.
   *
   * Once Fetch is enabled, *every* request is paused until we answer it — a handler
   * that throws does not fail one image, it hangs the page. Hence the catch-all and
   * the unconditional continueRequest in the failure path.
   */
  private async installHeaderNormalizer(): Promise<void> {
    const { Fetch } = this.client;
    const egressIp = this.identity.egressIp;

    Fetch.requestPaused(async ({ requestId, request }) => {
      try {
        const merged: Record<string, string> = { ...request.headers };
        if (egressIp) merged['x-forwarded-for'] = egressIp;

        // Fill in what a real navigation always carries. Chrome sets most of these
        // itself; the ones it omits under automation are exactly the ones worth adding.
        merged['accept-language'] ??= this.identity.acceptLanguage;
        merged['accept-encoding'] ??= 'gzip, deflate, br, zstd';

        const ordered = orderHeaders(merged);
        await Fetch.continueRequest({ requestId, headers: ordered });
      } catch (err) {
        logger.debug({ err }, 'header normalizer failed; continuing request unmodified');
        await Fetch.continueRequest({ requestId }).catch(() => {});
      }
    });

    await Fetch.enable({ patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }

  /** Navigate and wait for the load event. Returns the final HTTP status. */
  async navigate(url: string, timeoutMs = 30_000): Promise<number> {
    const { Page, Network } = this.client;

    let status = 0;
    const onResponse = ({ type, response }: { type: string; response: { status: number } }) => {
      // Only the document response is the page's status; subresources would clobber it.
      if (type === 'Document') status = response.status;
    };
    Network.responseReceived(onResponse);

    const loaded = Page.loadEventFired();
    await Page.navigate({ url });

    await Promise.race([
      loaded,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`navigation to ${url} timed out`)), timeoutMs),
      ),
    ]);

    return status;
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(`page evaluate failed: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
    }
    return result.value as T;
  }

  /**
   * Viewport-relative rect of the first element matching `selector`, or null.
   *
   * getBoundingClientRect rather than DOM.getBoxModel: box model coordinates are
   * relative to the layout viewport and need scroll compensation, whereas
   * `Input.dispatchMouseEvent` wants viewport coordinates — which is precisely what
   * getBoundingClientRect already returns. Fewer conversions, fewer off-by-scroll bugs.
   */
  async rectOf(selector: string): Promise<Rect | null> {
    return this.evaluate<Rect | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
  }

  /** Poll until `selector` exists and has a box, or throw. */
  async waitForSelector(selector: string, timeoutMs = 10_000): Promise<Rect> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rect = await this.rectOf(selector);
      if (rect) return rect;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`selector not found within ${timeoutMs}ms: ${selector}`);
  }

  async dispatchMouse(params: {
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
    x: number;
    y: number;
    button?: 'none' | 'left';
    buttons?: number;
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
  }): Promise<void> {
    await this.client.Input.dispatchMouseEvent({
      button: 'none',
      buttons: 0,
      clickCount: 0,
      ...params,
    });
  }

  async dispatchKey(params: {
    type: 'keyDown' | 'keyUp' | 'char';
    text?: string;
    key?: string;
    code?: string;
    windowsVirtualKeyCode?: number;
    nativeVirtualKeyCode?: number;
    /** Editing commands (`deleteBackward`, `selectAll`, …) — required for keys that mutate text. */
    commands?: string[];
  }): Promise<void> {
    await this.client.Input.dispatchKeyEvent(params);
  }

  /** Current scroll offset, needed to convert page coordinates to viewport ones. */
  async scrollY(): Promise<number> {
    return this.evaluate<number>('window.scrollY');
  }

  /**
   * Change the emulated viewport, producing a **real** resize event.
   *
   * This is why it goes through CDP instead of `window.dispatchEvent(new Event(...))`:
   * a synthetic event has `isTrusted === false`, and a detector that checks
   * `isTrusted` catches the fake instantly. Anything that must look like user or
   * browser input has to originate outside the page — from the protocol — or it is
   * worse than not doing it at all.
   */
  async resizeViewport(width: number, height: number): Promise<void> {
    // The screen parameters must be repeated on every call.
    //
    // setDeviceMetricsOverride replaces the whole override rather than patching it,
    // so omitting screenWidth/screenHeight here silently reverts the display to
    // headless Chrome's 800x600 default — and the next ambient resize turns a
    // perfectly coherent identity into a 1920-wide window on an 800-wide screen.
    // The stealth profile was scoring 16 points for exactly this, produced by its
    // own realism code.
    await this.client.Emulation.setDeviceMetricsOverride({
      width,
      height,
      deviceScaleFactor: this.viewport.deviceScaleFactor,
      mobile: false,
      screenWidth: this.identity.screen.width,
      screenHeight: this.identity.screen.height,
      positionX: this.identity.screen.positionX,
      positionY: this.identity.screen.positionY,
    });
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.client.Page.captureScreenshot({ format: 'png' });
    return Buffer.from(data, 'base64');
  }

  /** Sentinelle's own verdict, as reported back to the page by the telemetry endpoint. */
  async sentinelleVerdict(): Promise<{ score: number; verdict: string } | null> {
    return this.evaluate<{ score: number; verdict: string } | null>('window.__sentinelle || null');
  }

  async currentUrl(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  async close(): Promise<void> {
    // Disposing the context tears down the tab, its storage and its cookie jar in one
    // step. Closing only the target would leak the context, and a worker that leaks
    // contexts eventually leaks the whole browser.
    await this.client.close().catch(() => {});
    await this.browser.Target.disposeBrowserContext({ browserContextId: this.browserContextId }).catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
