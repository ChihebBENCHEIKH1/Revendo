/**
 * How a flow touches a page.
 *
 * This is the seam that makes the demo's central claim precise. The scraping flow in
 * `adapters/vitrine.ts` is written **once**, against this interface. Swapping the
 * implementation is the only difference between the naive run and the stealth run,
 * so the comparison is genuinely like-for-like: same navigation, same selectors, same
 * form data, same order of operations. Only the physics change.
 *
 *   ScriptedActuator — `element.click()`, `Input.insertText`, no waiting.
 *                      What automation does by default.
 *   HumanActuator    — Fitts-timed pointer paths, log-normal keystrokes, eased
 *                      scrolling, reading pauses, ambient window activity.
 *
 * Keeping this an interface rather than a flag threaded through the flow also keeps
 * the flow honest: there is nowhere to put a `if (stealth)` special case, so the
 * stealth run cannot quietly take a different path through the site.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.js';
import type { Session } from '../cdp/session.js';
import { AmbientActivity } from './ambient.js';
import { Pacing } from './dwell.js';
import { HumanMouse } from './mouse.js';
import { HumanScroll } from './scroll.js';
import { HumanKeyboard } from './typing.js';
import { Rng } from './rng.js';

export interface Actuator {
  readonly kind: 'human' | 'scripted';
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  bringIntoView(selector: string): Promise<void>;
  /** Pause appropriate to having just taken in a new page. */
  readPage(): Promise<void>;
  /** Pause between two related actions. */
  settle(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * The baseline: what every automation tutorial produces.
 *
 * Not a strawman — this is genuinely what `page.click()` and `page.fill()` do
 * underneath, and it is what the overwhelming majority of scrapers ship. It trips
 * `bhv.click_without_movement`, `bhv.typing_superhuman` and `bhv.instant_interaction`
 * without any help from us.
 */
export class ScriptedActuator implements Actuator {
  readonly kind = 'scripted' as const;

  constructor(private readonly session: Session) {}

  async click(selector: string): Promise<void> {
    // No pointer ever travels anywhere. The click event arrives with no kinematic
    // history at all, which is the single loudest behavioural signal there is.
    await this.session.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  }

  async fill(selector: string, value: string): Promise<void> {
    // Set the value and fire the events a framework would listen for. Fast, reliable,
    // and it produces zero keydown events — so the keystroke-interval statistics the
    // detector wants simply do not exist.
    await this.session.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  async bringIntoView(selector: string): Promise<void> {
    await this.session.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView()`,
    );
  }

  async readPage(): Promise<void> {
    // A token pause so the page finishes loading. Far below human reaction time,
    // which is exactly what bhv.instant_interaction measures.
    await delay(50);
  }

  async settle(): Promise<void> {
    await delay(20);
  }

  start(): void {}
  stop(): void {}
}

export class HumanActuator implements Actuator {
  readonly kind = 'human' as const;

  private readonly mouse: HumanMouse;
  private readonly keyboard: HumanKeyboard;
  private readonly scroll: HumanScroll;
  private readonly pacing: Pacing;
  private readonly ambient: AmbientActivity;

  constructor(
    private readonly session: Session,
    rng: Rng,
  ) {
    this.mouse = new HumanMouse(session, rng);
    this.keyboard = new HumanKeyboard(session, rng);
    this.scroll = new HumanScroll(session, rng);
    this.pacing = new Pacing(rng, config.BEHAVIOR_PACE);
    this.ambient = new AmbientActivity(session, rng);
  }

  async click(selector: string): Promise<void> {
    await this.bringIntoView(selector);
    await this.mouse.click(selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.bringIntoView(selector);
    await this.keyboard.fill(selector, value, (s) => this.mouse.click(s));
  }

  async bringIntoView(selector: string): Promise<void> {
    await this.scroll.into(selector, this.mouse.current);
  }

  async readPage(): Promise<void> {
    // Pace the dwell to how much there actually is to read, so a dense page takes
    // longer than a sparse one — a constant pause is its own signature.
    const words = await this.session
      .evaluate<number>('(document.body.innerText || "").split(/\\s+/).filter(Boolean).length')
      .catch(() => 200);
    await this.pacing.readPage(words);
    // Drift the pointer a little while "reading", so the gap between actions has
    // something in it besides silence.
    await this.mouse.drift(600);
  }

  async settle(): Promise<void> {
    await this.pacing.betweenActions();
  }

  start(): void {
    this.ambient.start();
  }

  stop(): void {
    this.ambient.stop();
  }

  /** Exposed for the challenge solver, which needs raw pointer control. */
  get pointer(): HumanMouse {
    return this.mouse;
  }
}
