/**
 * Sentinelle — layer 1, transport inspection.
 *
 * Runs on every request, before any JavaScript executes. Cheap enough to apply
 * unconditionally, and sufficient on its own to reject the long tail of scrapers
 * that never open a browser at all.
 */

import type { Request } from 'express';
import type { Detection } from './scoring.js';

/**
 * Chrome's canonical request-header order for a top-level navigation.
 *
 * Chrome emits headers in a deterministic, build-specific order. HTTP client
 * libraries emit them in insertion or alphabetical order, and hand-rolled spoofers
 * almost always get this wrong because it is invisible in every debugging tool that
 * shows headers as a map. Order is one of the cheapest high-signal checks available
 * to a defender, which is precisely why it is worth knowing about as an attacker.
 */
const CHROME_HEADER_ORDER = [
  'host',
  'connection',
  'cache-control',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'user-agent',
  'accept',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'referer',
  'accept-encoding',
  'accept-language',
  'cookie',
];

const CANONICAL_RANK = new Map(CHROME_HEADER_ORDER.map((h, i) => [h, i]));

/**
 * Datacenter prefixes, stubbed.
 *
 * Production systems buy this as an IP intelligence feed: ASN lookup plus a
 * proxy/VPN/hosting reputation class, refreshed continuously. Modelling it as a
 * static prefix table keeps the demo hermetic — no network calls, deterministic
 * results — while preserving the property that matters: datacenter egress is
 * cheap and detectable, residential egress is expensive and is not.
 */
const DATACENTER_PREFIXES = ['3.', '13.', '18.', '34.', '35.', '52.', '54.', '104.', '167.'];

/**
 * RFC1918 and loopback, which must never be scored as hosting.
 *
 * This is not hypothetical tidiness — it was a live false positive. Inside Docker
 * the socket address is a bridge IP like `172.21.0.6`, and `172.` overlaps the
 * hosting ranges some providers use, so every client on the compose network was
 * being charged 20 points for its own container networking. The same bug in
 * production would score a corporate NAT or a reverse proxy as a datacenter bot.
 *
 * The general lesson: an IP-reputation check has to know what it cannot see. A
 * private address means the real client IP is somewhere else — in a header you have
 * chosen to trust, or nowhere at all — and the honest answer is to abstain.
 */
const PRIVATE_PREFIXES = ['10.', '127.', '169.254.', '192.168.', '::1', 'fc', 'fd'];

function isPrivate(ip: string): boolean {
  if (PRIVATE_PREFIXES.some((p) => ip.startsWith(p))) return true;
  // 172.16.0.0/12 — only the middle of the 172 block is private.
  const octets = ip.split('.');
  if (octets[0] === '172') {
    const second = Number(octets[1]);
    return Number.isFinite(second) && second >= 16 && second <= 31;
  }
  return false;
}

/** Longest increasing subsequence length — how much of the observed order is canonical. */
function lisLength(values: readonly number[]): number {
  const tails: number[] = [];
  for (const v of values) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((tails[mid] as number) <= v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
  }
  return tails.length;
}

export interface TransportContext {
  /** True when the per-IP token bucket rejected this request. */
  readonly rateLimited: boolean;
  /** Egress IP as seen by the site (X-Forwarded-For, or socket address). */
  readonly clientIp: string;
  /**
   * Whether this origin is a *secure context* by the browser's definition — HTTPS,
   * or localhost.
   *
   * This gate is not a detail, it is a correctness requirement. Chrome sends
   * `Sec-Fetch-*` and `Sec-CH-UA` **only** on trustworthy origins. On a plain-HTTP
   * origin it omits both, so scoring their absence there flags every real browser
   * that visits — a 100% false positive rate on exactly the users you cannot afford
   * to block.
   *
   * This was found by running the demo, not by reading the spec: the naive browser
   * profile was being charged 28 points for headers Chrome had structurally refused
   * to send. The general rule it illustrates is worth more than the specific fix —
   * **a detector must never score a client for something the client was not
   * permitted to do.**
   */
  readonly secureOrigin: boolean;
}

export function inspectTransport(req: Request, ctx: TransportContext): Detection[] {
  const at = Date.now();
  const out: Detection[] = [];
  const raise = (id: string, evidence: string) => out.push({ id, evidence, at });

  const headerNames: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headerNames.push((req.rawHeaders[i] as string).toLowerCase());
  }

  const ua = req.get('user-agent') ?? '';

  if (/headlesschrome/i.test(ua)) {
    raise('http.ua_headless', `UA contains HeadlessChrome: ${ua.slice(0, 90)}`);
  }

  // Only score order when we can see enough known headers to say anything meaningful.
  // Scoring a 3-header request would be noise, and noise in a bot detector costs customers.
  const ranked = headerNames.map((h) => CANONICAL_RANK.get(h)).filter((r): r is number => r !== undefined);
  if (ranked.length >= 6) {
    const inOrder = lisLength(ranked);
    const conformance = inOrder / ranked.length;
    if (conformance < 0.8) {
      raise(
        'http.header_order',
        `${Math.round(conformance * 100)}% of ${ranked.length} known headers in Chrome order`,
      );
    }
  }

  // A bare `*` counts as missing. Node's fetch sends `accept-language: *`, which is
  // technically a valid wildcard and something no consumer browser has ever sent —
  // browsers send a weighted locale list. Checking only for absence would let every
  // undici-based scraper through this signal.
  const acceptLanguage = req.get('accept-language');
  if (!acceptLanguage || acceptLanguage.trim() === '' || acceptLanguage.trim() === '*') {
    raise('http.missing_accept_language', `Accept-Language is ${acceptLanguage ? `'${acceptLanguage}'` : 'absent'}`);
  }

  // Client Hints must agree with the UA string. Spoofers routinely rewrite one and
  // forget the other — the resulting self-contradiction is stronger evidence than
  // either header alone, because no real build can produce it.
  //
  // Only meaningful on a secure origin: see TransportContext.secureOrigin.
  const chUa = req.get('sec-ch-ua');
  if (!ctx.secureOrigin) {
    // Deliberately silent. Nothing to say about hints the browser was never going
    // to send.
  } else if (chUa && ua) {
    const uaMajor = /Chrome\/(\d+)/.exec(ua)?.[1];
    const hintMajors = [...chUa.matchAll(/"v="?(\d+)"?/g)].map((m) => m[1]);
    const brandMajors = [...chUa.matchAll(/;v="(\d+)"/g)].map((m) => m[1]);
    const declared = new Set([...hintMajors, ...brandMajors].filter(Boolean) as string[]);
    if (uaMajor && declared.size > 0 && !declared.has(uaMajor)) {
      raise('http.ch_ua_mismatch', `UA says Chrome/${uaMajor}, Sec-CH-UA says ${[...declared].join(',')}`);
    }
  } else if (!chUa && /Chrome\/\d+/.test(ua)) {
    raise('http.ch_ua_mismatch', 'Chrome UA with no Sec-CH-UA at all');
  }

  // Fetch Metadata is attached by the browser itself, not by page script, so it
  // cannot be faked from inside the page — only by the client that opens the
  // connection.
  //
  // The check is for a *complete* set, not merely a non-empty one. Node's fetch
  // sends `sec-fetch-mode` and nothing else; Chrome sends site, mode and dest on
  // every request and adds `sec-fetch-user` on user-initiated navigations. A partial
  // set is its own signature — it says "something implemented enough of the header
  // family to look browser-like, and stopped".
  const fetchMetadata = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].filter((h) => req.get(h));
  if (fetchMetadata.length > 0 && fetchMetadata.length < 3) {
    // A partial set is diagnostic on *any* origin: a browser that is allowed to send
    // Fetch Metadata sends all of it, and one that is not sends none. Only something
    // hand-rolling headers produces exactly one of the three.
    raise('http.no_sec_fetch', `partial Fetch Metadata: only ${fetchMetadata.join(', ')}`);
  } else if (ctx.secureOrigin && fetchMetadata.length === 0 && req.accepts('html') === 'html') {
    raise('http.no_sec_fetch', 'HTML request carries no Sec-Fetch-* metadata at all');
  }

  const encoding = req.get('accept-encoding') ?? '';
  if (encoding && !/\bbr\b/.test(encoding)) {
    raise('http.accept_encoding_narrow', `Accept-Encoding lacks br: ${encoding}`);
  }

  if (ctx.rateLimited) {
    raise('http.rate_exceeded', `Token bucket exhausted for ${ctx.clientIp}`);
  }

  // Abstain on private addresses rather than guessing — see isPrivate() above.
  if (!isPrivate(ctx.clientIp) && DATACENTER_PREFIXES.some((p) => ctx.clientIp.startsWith(p))) {
    raise('http.datacenter_asn', `${ctx.clientIp} is in a hosting range`);
  }

  return out;
}
