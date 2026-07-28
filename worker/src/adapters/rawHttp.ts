/**
 * The no-browser baseline.
 *
 * Included because it is what most people mean by "scraper", and because without it
 * the transport layer of the detector looks decorative. This profile never opens
 * Chrome — it posts forms with `fetch`, the way a Python `requests` script would.
 *
 * It exists to make one number legible: how much of the detection budget is spent
 * before a single line of JavaScript runs. Header order, Client Hints coherence,
 * Fetch Metadata and Accept-Language are all decided at connection time, and this
 * profile fails every one of them without the fingerprint or behavioural layers
 * needing to contribute anything.
 */

import { logger } from '../logger.js';
import type { PublishJob, PublishOutcome } from './vitrine.js';

/** Whatever cookies the site set, kept across requests so the login survives. */
class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(response: Response): void {
    // getSetCookie() is the correct accessor: multiple Set-Cookie headers must not be
    // folded into one string, which is what response.headers.get() would do.
    const raw =
      typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [response.headers.get('set-cookie')].filter((v): v is string => Boolean(v));

    for (const cookie of raw) {
      const pair = cookie.split(';')[0];
      if (!pair) continue;
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      this.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export async function rawHttpPublish(job: PublishJob, baseUrl: string, credentials: { email: string; password: string }): Promise<PublishOutcome> {
  const jar = new CookieJar();

  // Deliberately unadorned. A UA string and nothing else — no Client Hints, no
  // Fetch Metadata, no brotli, and whatever header order the runtime happens to use.
  //
  // The egress IP is declared so this profile is compared on equal footing with the
  // browser ones: a scraper like this runs on a server, so it gets datacenter space.
  // Without it the socket address would be the container's own bridge IP, and the
  // comparison would be measuring Docker's networking rather than the client.
  const headers = () => ({
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'x-forwarded-for': '34.148.72.19',
    cookie: jar.header(),
  });

  try {
    // Follow redirects by hand rather than with `redirect: 'follow'`.
    //
    // `fetch` has no cookie jar, so an automatic redirect drops the session cookie
    // and the interstitial lands in a *different* session from the one that was
    // challenged — which is both unrealistic (every real scraper keeps a jar) and
    // misleading, since the detector then sees two half-sessions instead of one
    // client's whole story.
    //
    // Following it manually also gets the client a page carrying the probe script,
    // which it duly retrieves and never executes. That is exactly what
    // `probe.silent` measures.
    const home = await follow(`${baseUrl}/`, jar, headers);
    if (home.status === 403) return await asBlocked(home);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: credentials.email, password: credentials.password }),
      redirect: 'manual',
    });
    jar.absorb(login);
    if (login.status === 403) return await asBlocked(login);

    const publish = await fetch(`${baseUrl}/api/listings`, {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        title: job.title,
        brand: job.brand,
        size: job.size,
        condition: job.condition,
        price: job.priceEur,
        description: job.description,
      }),
      redirect: 'manual',
    });
    jar.absorb(publish);

    if (publish.status === 403) return await asBlocked(publish);
    if (publish.status === 401) {
      const body = (await publish.json().catch(() => ({}))) as { score?: number };
      return { kind: 'challenged', solved: false, score: body.score ?? -1, verdict: 'challenge' };
    }
    if (!publish.ok) {
      return { kind: 'failed', error: `publish returned ${publish.status}` };
    }

    const created = (await publish.json()) as { id: string };
    const score = Number(publish.headers.get('x-sentinelle-score') ?? 0);
    return {
      kind: 'published',
      marketplaceId: created.id,
      score,
      verdict: publish.headers.get('x-sentinelle-verdict') ?? 'allow',
    };
  } catch (err) {
    logger.error({ err }, 'raw-http publish failed');
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * GET a URL, following redirects while carrying the cookie jar forward.
 *
 * Capped at five hops: a redirect loop is a hang, and a hang in a scraper is worse
 * than an error because nothing reports it.
 */
async function follow(
  url: string,
  jar: CookieJar,
  headers: () => Record<string, string>,
  maxHops = 5,
): Promise<Response> {
  let current = url;

  for (let hop = 0; hop < maxHops; hop++) {
    const response = await fetch(current, { headers: headers(), redirect: 'manual' });
    jar.absorb(response);

    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;

    current = new URL(location, current).toString();
  }

  throw new Error(`too many redirects starting at ${url}`);
}

async function asBlocked(response: Response): Promise<PublishOutcome> {
  const body = (await response.json().catch(() => ({}))) as { score?: number; reasons?: string[] };
  return {
    kind: 'blocked',
    score: body.score ?? Number(response.headers.get('x-sentinelle-score') ?? 0),
    verdict: 'block',
    reasons: body.reasons ?? ['blocked before any JavaScript ran'],
  };
}
