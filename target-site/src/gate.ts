/**
 * The Sentinelle gate — the request path where detection becomes a decision.
 *
 * Two responsibilities, deliberately kept separate:
 *
 *   1. `attachSession` runs on *every* request. It identifies the session, applies
 *      the rate limit, runs transport inspection and accumulates evidence. It never
 *      blocks anything.
 *   2. `enforce` runs only on protected routes and turns accumulated evidence into
 *      allow / challenge / block.
 *
 * Splitting them matters. Telemetry and static assets must keep being *observed*
 * even for a session we have already decided to block — otherwise blocking blinds
 * the detector, and we lose the evidence trail that justifies the decision. It also
 * makes MONITOR_ONLY a one-line change instead of a special case threaded through
 * every route.
 */

import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { inspectTransport } from './sentinelle/transport.js';
import { signalSpec, type SignalLayer } from './sentinelle/catalog.js';
import { combine, type Detection } from './sentinelle/scoring.js';
import type { SentinelleStore, SessionRecord } from './sentinelle/store.js';

const COOKIE_NAME = 'vitrine_sid';

/** Paths that must never create or mutate a session. */
const OBSERVABILITY_PATHS = ['/healthz', '/__sentinelle'];

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sentinelle: {
        session: SessionRecord;
        clientIp: string;
      };
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Egress IP as the site sees it.
 *
 * X-Forwarded-For is trusted here because in this topology the only thing that sets
 * it is our own simulated proxy layer. In production trusting XFF unconditionally is
 * an IP-spoofing hole — you trust it only from known proxy hops. Calling that out
 * because a rate limiter keyed on a header the client controls is not a rate limiter.
 */
function clientIpOf(req: Request): string {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return (req.socket.remoteAddress ?? '0.0.0.0').replace(/^::ffff:/, '');
}

export function attachSession(store: SentinelleStore) {
  return async function attachSessionMiddleware(req: Request, res: Response, next: NextFunction) {
    // Health probes and the operator console are not traffic. Without this exemption
    // the container healthcheck mints a session every three seconds, and the console
    // fills with its own monitoring — which is both noise and, in a real deployment,
    // a slow leak of session records with no user behind them.
    if (OBSERVABILITY_PATHS.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      return next();
    }

    try {
      const cookies = parseCookies(req.get('cookie'));
      const sessionId = cookies[COOKIE_NAME] ?? randomUUID();
      const clientIp = clientIpOf(req);

      if (!cookies[COOKIE_NAME]) {
        res.cookie?.(COOKIE_NAME, sessionId, { httpOnly: true, sameSite: 'lax', path: '/' });
        res.setHeader('set-cookie', `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
      }

      const existing = await store.loadSession(sessionId);
      const session: SessionRecord = existing ?? {
        id: sessionId,
        ip: clientIp,
        userAgent: req.get('user-agent') ?? '',
        createdAt: Date.now(),
        detections: [],
      };

      // Rate limit is keyed on egress IP, not session: rotating cookies is free,
      // rotating residential IPs is not. Static assets are exempt so that a single
      // page view does not spend a whole budget on its own images.
      const isAsset = /\.(?:css|js|png|jpe?g|svg|ico|woff2?)$/.test(req.path);
      const rateLimited = isAsset ? false : !(await store.takeToken(
        clientIp,
        config.RATE_CAPACITY,
        config.RATE_REFILL_PER_SECOND,
      ));

      const fresh = inspectTransport(req, {
        rateLimited,
        clientIp,
        // Matches the browser's own "potentially trustworthy origin" rule, which is
        // what gates whether Sec-Fetch-* and Client Hints are sent at all.
        secureOrigin:
          req.secure || req.hostname === 'localhost' || req.hostname === '127.0.0.1',
      });
      mergeDetections(session, fresh);

      req.sentinelle = { session, clientIp };

      // Count HTML responses on the way out. Every page carries the probe, so this is
      // the denominator for "did this session ever run our script" — see
      // inspectProbeSilence. Hooked on `finish` rather than tracked per route so a
      // new HTML route cannot forget to opt in.
      res.on('finish', () => {
        const type = res.getHeader('content-type');
        let changed = false;

        if (typeof type === 'string' && type.includes('text/html')) {
          session.htmlServed = (session.htmlServed ?? 0) + 1;
          changed = true;
        }
        // The probe fetch is the proof that an HTML parser ran — see
        // inspectProbeSilence. Counted here rather than in a route so it stays true
        // however the static middleware is reorganised.
        if (req.path === '/probe.js' && res.statusCode < 400) {
          session.probeFetched = (session.probeFetched ?? 0) + 1;
          changed = true;
        }

        if (changed) void store.saveSession(session);
      });

      await store.saveSession(session);
      next();
    } catch (err) {
      // A detector that fails closed takes the whole site down with it. Fail open,
      // and make sure the failure is loud in the logs instead.
      logger.error({ err }, 'sentinelle: session attach failed, failing open');
      next();
    }
  };
}

/**
 * Was this session ever a browser at all?
 *
 * This is the check that separates "browser" from "HTTP client that read a blog post
 * about headers". Every page Vitrine serves carries `<script src="/probe.js">`. A
 * client that parses HTML fetches it; a client that treats the response as a string
 * does not. No amount of header formatting substitutes for having an HTML parser.
 *
 * ## Why the discriminator is the script fetch and not something cleverer
 *
 * Two earlier versions of this check were wrong, both in the same way, and both only
 * showed up by running the demo:
 *
 *  - **"No telemetry yet"** flags a fast browser that navigates again before its
 *    first telemetry POST lands. A race, tunable only with a grace period that is
 *    either too short (false positives) or too long (raw-http finishes in 0.1s and
 *    slips under it).
 *  - **"No Sec-Fetch metadata"** looked timing-independent and was worse: Chrome does
 *    not send Sec-Fetch on a plain-HTTP origin *at all*, so on this deployment every
 *    real browser looked programmatic and scored 40 points for it.
 *
 * Fetching a subresource is neither racy nor origin-dependent. It happens during page
 * load, before anything the client does next, and it is the same on HTTP and HTTPS.
 *
 * The signal is deliberately about *fetching* rather than *executing*. Fetching
 * proves an HTML parser ran, which is already conclusive, and it avoids penalising
 * the narrow case of a real browser whose telemetry POST failed in flight.
 */
export function inspectProbeSilence(_req: Request, session: SessionRecord): Detection[] {
  const servedHtml = (session.htmlServed ?? 0) > 0;
  const fetchedProbe = (session.probeFetched ?? 0) > 0;

  // A session that has not been served a page has nothing to be silent about, so a
  // first request is never penalised.
  if (servedHtml && !fetchedProbe) {
    return [
      {
        id: 'probe.silent',
        evidence: `${session.htmlServed} page(s) served, probe.js never requested`,
        at: Date.now(),
      },
    ];
  }
  return [];
}

/**
 * Remove every recorded signal belonging to one layer, in place.
 *
 * In place because `SessionRecord.detections` is readonly by design — callers may
 * append and prune, but must not swap the array out from under a reference someone
 * else is holding.
 */
export function dropLayer(session: SessionRecord, layer: SignalLayer): void {
  for (let i = session.detections.length - 1; i >= 0; i--) {
    if (signalSpec(session.detections[i]!.id).layer === layer) {
      session.detections.splice(i, 1);
    }
  }
}

/** Append only signals not already recorded, preserving first-observation order. */
export function mergeDetections(session: SessionRecord, fresh: readonly Detection[]): void {
  const known = new Set(session.detections.map((d) => d.id));
  for (const d of fresh) {
    if (!known.has(d.id)) {
      session.detections.push(d);
      known.add(d.id);
    }
  }
}

export interface EnforceOptions {
  /** Human-readable name of what is being protected, for the dashboard timeline. */
  readonly action: string;
}

export function enforce(store: SentinelleStore, opts: EnforceOptions) {
  return async function enforceMiddleware(req: Request, res: Response, next: NextFunction) {
    const ctx = req.sentinelle;
    if (!ctx) return next();

    mergeDetections(ctx.session, inspectProbeSilence(req, ctx.session));

    const assessment = combine(ctx.session.detections);

    await publishAssessment(store, req, assessment, opts.action);

    if (config.MONITOR_ONLY) {
      res.setHeader('x-sentinelle-monitor-only', 'true');
      res.setHeader('x-sentinelle-score', String(assessment.score));
      return next();
    }

    res.setHeader('x-sentinelle-score', String(assessment.score));
    res.setHeader('x-sentinelle-verdict', assessment.verdict);

    if (assessment.verdict === 'block') {
      logger.warn(
        { sessionId: ctx.session.id, score: assessment.score, action: opts.action },
        'sentinelle: blocked',
      );
      return respondBlocked(req, res, assessment.score, assessment.detections.slice(0, 6));
    }

    if (assessment.verdict === 'challenge' && !ctx.session.solvedAt) {
      ctx.session.challengedAt ??= Date.now();
      await store.saveSession(ctx.session);
      logger.info(
        { sessionId: ctx.session.id, score: assessment.score, action: opts.action },
        'sentinelle: challenged',
      );
      return respondChallenge(req, res, assessment.score);
    }

    next();
  };
}

async function publishAssessment(
  store: SentinelleStore,
  req: Request,
  assessment: ReturnType<typeof combine>,
  action: string,
): Promise<void> {
  const event = {
    at: Date.now(),
    sessionId: req.sentinelle.session.id,
    ip: req.sentinelle.clientIp,
    userAgent: req.sentinelle.session.userAgent,
    path: req.path,
    action,
    score: assessment.score,
    verdict: config.MONITOR_ONLY ? `${assessment.verdict} (monitor)` : assessment.verdict,
    byLayer: assessment.byLayer,
    detections: assessment.detections.map((d) => ({
      id: d.id,
      weight: d.weight,
      layer: d.layer,
      description: d.description,
      evidence: d.evidence,
    })),
  };
  await Promise.all([store.publishEvent(event), store.pushRecent(event)]);
}

function wantsJson(req: Request): boolean {
  return req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json';
}

function respondBlocked(req: Request, res: Response, score: number, top: readonly { description: string; evidence: string }[]) {
  if (wantsJson(req)) {
    return res.status(403).json({
      error: 'blocked',
      score,
      // Real vendors never tell you why. This one does, because the point of the
      // exercise is to be legible from both sides.
      reasons: top.map((d) => `${d.description} — ${d.evidence}`),
    });
  }
  return res.status(403).type('html').send(blockedPage(score, top));
}

function respondChallenge(req: Request, res: Response, score: number) {
  if (wantsJson(req)) {
    return res.status(401).json({ error: 'challenge_required', score, challengeUrl: '/challenge' });
  }
  return res.redirect(302, `/challenge?next=${encodeURIComponent(req.originalUrl)}`);
}

function blockedPage(score: number, top: readonly { description: string; evidence: string }[]): string {
  // The " — " is a literal text node, not styling: the worker reads this page back
  // with textContent, and an element boundary alone would run the description into
  // the evidence with no separator.
  const rows = top
    .map(
      (d) =>
        `<li><strong>${escapeHtml(d.description)}</strong> — <br><code>${escapeHtml(d.evidence)}</code></li>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Blocked — Vitrine</title>
<style>
 body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;background:#0b0d12;color:#e8ecf3;margin:0;display:grid;place-items:center;min-height:100vh}
 main{max-width:640px;padding:40px}
 h1{font-size:28px;margin:0 0 4px}
 .score{font-size:64px;font-weight:800;color:#ff4d6a;line-height:1}
 ul{padding-left:18px} li{margin:10px 0}
 code{background:#161a23;padding:2px 6px;border-radius:4px;font-size:13px;color:#9fb3c8}
 .muted{color:#7d8a9c}
</style>
<main>
  <p class="muted">SENTINELLE</p>
  <div class="score">${score}</div>
  <h1>Request blocked</h1>
  <p class="muted">This session was scored as automated. Top contributing signals:</p>
  <ul>${rows}</ul>
</main>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
