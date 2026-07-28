/**
 * Human typing.
 *
 * Sentinelle looks at two moments of the inter-keystroke interval distribution: its
 * coefficient of variation (`bhv.typing_uniform`, CV < 0.15 is a timer) and its mean
 * (`bhv.typing_superhuman`, below 25ms nobody is doing that for a whole form).
 *
 * The naive countermeasure — `sleep(random(80, 120))` between keys — defeats the
 * *mean* check and fails the *variation* check, because uniform noise has a CV of
 * about 0.12 at that range. Human keying is not uniform. It is:
 *
 *  - **Right-skewed.** There is a floor set by biomechanics and a long tail set by
 *    attention. Log-normal, not uniform.
 *  - **Digraph-dependent.** Alternating hands is fast ("the"), same-finger repeats are
 *    slow ("ll", "ed" on one hand). Modelled here as a hand-alternation bonus and a
 *    same-key penalty.
 *  - **Structured.** A pause before a capital (reaching for shift), after punctuation,
 *    and at word boundaries where the next word is being retrieved.
 *  - **Error-prone.** Roughly 1-2% of keystrokes are wrong, noticed a beat later, and
 *    repaired with backspace. The repair is unmistakably human: a burst, a pause, a
 *    correction.
 *
 * Layout is AZERTY because every persona in the identity pool is French. A fr-FR
 * browser whose typos are QWERTY-adjacent is a small contradiction, and the whole
 * argument of this project is that small contradictions are what get caught.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { Session } from '../cdp/session.js';
import { Rng } from './rng.js';

/** Physical key neighbours on AZERTY, used to make typos plausible. */
const AZERTY_NEIGHBOURS: Record<string, string> = {
  a: 'zqs', z: 'aesq', e: 'zrds', r: 'etfd', t: 'rygf', y: 'tuhg', u: 'yijh',
  i: 'uokj', o: 'iplk', p: 'oml',
  q: 'aszw', s: 'qdzxe', d: 'sfxcr', f: 'dgcvt', g: 'fhvby', h: 'gjbnu', j: 'hknmi',
  k: 'jlno', l: 'kmp', m: 'lp',
  w: 'xqs', x: 'wcsd', c: 'xvdf', v: 'cbfg', b: 'vngh', n: 'bhj',
};

/** Which hand types each key on AZERTY. Alternation is the strongest speed effect. */
const LEFT_HAND = new Set('azertqsdfgwxcvb12345');
const RIGHT_HAND = new Set('yuiophjklnm67890');

function handOf(ch: string): 'left' | 'right' | 'other' {
  const c = ch.toLowerCase();
  if (LEFT_HAND.has(c)) return 'left';
  if (RIGHT_HAND.has(c)) return 'right';
  return 'other';
}

export interface TypingProfile {
  /** Median inter-keystroke interval, ms. ~110ms ≈ 55 WPM, a competent non-touch-typist. */
  readonly medianIntervalMs: number;
  /** Log-normal sigma. 0.45 gives a CV around 0.5 — comfortably human. */
  readonly sigma: number;
  readonly typoProbability: number;
}

export const DEFAULT_TYPING: TypingProfile = {
  medianIntervalMs: 110,
  sigma: 0.45,
  typoProbability: 0.018,
};

/**
 * Delay before `ch`, given the character before it.
 *
 * Exported and pure so the statistical properties can be asserted in a test rather
 * than hoped for.
 */
export function intervalFor(
  ch: string,
  previous: string | null,
  rng: Rng,
  profile: TypingProfile = DEFAULT_TYPING,
): number {
  let median = profile.medianIntervalMs;

  if (previous !== null) {
    const a = handOf(previous);
    const b = handOf(ch);

    // Alternating hands overlaps the two movements: the next finger is already on
    // its way while the current key is being pressed.
    if (a !== 'other' && b !== 'other' && a !== b) median *= 0.78;
    // Same finger, same key — the slowest digraph there is.
    else if (previous.toLowerCase() === ch.toLowerCase()) median *= 1.35;
    else if (a === b) median *= 1.12;

    // Word boundary: the next word has to be retrieved before it can be typed.
    if (previous === ' ') median *= 1.3;
    if (/[.,;:!?]/.test(previous)) median *= 1.5;
  }

  // Reaching for shift costs a beat.
  if (/[A-Z]/.test(ch)) median *= 1.45;
  // Digits and symbols are off the home row and are hunted for.
  if (/[0-9@€#%&*()\[\]{}]/.test(ch)) median *= 1.6;
  if (ch === ' ') median *= 0.85;

  return rng.timing(median, profile.sigma, 28, 1400);
}

/**
 * Map a character to a `code` / Windows virtual-key-code pair.
 *
 * The last branch is the important one, and it is a bug fix rather than a
 * simplification. Using `ch.charCodeAt(0)` as the virtual key code happens to be
 * correct for letters (65–90 = VK_A..VK_Z), digits (48–57 = VK_0..VK_9) and space
 * (32 = VK_SPACE) — and catastrophically wrong for punctuation, because ASCII and
 * the virtual-key table are different namespaces that only coincide on those ranges.
 *
 * `'.'.charCodeAt(0)` is **46**, which is `VK_DELETE`. Typing an email address
 * therefore deleted a character instead of inserting a dot, and the run failed three
 * steps later with a message about navigation. Sending 0 makes Chrome fall back to
 * inserting `text` verbatim, which is what we want for every character that is not a
 * named key.
 */
function keyCodeFor(ch: string): { code: string; vk: number } {
  if (ch === ' ') return { code: 'Space', vk: 32 };
  if (/[a-zA-Z]/.test(ch)) return { code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0) };
  if (/[0-9]/.test(ch)) return { code: `Digit${ch}`, vk: ch.charCodeAt(0) };
  return { code: '', vk: 0 };
}

export class HumanKeyboard {
  constructor(
    private readonly session: Session,
    private readonly rng: Rng,
    private readonly profile: TypingProfile = DEFAULT_TYPING,
  ) {}

  private async pressChar(ch: string): Promise<void> {
    const { code, vk } = keyCodeFor(ch);
    // keyDown carrying `text` is what actually inserts the character *and* fires a
    // real keydown. Input.insertText would be simpler and would skip the key events
    // entirely — which is precisely the shortcut the detector is watching for.
    await this.session.dispatchKey({
      type: 'keyDown',
      text: ch,
      key: ch,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    // Key hold time. Short, and distinct from the gap between keys.
    await delay(this.rng.timing(48, 0.3, 20, 160));
    await this.session.dispatchKey({
      type: 'keyUp',
      key: ch,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
  }

  private async pressBackspace(): Promise<void> {
    await this.session.dispatchKey({
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
      // Without an explicit editing command, a Backspace keyDown fires the event but
      // does not delete anything — the keystroke is observed by the page and ignored
      // by the editor. The typo model then leaves its own typos in the field, which
      // is how this first surfaced: a login that failed with a password one character
      // too long, roughly one run in three.
      commands: ['deleteBackward'],
    });
    await delay(this.rng.timing(45, 0.3, 20, 140));
    await this.session.dispatchKey({
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
  }

  /** Type `text` into whatever currently has focus. */
  async type(text: string): Promise<void> {
    let previous: string | null = null;

    for (const ch of text) {
      await delay(intervalFor(ch, previous, this.rng, this.profile));

      const neighbours = AZERTY_NEIGHBOURS[ch.toLowerCase()];
      if (neighbours && this.rng.bool(this.profile.typoProbability)) {
        // Hit a neighbouring key…
        const wrong = this.rng.pick([...neighbours]);
        await this.pressChar(ch === ch.toUpperCase() && /[A-Z]/.test(ch) ? wrong.toUpperCase() : wrong);
        // …notice a beat later — recognition is slower than the keystroke that caused it…
        await delay(this.rng.timing(320, 0.5, 120, 1400));
        await this.pressBackspace();
        await delay(this.rng.timing(140, 0.4, 60, 600));
      }

      await this.pressChar(ch);
      previous = ch;
    }
  }

  /**
   * Click a field, wait for focus, type into it, and check what actually landed.
   *
   * The read-back is not paranoia. Typing through synthetic key events goes through
   * the page's own handlers — input masks, `maxlength`, autocomplete widgets and
   * React-controlled inputs all rewrite values under you — and the failure mode is
   * silent: the form submits, the server rejects it, and the run fails somewhere
   * else entirely with a message about navigation. Verifying here turns a confusing
   * downstream symptom into an error that names the field.
   *
   * A human proofreads a field they just typed, so the repair is in character:
   * select the contents and type it again, not `el.value = "..."`.
   */
  async fill(selector: string, text: string, click: (selector: string) => Promise<void>): Promise<void> {
    await click(selector);
    // Focus settles before the first keystroke arrives — a human does not begin
    // typing on the same tick they finish clicking.
    await delay(this.rng.timing(210, 0.45, 80, 900));
    await this.type(text);

    if (await this.valueOf(selector) === text) return;

    await delay(this.rng.timing(500, 0.4, 200, 1600));
    await this.selectAll();
    await this.type(text);

    const repaired = await this.valueOf(selector);
    if (repaired !== text) {
      throw new Error(
        `field ${selector} holds ${JSON.stringify(repaired)} after two attempts, expected ${JSON.stringify(text)}`,
      );
    }
  }

  private async valueOf(selector: string): Promise<string> {
    return this.session.evaluate<string>(
      `(document.querySelector(${JSON.stringify(selector)}) || {}).value ?? ''`,
    );
  }

  /** Ctrl+A on the focused field, so the retype replaces rather than appends. */
  private async selectAll(): Promise<void> {
    await this.session.dispatchKey({
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      commands: ['selectAll'],
    });
    await delay(this.rng.timing(60, 0.3, 25, 200));
    await this.session.dispatchKey({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  }
}
