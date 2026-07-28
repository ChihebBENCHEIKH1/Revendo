/**
 * Chrome process lifecycle.
 *
 * We launch and supervise the browser ourselves instead of letting a framework do
 * it, because the launch flags *are* part of the anti-bot surface. Puppeteer's
 * defaults include several switches that are themselves detectable, and you cannot
 * reason about what you did not choose.
 *
 * The most important idea in this file is that the cheapest countermeasure is the
 * one applied at the source. `--disable-blink-features=AutomationControlled` stops
 * `navigator.webdriver` from ever being true, which is strictly better than
 * redefining the property later: a property that was never wrong leaves no patched
 * function behind for `fp.function_tostring_tampered` to find. Every JS patch is a
 * new surface. Prefer a flag, then a CDP override, and only then injected script.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { config, type Profile } from '../config.js';
import { logger } from '../logger.js';

/** Flags every profile needs simply to run inside a container. */
const CONTAINER_FLAGS = [
  // Chrome's sandbox needs kernel capabilities the container does not grant. This is
  // the standard containerised-Chrome trade-off: the browser is the isolation
  // boundary in normal use, but here the container is, and the browser only ever
  // visits a site we control.
  '--no-sandbox',
  '--disable-setuid-sandbox',
  // /dev/shm is 64MB by default in Docker; Chrome will happily exceed it and crash
  // with an opaque renderer failure. Either raise it in compose or spill to /tmp.
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-breakpad',
  '--disable-component-update',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
];

/**
 * The automation posture every off-the-shelf stack ships by default.
 *
 * `--enable-automation` is what Selenium and Puppeteer set, and it is what turns
 * `navigator.webdriver` on. Making the naive profile carry it is not stacking the
 * deck — it is reproducing the actual baseline.
 */
const NAIVE_FLAGS = ['--enable-automation'];

const STEALTH_FLAGS = [
  // Removes the automation-controlled Blink feature: navigator.webdriver stays false
  // *and* stays native. Source-level fix, no injected script required.
  '--disable-blink-features=AutomationControlled',
  // A plausible consumer window. Headless has no window manager, so without this the
  // outer geometry is zeroes and fp.screen_impossible fires.
  '--window-size=1440,900',
  '--lang=fr-FR,fr',
  // Suppress the "Chrome is being controlled by automated test software" infobar
  // machinery entirely rather than hiding it.
  '--disable-infobars',
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
];

export interface ChromeInstance {
  readonly port: number;
  readonly process: ChildProcess;
  close(): Promise<void>;
}

function flagsFor(profile: Profile, port: number, userDataDir: string): string[] {
  const base = [
    `--remote-debugging-port=${port}`,
    // Bind explicitly: Chrome refuses remote-debugging connections from other hosts
    // unless told, and in compose the client is another container.
    '--remote-debugging-address=0.0.0.0',
    `--user-data-dir=${userDataDir}`,
    ...CONTAINER_FLAGS,
  ];

  if (config.HEADLESS) base.push('--headless=new');
  base.push(...(profile === 'stealth' ? STEALTH_FLAGS : NAIVE_FLAGS));
  base.push('about:blank');
  return base;
}

async function waitForDevTools(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const version = (await res.json()) as { Browser?: string };
        logger.debug({ browser: version.Browser, port }, 'devtools ready');
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await delay(150);
  }
  throw new Error(`Chrome DevTools did not come up on port ${port}: ${String(lastError)}`);
}

export async function launchChrome(profile: Profile, port = config.CHROME_PORT): Promise<ChromeInstance> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'revendo-chrome-'));
  const args = flagsFor(profile, port, userDataDir);

  logger.info({ profile, port, binary: config.CHROME_PATH }, 'launching chrome');
  logger.debug({ args }, 'chrome flags');

  const child = spawn(config.CHROME_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  // Chrome is noisy on stderr even when healthy, so this stays at debug — but it is
  // the only place a renderer crash or a bad flag will ever show up.
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) logger.debug({ chrome: line.slice(0, 300) }, 'chrome stderr');
  });

  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) =>
      reject(new Error(`Chrome exited early (code=${code} signal=${signal})`)),
    );
    child.once('error', reject);
  });

  try {
    // Race the readiness probe against the process dying, so a bad binary path fails
    // in milliseconds with a real message instead of after a 20s timeout.
    await Promise.race([waitForDevTools(port), exited]);
  } catch (err) {
    child.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  let closed = false;
  return {
    port,
    process: child,
    async close() {
      if (closed) return;
      closed = true;
      child.removeAllListeners('exit');
      child.kill('SIGTERM');

      // Give it a moment to close cleanly, then stop being polite. A wedged Chrome
      // holding a few hundred MB is the single most common way a scraping fleet
      // runs a host out of memory.
      const died = await Promise.race([
        new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
        delay(4000).then(() => false),
      ]);
      if (!died) child.kill('SIGKILL');

      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      logger.debug('chrome closed');
    },
  };
}
