/**
 * Vitrine — HTTP entrypoint.
 *
 * Route order is load-bearing:
 *
 *   attachSession  → observes everything, blocks nothing
 *   static assets  → served, but only after they have been observed
 *   routes         → each protected route opts into `enforce` explicitly
 *
 * Enforcement is opt-in per route rather than global-with-exceptions. An
 * allowlist you forget to extend fails safe (a new route is unprotected but working);
 * a blocklist you forget to extend fails closed in production and takes the site
 * down. Neither is free, but the first one does not page anyone at 3am.
 */

import express from 'express';
import Redis from 'ioredis';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { attachSession, dropLayer, enforce, mergeDetections } from './gate.js';
import { SentinelleStore } from './sentinelle/store.js';
import { combine } from './sentinelle/scoring.js';
import { FingerprintPayload, inspectFingerprint } from './sentinelle/fingerprint.js';
import { BehaviorPayload, inspectBehavior } from './sentinelle/behavior.js';
import { SIGNAL_CATALOG } from './sentinelle/catalog.js';
import { ListingRepository, NewListing } from './listings.js';
import { challengePage, homePage, listingCreatedPage, loginPage, sellPage } from './views.js';
import { dashboardPage } from './dashboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEMO_CREDENTIALS = { email: 'seller@vitrine.test', password: 'hunter2' };
const AUTH_COOKIE = 'vitrine_auth';

async function main(): Promise<void> {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const store = new SentinelleStore(config.REDIS_URL);
  const listings = new ListingRepository(redis);
  await listings.seedIfEmpty();

  const app = express();
  app.disable('x-powered-by');
  // Trust the simulated proxy layer's XFF. See the note in gate.ts — in a real
  // deployment this is `trust proxy` scoped to known hops, never `true`.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use(attachSession(store));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: false }));

  /* ---------------------------------------------------------------- *
   * Telemetry — observed, never enforced.
   * ---------------------------------------------------------------- */

  app.post('/api/telemetry', async (req, res) => {
    const ctx = req.sentinelle;
    if (!ctx) return res.status(204).end();

    const fp = FingerprintPayload.safeParse(req.body?.fingerprint);
    const bhv = BehaviorPayload.safeParse(req.body?.behavior);

    if (fp.success) {
      // Cohort size is computed before scoring so the very first member of a fleet
      // is measured against the fleet it is about to join, not the empty set.
      const canvasCohortSize = await store.recordCanvasCohort(fp.data.canvasHash, ctx.session.id);
      mergeDetections(
        ctx.session,
        inspectFingerprint(fp.data, {
          expectedTimezoneRegion: config.EXPECTED_TZ_REGION,
          canvasCohortSize,
          secureOrigin: req.secure || req.hostname === 'localhost' || req.hostname === '127.0.0.1',
        }),
      );
    }
    if (bhv.success) {
      // Behavioural signals are **re-evaluated**, not latched.
      //
      // Transport and fingerprint findings are monotonic facts about the client —
      // once a session has shown you `navigator.webdriver`, it has shown you. But
      // behaviour is a running description of a session that is still happening, and
      // latching it means a report sent two seconds after page load ("no ambient
      // events yet") permanently outweighs the next thirty seconds of evidence to
      // the contrary. That is not caution, it is a stale read: the detector would be
      // scoring a session that no longer exists.
      //
      // Dropping the behaviour layer before re-merging keeps the score honest about
      // the present, and costs nothing — the current telemetry payload always
      // contains the full event history for the session.
      dropLayer(ctx.session, 'behavior');
      mergeDetections(ctx.session, inspectBehavior(bhv.data));
    }

    // Proof that JavaScript ran in this session. A client that fakes headers
    // perfectly still cannot reach this line without executing the probe.
    ctx.session.telemetryReceived = (ctx.session.telemetryReceived ?? 0) + 1;

    await store.saveSession(ctx.session);
    const assessment = combine(ctx.session.detections);
    res.json({ score: assessment.score, verdict: assessment.verdict });
  });

  /* ---------------------------------------------------------------- *
   * Challenge
   * ---------------------------------------------------------------- */

  app.get('/challenge', (req, res) => {
    const next = typeof req.query.next === 'string' ? req.query.next : '/';
    const score = combine(req.sentinelle?.session.detections ?? []).score;
    // Never reflect `next` into a redirect without constraining it to a local path —
    // that is an open redirect, and it is the kind of bug that survives a demo into
    // production because nobody reads the challenge page twice.
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    res.type('html').send(challengePage(safeNext, score));
  });

  app.post('/api/challenge/solve', async (req, res) => {
    const ctx = req.sentinelle;
    if (!ctx) return res.status(204).end();
    const samples = Number(req.body?.samples ?? 0);
    const travelled = Number(req.body?.travelled ?? 0);

    // Re-check the claim server-side. The client reports its own work, so the client
    // can lie about it; requiring a plausible path length makes the lie cost about as
    // much as the honest answer.
    if (samples >= 15 && travelled > 60) {
      ctx.session.solvedAt = Date.now();
      await store.saveSession(ctx.session);
      logger.info({ sessionId: ctx.session.id, samples, travelled }, 'sentinelle: challenge solved');
      return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'insufficient_interaction' });
  });

  /* ---------------------------------------------------------------- *
   * Marketplace
   * ---------------------------------------------------------------- */

  app.get('/', enforce(store, { action: 'browse' }), async (_req, res) => {
    res.type('html').send(homePage(await listings.all()));
  });

  app.get('/login', enforce(store, { action: 'view-login' }), (_req, res) => {
    res.type('html').send(loginPage());
  });

  app.post('/api/login', enforce(store, { action: 'login' }), (req, res) => {
    const { email, password } = req.body ?? {};
    if (email === DEMO_CREDENTIALS.email && password === DEMO_CREDENTIALS.password) {
      res.setHeader('set-cookie', `${AUTH_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax`);
      return res.redirect(302, '/sell');
    }
    return res.status(401).type('html').send(loginPage('Identifiants invalides.'));
  });

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if ((req.get('cookie') ?? '').includes(`${AUTH_COOKIE}=1`)) return next();
    return res.redirect(302, '/login');
  };

  app.get('/sell', enforce(store, { action: 'view-sell' }), requireAuth, (_req, res) => {
    res.type('html').send(sellPage());
  });

  /**
   * The objective.
   *
   * Everything else in this service exists so that this one POST is hard to reach
   * with a script. It is scored last and hardest because by the time a session gets
   * here it has produced a full transport, fingerprint and behavioural record.
   */
  app.post('/api/listings', enforce(store, { action: 'publish' }), requireAuth, async (req, res) => {
    const parsed = NewListing.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid_listing', issues: parsed.error.issues });
    }
    const listing = await listings.create(parsed.data);
    logger.info({ id: listing.id, title: listing.title }, 'listing published');

    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(201).json(listing);
    }
    return res.status(201).type('html').send(listingCreatedPage(listing));
  });

  app.get('/api/listings', enforce(store, { action: 'read-api' }), async (_req, res) => {
    res.json(await listings.all());
  });

  /* ---------------------------------------------------------------- *
   * Console
   * ---------------------------------------------------------------- */

  app.get('/__sentinelle', (_req, res) => res.type('html').send(dashboardPage()));

  app.get('/__sentinelle/catalog', (_req, res) => res.json(SIGNAL_CATALOG));

  app.get('/__sentinelle/recent', async (_req, res) => res.json(await store.recentEvents()));

  app.get('/__sentinelle/stream', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers SSE into uselessness unless told not to. Cheap to set, painful
      // to debug when missing.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const unsubscribe = store.onEvent((payload) => res.write(`data: ${payload}\n\n`));
    // Comment frames keep intermediaries from reaping an idle connection.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post('/__sentinelle/reset', async (_req, res) => {
    const deleted = await store.reset();
    await listings.reset();
    logger.info({ deleted }, 'sentinelle: state reset');
    res.json({ ok: true, deleted });
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'vitrine' }));

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, monitorOnly: config.MONITOR_ONLY, signals: SIGNAL_CATALOG.length },
      'vitrine listening',
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await Promise.allSettled([store.close(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
