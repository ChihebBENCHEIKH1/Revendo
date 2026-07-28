/**
 * Capture the Sentinelle console for the README.
 *
 * Runs inside the worker image and drives its Chromium over CDP — the same
 * mechanism the scraper uses, pointed at our own dashboard. Regenerating the README
 * image is therefore `make screenshot` rather than someone remembering to crop a
 * window, which is the only way a screenshot in a README stays true after the UI
 * changes.
 *
 *   docker compose run --rm -v "$PWD/docs/img:/out" worker node /app/ops/screenshot.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import CDP from 'chrome-remote-interface';

const URL = process.env.SHOT_URL ?? 'http://target-site:8080/__sentinelle';
const OUT = process.env.SHOT_OUT ?? '/out/sentinelle-console.png';
const PORT = 9333;
const WIDTH = 1500;

const chrome = spawn(
  process.env.CHROME_PATH ?? '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    '--remote-debugging-address=0.0.0.0',
    // No scrollbar gutter in the capture, and no "restore session" chrome.
    '--hide-scrollbars',
    '--no-first-run',
    '--force-color-profile=srgb',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

async function waitForDevTools() {
  for (let i = 0; i < 100; i++) {
    try {
      // The DevTools endpoint is plain HTTP on loopback by design — Chrome does not
      // serve it over TLS, and this connection never leaves the container. Suppressed
      // inline with a reason rather than disabled in the ruleset, so the rule keeps
      // protecting every other fetch in the repo.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(150);
  }
  throw new Error('Chrome DevTools never came up');
}

await waitForDevTools();

const { webSocketDebuggerUrl } = await CDP.Version({ port: PORT });
const browser = await CDP({ target: webSocketDebuggerUrl });
const { targetId } = await browser.Target.createTarget({ url: 'about:blank' });
const client = await CDP({ port: PORT, target: targetId });

const { Page, Emulation, Runtime } = client;
await Promise.all([Page.enable(), Runtime.enable()]);

// deviceScaleFactor 2 so the text stays crisp when GitHub scales the image down.
await Emulation.setDeviceMetricsOverride({
  width: WIDTH,
  height: 1000,
  deviceScaleFactor: 2,
  mobile: false,
});

const loaded = Page.loadEventFired();
await Page.navigate({ url: URL });
await loaded;

// The dashboard hydrates from /__sentinelle/recent and then opens an SSE stream.
// Wait for the cards to actually exist rather than sleeping and hoping.
for (let i = 0; i < 60; i++) {
  const { result } = await Runtime.evaluate({
    expression: 'document.querySelectorAll("#feed .event").length',
    returnByValue: true,
  });
  if ((result.value ?? 0) > 0) break;
  await delay(250);
}
// Let the entry animation settle so nothing is captured mid-fade.
await delay(800);

// Measure the feed's real extent rather than trusting cssContentSize, which reports
// the viewport height when the body does not overflow — that is what left a screen
// of empty space under the last card in the first capture.
const { result } = await Runtime.evaluate({
  expression: `(() => {
    const feed = document.getElementById('feed');
    const last = feed && feed.lastElementChild;
    return last ? Math.ceil(last.getBoundingClientRect().bottom + window.scrollY + 24) : 0;
  })()`,
  returnByValue: true,
});

const { cssContentSize } = await Page.getLayoutMetrics();
const measured = Number(result.value) || 0;
const height = Math.min(Math.max(measured, Math.ceil(cssContentSize.height) * (measured ? 0 : 1)), 4000);

const { data } = await Page.captureScreenshot({
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: WIDTH, height, scale: 1 },
});

await mkdir(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
await writeFile(OUT, Buffer.from(data, 'base64'));
console.log(`wrote ${OUT} (${WIDTH}x${height} @2x)`);

await client.close();
await browser.close();
chrome.kill('SIGKILL');
