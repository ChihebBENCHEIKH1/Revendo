/**
 * Ambient session events.
 *
 * `bhv.no_ambient_events` is the lightest signal in the catalog (weight 6) because a
 * genuinely focused user generates none either. It is here mostly to demonstrate a
 * point about weighting — but the *technique* it forces is the interesting part.
 *
 * The wrong way to answer it:
 *
 *     window.dispatchEvent(new Event('resize'))
 *
 * That event has `isTrusted === false`. Any handler can read that property, so the
 * fake is not merely useless, it is a brand-new signal that says "this page is being
 * manipulated from inside". The same trap catches synthetic clicks, synthetic key
 * events and synthetic focus.
 *
 * The right way is to make the browser produce the event for real, from outside the
 * page, by actually changing the thing the event reports on. `Emulation.
 * setDeviceMetricsOverride` genuinely resizes the viewport, so the resize event is
 * genuinely trusted.
 *
 * The same principle scales up: real `visibilitychange` and `blur` come from actually
 * activating another target (`Target.activateTarget`) rather than announcing that you
 * did. That is the production answer; it is left out here because a second tab per
 * session is real memory across a fleet, and this signal is worth 6 points.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { Session } from '../cdp/session.js';
import { logger } from '../logger.js';
import { Rng } from './rng.js';

export class AmbientActivity {
  private stopped = false;

  constructor(
    private readonly session: Session,
    private readonly rng: Rng,
  ) {}

  /**
   * Occasionally nudge the window size, the way someone adjusts a window or their
   * browser reflows after a zoom change.
   *
   * Runs detached for the life of the session; `stop()` ends it. Every call is
   * guarded because a session that closes mid-resize should not produce an
   * unhandled rejection.
   */
  start(): void {
    void (async () => {
      // The first nudge comes soon, later ones settle into a slower cadence.
      //
      // Each navigation creates a fresh document with a fresh probe, so its ambient
      // counter restarts at zero. A uniform 14s median meant most pages were reported
      // before any resize had happened on them, and `bhv.no_ambient_events` fired
      // even though the session as a whole was generating plenty. Front-loading also
      // matches how people behave: window fiddling clusters on arrival.
      let interval = this.rng.timing(3_000, 0.4, 1_200, 7_000);

      while (!this.stopped) {
        await delay(interval);
        interval = this.rng.timing(14_000, 0.5, 6_000, 45_000);
        if (this.stopped) return;

        // Small adjustments only. A window that jumps between two exact sizes on a
        // timer is a pattern; a few pixels of drift is a person.
        const width = this.session.viewport.width + this.rng.int(-24, 24);
        const height = this.session.viewport.height + this.rng.int(-18, 18);

        try {
          await this.session.resizeViewport(width, height);
        } catch (err) {
          logger.debug({ err }, 'ambient resize failed; session probably closing');
          return;
        }
      }
    })();
  }

  stop(): void {
    this.stopped = true;
  }
}
