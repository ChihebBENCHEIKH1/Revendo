/**
 * Identities and egress.
 *
 * The central idea: **an identity is coherent or it is nothing.**
 *
 * A scraper that spoofs its User-Agent to macOS Safari while `navigator.platform`
 * says Linux, the Client Hints say Chromium on Windows, the timezone says UTC and
 * the exit IP is in Lyon has not disguised itself — it has produced a combination no
 * real device can produce, which is *more* identifiable than the honest headless
 * browser it started as. Sentinelle's `fp.timezone_mismatch` and
 * `http.ch_ua_mismatch` exist to make exactly that point.
 *
 * So identities are generated as whole personas: UA, platform, Client Hints, locale,
 * timezone, GPU strings, hardware and viewport all drawn together and never mixed.
 *
 * Egress is simulated with X-Forwarded-For rather than real upstream proxies, so the
 * demo runs offline with no credentials. The seam is real though: `Identity.proxyUrl`
 * is threaded through to `Target.createBrowserContext({ proxyServer })`, which is how
 * this works against a live target. What the simulation preserves is the property
 * that actually drives the economics — datacenter egress is cheap and detectable,
 * residential egress is expensive and is not.
 */

import type Redis from 'ioredis';
import { Rng } from '../behavior/rng.js';

export interface Identity {
  readonly label: string;
  readonly userAgent: string;
  readonly acceptLanguage: string;
  readonly platform: string;
  readonly timezoneId: string;
  readonly egressIp: string;
  readonly residential: boolean;
  readonly viewport: { width: number; height: number; deviceScaleFactor: number };
  /**
   * The physical display the window sits on.
   *
   * Distinct from the viewport, and the distinction is load-bearing: a viewport
   * larger than its own screen is impossible, and headless Chrome reports an 800x600
   * screen no matter how large you make the window. The offsets place the window
   * somewhere plausible on that display rather than pinned to the corner.
   */
  readonly screen: { width: number; height: number; positionX: number; positionY: number };
  readonly hardwareConcurrency: number;
  readonly deviceMemory: number;
  readonly webgl: { vendor: string; renderer: string };
  /** Passed to Network.setUserAgentOverride so Sec-CH-UA agrees with the UA string. */
  readonly uaMetadata: {
    brands: { brand: string; version: string }[];
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
  };
  /** Real upstream proxy, when running against a live target. Null in the offline demo. */
  readonly proxyUrl: string | null;
}

interface Persona {
  readonly label: string;
  readonly chromeMajor: string;
  readonly fullVersion: string;
  readonly ua: string;
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly acceptLanguage: string;
  readonly timezoneId: string;
  readonly viewports: readonly { width: number; height: number; deviceScaleFactor: number }[];
  readonly cores: readonly number[];
  readonly memory: readonly number[];
  readonly webgl: { vendor: string; renderer: string };
}

/**
 * Personas are whole devices, not a menu of independent attributes.
 *
 * Each one is a real, common configuration: a MacBook on French locale, a Windows
 * desktop, a Linux laptop. Rare combinations are worse than common ones — the goal
 * is to be unremarkable, and a fingerprint that is unique is a fingerprint that can
 * be followed across sessions.
 */
const PERSONAS: readonly Persona[] = [
  {
    label: 'macbook-pro-fr',
    chromeMajor: '126',
    fullVersion: '126.0.6478.127',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'macOS',
    platformVersion: '14.5.0',
    architecture: 'arm',
    acceptLanguage: 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    timezoneId: 'Europe/Paris',
    viewports: [
      { width: 1512, height: 858, deviceScaleFactor: 2 },
      { width: 1440, height: 810, deviceScaleFactor: 2 },
    ],
    cores: [8, 10, 12],
    memory: [8, 16],
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
  },
  {
    label: 'windows-desktop-fr',
    chromeMajor: '126',
    fullVersion: '126.0.6478.127',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Windows',
    platformVersion: '15.0.0',
    architecture: 'x86',
    acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8',
    timezoneId: 'Europe/Paris',
    viewports: [
      { width: 1920, height: 969, deviceScaleFactor: 1 },
      { width: 1536, height: 776, deviceScaleFactor: 1.25 },
    ],
    cores: [8, 12, 16],
    memory: [8, 16, 32],
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  },
  {
    label: 'linux-laptop-fr',
    chromeMajor: '125',
    fullVersion: '125.0.6422.141',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform: 'Linux',
    platformVersion: '6.8.0',
    architecture: 'x86',
    acceptLanguage: 'fr-FR,fr;q=0.9,en-GB;q=0.8',
    timezoneId: 'Europe/Brussels',
    viewports: [{ width: 1600, height: 869, deviceScaleFactor: 1 }],
    cores: [4, 8],
    memory: [8, 16],
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) Graphics (ADL GT2), OpenGL 4.6)' },
  },
];

/** French consumer ISP ranges — what residential egress looks like to the target. */
const RESIDENTIAL_PREFIXES = ['78.', '82.', '86.', '90.', '92.', '176.', '193.'];
/** Cloud ranges — cheap, plentiful, and exactly what `http.datacenter_asn` is watching for. */
const DATACENTER_PREFIXES = ['3.', '13.', '34.', '52.', '104.', '167.'];

export interface PoolOptions {
  /** false → datacenter egress, which is what you get before you pay for residential. */
  readonly residential: boolean;
  readonly seed?: string;
}

export class IdentityPool {
  private readonly rng: Rng;

  constructor(
    private readonly opts: PoolOptions,
    private readonly redis?: Redis,
  ) {
    this.rng = new Rng(opts.seed);
  }

  private randomIp(residential: boolean): string {
    const prefixes = residential ? RESIDENTIAL_PREFIXES : DATACENTER_PREFIXES;
    const prefix = this.rng.pick(prefixes);
    return `${prefix}${this.rng.int(1, 254)}.${this.rng.int(1, 254)}.${this.rng.int(2, 253)}`;
  }

  mint(): Identity {
    const p = this.rng.pick(PERSONAS);
    const residential = this.opts.residential;
    const viewport = this.rng.pick(p.viewports);

    // A display that comfortably contains the window, from the handful of sizes that
    // actually dominate real traffic. A 1920x1080 laptop is unremarkable; a
    // 1921x1083 one is a fingerprint.
    const screenSize = this.rng.pick(
      [
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 },
        { width: 1512, height: 982 },
      ].filter((s) => s.width >= viewport.width && s.height >= viewport.height),
    ) ?? { width: 2560, height: 1440 };

    return {
      label: p.label,
      userAgent: p.ua,
      acceptLanguage: p.acceptLanguage,
      platform: p.platform,
      // A datacenter identity is left on UTC on purpose: it is what an unconfigured
      // container actually reports, and it is what trips fp.timezone_mismatch.
      timezoneId: residential ? p.timezoneId : 'UTC',
      egressIp: this.randomIp(residential),
      residential,
      viewport,
      screen: {
        ...screenSize,
        positionX: this.rng.int(0, Math.max(0, screenSize.width - viewport.width)),
        positionY: this.rng.int(0, Math.max(0, screenSize.height - viewport.height - 90)),
      },
      hardwareConcurrency: this.rng.pick(p.cores),
      deviceMemory: this.rng.pick(p.memory),
      webgl: p.webgl,
      uaMetadata: {
        // Chrome's GREASE brand: a deliberately meaningless entry Chrome includes so
        // servers cannot hardcode the list. Omitting it is itself a tell.
        brands: [
          { brand: 'Not/A)Brand', version: '8' },
          { brand: 'Chromium', version: p.chromeMajor },
          { brand: 'Google Chrome', version: p.chromeMajor },
        ],
        fullVersion: p.fullVersion,
        platform: p.platform,
        platformVersion: p.platformVersion,
        architecture: p.architecture,
        model: '',
        mobile: false,
      },
      proxyUrl: null,
    };
  }

  /**
   * Sticky identity for a logical account.
   *
   * A seller who logged in from a MacBook in Paris on Tuesday and a Windows desktop
   * in Frankfurt on Wednesday is a compromised account by any reasonable heuristic.
   * Identity has to be pinned to the *account*, not to the request — which is why
   * this is stored, and why it is stored centrally rather than per worker.
   */
  async forAccount(accountId: string, ttlSeconds = 3600): Promise<Identity> {
    if (!this.redis) return this.mint();

    const key = `revendo:identity:${accountId}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as Identity;

    const identity = this.mint();
    // NX so two workers racing on the same account converge on one identity rather
    // than each overwriting the other's.
    const stored = await this.redis.set(key, JSON.stringify(identity), 'EX', ttlSeconds, 'NX');
    if (stored === null) {
      const winner = await this.redis.get(key);
      if (winner) return JSON.parse(winner) as Identity;
    }
    return identity;
  }

  /** Burn an identity after a block. Anything that shared its IP is burned with it. */
  async retire(accountId: string): Promise<void> {
    await this.redis?.del(`revendo:identity:${accountId}`);
  }
}
