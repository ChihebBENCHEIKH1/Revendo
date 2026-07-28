/**
 * Vitrine adapter — the site-specific half of the worker.
 *
 * Everything that knows a selector, a URL or a form field lives here and nowhere
 * else. That is the whole point of the layering: marketplaces change their DOM
 * constantly, so the part that breaks weekly is isolated from the CDP driver, the
 * stealth layer and the behaviour engine, which do not. Adding a second marketplace
 * means writing a second file at this level, not touching anything below it.
 *
 * The flow is written once against `Actuator`. The naive and stealth runs execute
 * the *same* steps in the same order against the same selectors — only the physics
 * of how the page is touched differ.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { Session } from '../cdp/session.js';
import type { Actuator } from '../behavior/actuator.js';
import { HumanActuator } from '../behavior/actuator.js';
import { logger } from '../logger.js';

export interface PublishJob {
  readonly listingId: string;
  readonly title: string;
  readonly brand: string;
  readonly size: string;
  /** Must match one of the radio values on the sell form. */
  readonly condition: string;
  readonly priceEur: number;
  readonly description: string;
}

export type PublishOutcome =
  | { kind: 'published'; marketplaceId: string; score: number; verdict: string }
  | { kind: 'challenged'; solved: false; score: number; verdict: string }
  | { kind: 'blocked'; score: number; verdict: string; reasons: string[] }
  | { kind: 'failed'; error: string };

const SELECTORS = {
  loginLink: 'nav a[href="/login"]',
  email: '#email',
  password: '#password',
  submitLogin: '#submit-login',
  title: '#title',
  brand: '#brand',
  size: '#size',
  price: '#price',
  description: '#description',
  submitListing: '#submit-listing',
  challengeTarget: '#target',
  challengePad: '#pad',
  publishedBadge: '.badge',
} as const;

const CONDITION_SELECTORS: Record<string, string> = {
  'Neuf avec étiquette': '#condition-neuf',
  'Très bon état': '#condition-tres-bon',
  'Bon état': '#condition-bon',
  Satisfaisant: '#condition-satisfaisant',
};

export class VitrineAdapter {
  constructor(
    private readonly session: Session,
    private readonly actuator: Actuator,
    private readonly baseUrl: string,
    private readonly credentials: { email: string; password: string },
  ) {}

  async publish(job: PublishJob): Promise<PublishOutcome> {
    try {
      this.actuator.start();

      // 1. Arrive on the catalogue like a returning seller would, rather than deep-
      //    linking straight to the form. The browse step costs a few seconds and buys
      //    a plausible navigation history — Sec-Fetch-Site says `same-origin` on every
      //    subsequent request instead of `none` on an isolated POST.
      await this.session.navigate(`${this.baseUrl}/`);
      await this.actuator.readPage();

      const gate = await this.passGateIfNeeded();
      if (gate) return gate;

      // 2. Log in.
      await this.actuator.click(SELECTORS.loginLink);
      await this.waitForNavigation('/login');
      await this.actuator.readPage();

      await this.actuator.fill(SELECTORS.email, this.credentials.email);
      await this.actuator.settle();
      await this.actuator.fill(SELECTORS.password, this.credentials.password);
      await this.actuator.settle();
      await this.actuator.click(SELECTORS.submitLogin);
      await this.waitForNavigation('/sell');

      const afterLogin = await this.passGateIfNeeded();
      if (afterLogin) return afterLogin;

      // 3. Fill the listing.
      await this.actuator.readPage();
      await this.actuator.fill(SELECTORS.title, job.title);
      await this.actuator.settle();
      await this.actuator.fill(SELECTORS.brand, job.brand);
      await this.actuator.settle();
      await this.actuator.fill(SELECTORS.size, job.size);
      await this.actuator.settle();

      const conditionSelector = CONDITION_SELECTORS[job.condition];
      if (conditionSelector) {
        await this.actuator.click(conditionSelector);
        await this.actuator.settle();
      }

      await this.actuator.fill(SELECTORS.price, job.priceEur.toFixed(2));
      await this.actuator.settle();
      await this.actuator.fill(SELECTORS.description, job.description);
      await this.actuator.settle();

      // 4. Publish.
      await this.actuator.click(SELECTORS.submitListing);
      await delay(1200);

      return await this.readPublishResult();
    } catch (err) {
      return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.actuator.stop();
    }
  }

  /**
   * Handle a challenge interstitial if Sentinelle served one.
   *
   * Returns a terminal outcome when the run cannot continue, or null to carry on.
   * A challenge is *recoverable* — that is the whole reason a challenge band exists —
   * so the right response is to solve it, not to burn the identity.
   */
  private async passGateIfNeeded(): Promise<PublishOutcome | null> {
    const url = await this.session.currentUrl();

    if (url.includes('/challenge')) {
      const verdict = await this.session.sentinelleVerdict();
      const solved = await this.solveChallenge();
      if (!solved) {
        logger.warn('challenge not solved — this actuator cannot produce a pointer path');

        // Retry the action once, which is what a scraper that cannot solve an
        // interstitial actually does. It matters for accuracy, not persistence: the
        // probe ran while we were on the challenge page, so the session now carries
        // its fingerprint evidence and the gate's answer has probably changed from
        // "challenge" to "block". Reporting the stale verdict would understate what
        // the detector knows.
        await this.session.navigate(`${this.baseUrl}/`).catch(() => undefined);
        const blocked = await this.detectBlockPage();
        if (blocked) return blocked;

        const latest = await this.session.sentinelleVerdict();
        return {
          kind: 'challenged',
          solved: false,
          score: latest?.score ?? verdict?.score ?? -1,
          verdict: latest?.verdict ?? verdict?.verdict ?? 'challenge',
        };
      }
      await delay(800);
      return null;
    }

    const blocked = await this.detectBlockPage();
    if (blocked) return blocked;

    return null;
  }

  /**
   * Solve the interaction challenge with a real pointer path.
   *
   * The page requires ≥15 distinct pointer samples inside the pad and a travelled
   * distance well above the straight-line distance — in other words, it is asking for
   * evidence that a hand moved, not that a coordinate changed. A scripted actuator has
   * no pointer, so it simply cannot pass, which is the correct outcome rather than a
   * bug.
   */
  private async solveChallenge(): Promise<boolean> {
    if (!(this.actuator instanceof HumanActuator)) return false;

    const pad = await this.session.rectOf(SELECTORS.challengePad);
    const target = await this.session.rectOf(SELECTORS.challengeTarget);
    if (!pad || !target) return false;

    const pointer = this.actuator.pointer;

    // Enter the pad on the left, so the traversal to the target is long enough to
    // clear the distance threshold and generates samples the whole way.
    await pointer.moveTo({ x: pad.x + pad.width * 0.12, y: pad.y + pad.height * 0.6 }, 40);
    await delay(280);
    await pointer.moveTo({ x: target.x + target.width / 2, y: target.y + target.height / 2 }, target.width);

    // The page navigates itself once satisfied; give it a moment to do so.
    await delay(1200);
    const url = await this.session.currentUrl();
    return !url.includes('/challenge');
  }

  private async detectBlockPage(): Promise<PublishOutcome | null> {
    const blocked = await this.session.evaluate<{ score: number; reasons: string[] } | null>(`(() => {
      if (!document.title.startsWith('Blocked')) return null;
      const score = parseInt(document.querySelector('.score')?.textContent || '0', 10);
      const reasons = Array.from(document.querySelectorAll('li')).map(li => li.textContent.trim());
      return { score, reasons };
    })()`);

    if (!blocked) return null;
    return { kind: 'blocked', score: blocked.score, verdict: 'block', reasons: blocked.reasons };
  }

  private async readPublishResult(): Promise<PublishOutcome> {
    const blocked = await this.detectBlockPage();
    if (blocked) return blocked;

    const url = await this.session.currentUrl();
    if (url.includes('/challenge')) {
      const verdict = await this.session.sentinelleVerdict();
      return {
        kind: 'challenged',
        solved: false,
        score: verdict?.score ?? -1,
        verdict: verdict?.verdict ?? 'challenge',
      };
    }

    const marketplaceId = await this.session.evaluate<string | null>(`(() => {
      const code = document.querySelector('.sub code');
      return code ? code.textContent.trim() : null;
    })()`);

    if (!marketplaceId) {
      const title = await this.session.evaluate<string>('document.title');
      return { kind: 'failed', error: `unexpected page after publish: ${title}` };
    }

    const verdict = await this.session.sentinelleVerdict();
    return {
      kind: 'published',
      marketplaceId,
      score: verdict?.score ?? 0,
      verdict: verdict?.verdict ?? 'allow',
    };
  }

  /** Poll for the URL to contain `fragment`. Cheaper and less racy than a load-event wait after a form post. */
  private async waitForNavigation(fragment: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = await this.session.currentUrl();
      // A challenge or a block is also a valid destination — the caller inspects it.
      if (url.includes(fragment) || url.includes('/challenge')) return;
      const title = await this.session.evaluate<string>('document.title').catch(() => '');
      if (title.startsWith('Blocked')) return;
      await delay(200);
    }

    // Say where we actually ended up. "Navigation timed out" on its own sends you
    // hunting through the wrong layer; the URL plus any on-page error message
    // usually names the real cause in one line.
    const [url, title, notice] = await Promise.all([
      this.session.currentUrl().catch(() => 'unknown'),
      this.session.evaluate<string>('document.title').catch(() => ''),
      this.session
        .evaluate<string>('(document.querySelector(".notice")||{}).textContent || ""')
        .catch(() => ''),
    ]);

    throw new Error(
      `navigation to ${fragment} did not happen within ${timeoutMs}ms ` +
        `(at ${url}, title ${JSON.stringify(title)}${notice ? `, page says ${JSON.stringify(notice.trim())}` : ''})`,
    );
  }
}
