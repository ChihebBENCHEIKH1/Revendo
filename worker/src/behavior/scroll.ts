/**
 * Human scrolling.
 *
 * `bhv.scroll_uniform` fires when scroll deltas have essentially no variation, which
 * is what `window.scrollTo()` and fixed-delta loops produce.
 *
 * Real scrolling is a burst of discrete wheel notches with a rise and a fall — you
 * spin the wheel harder to get moving, ease off as the content you wanted comes into
 * view, and stop with a partial notch. Trackpads add momentum: the deltas keep
 * arriving, decaying, after the fingers have left the surface. Both are modelled as
 * a sequence of decaying bursts.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { Session } from '../cdp/session.js';
import { Rng } from './rng.js';

/** One wheel notch on a physical mouse. Trackpads emit smaller, more frequent deltas. */
const NOTCH = 100;

export class HumanScroll {
  constructor(
    private readonly session: Session,
    private readonly rng: Rng,
  ) {}

  /**
   * Scroll roughly `targetDistance` pixels down in one gesture.
   *
   * "Roughly" is the point — a gesture that lands on exactly the requested pixel
   * every time is a scripted scroll wearing a costume.
   */
  async by(targetDistance: number, at: { x: number; y: number }): Promise<void> {
    const usingTrackpad = this.rng.bool(0.45);
    const notch = usingTrackpad ? NOTCH / this.rng.between(2.5, 4) : NOTCH;

    let remaining = targetDistance * this.rng.between(0.85, 1.15);
    let emitted = 0;

    while (remaining > notch * 0.4 && emitted < 60) {
      // Deltas rise then fall across the gesture. sin over the completed fraction is
      // a cheap way to get that arc without tracking phase explicitly.
      const progress = 1 - remaining / Math.max(targetDistance, 1);
      const shape = 0.45 + 0.55 * Math.sin(Math.min(1, Math.max(0, progress)) * Math.PI);

      const delta = Math.round(notch * shape * this.rng.between(0.75, 1.25));
      if (delta <= 0) break;

      await this.session.dispatchMouse({
        type: 'mouseWheel',
        x: Math.round(at.x),
        y: Math.round(at.y),
        deltaX: 0,
        deltaY: delta,
      });

      remaining -= delta;
      emitted++;

      // Inter-notch timing: fast during the gesture, with an occasional hitch where
      // something on the page caught the eye.
      const gap = this.rng.bool(0.12)
        ? this.rng.timing(420, 0.5, 150, 1600)
        : this.rng.timing(usingTrackpad ? 22 : 65, 0.4, 8, 220);
      await delay(gap);
    }

    // Overshoot correction: scrolling slightly too far and nudging back up is one of
    // the most reliably human things in an event stream.
    if (this.rng.bool(0.3)) {
      await delay(this.rng.timing(380, 0.4, 150, 1200));
      await this.session.dispatchMouse({
        type: 'mouseWheel',
        x: Math.round(at.x),
        y: Math.round(at.y),
        deltaX: 0,
        deltaY: -Math.round(notch * this.rng.between(0.4, 1.1)),
      });
    }
  }

  /** Scroll until `selector` is comfortably inside the viewport. */
  async into(selector: string, at: { x: number; y: number }): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const rect = await this.session.rectOf(selector);
      if (!rect) return;

      const viewportHeight = this.session.viewport.height;
      // Aim to put the element around a third of the way down — where a reader would
      // naturally place something they intend to interact with, not jammed at the edge.
      const desiredTop = viewportHeight * 0.33;
      const delta = rect.y - desiredTop;

      if (Math.abs(delta) < 60) return;
      await this.by(delta, at);
      await delay(this.rng.timing(160, 0.4, 70, 500));
    }
  }
}
