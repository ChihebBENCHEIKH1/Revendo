/**
 * Header ordering.
 *
 * Chrome puts request headers on the wire in a stable, build-specific order. HTTP
 * client libraries emit them in insertion or alphabetical order, and most spoofing
 * code never touches order at all — because every tool a developer uses to inspect
 * headers (devtools, curl -v, a framework's `headers` object) displays them as an
 * unordered map, so the signal is invisible right up until a defender uses it.
 *
 * This is the concrete reason the worker speaks raw CDP.
 * `Fetch.continueRequest` accepts an **ordered array** of header entries;
 * higher-level automation APIs expose headers as a dictionary, and a dictionary has
 * thrown the information away before you ever see it.
 */

/** Chrome's canonical navigation header order. */
export const CHROME_HEADER_ORDER: readonly string[] = [
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

export interface HeaderEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * Sort headers into Chrome's canonical order.
 *
 * Headers Chrome does not generate itself keep their relative order and go last,
 * which is where Chrome puts them too. Stable within each group: two unknown headers
 * never swap places between calls, because an ordering that is *itself* unstable is
 * a signal.
 */
export function orderHeaders(headers: Record<string, string>): HeaderEntry[] {
  const rank = new Map(CHROME_HEADER_ORDER.map((h, i) => [h, i]));
  return Object.entries(headers)
    .map(([name, value], index) => ({ name, value, index }))
    .sort((a, b) => {
      const ra = rank.get(a.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || a.index - b.index;
    })
    .map(({ name, value }) => ({ name, value }));
}
