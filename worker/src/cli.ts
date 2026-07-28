/**
 * One-shot runner — the demo entrypoint.
 *
 *   PROFILE=naive   node dist/cli.js
 *   PROFILE=stealth node dist/cli.js
 *
 * Runs a single publish job and prints what Sentinelle made of it. Deliberately
 * separate from the queue consumer: the demo should not require RabbitMQ to be
 * healthy to show the thing it is demonstrating, and a reader should be able to
 * follow one job from start to finish without a broker in the way.
 */

import { config } from './config.js';
import { logger } from './logger.js';
import { BrowserHost, runPublishJob } from './runner.js';
import type { PublishJob } from './adapters/vitrine.js';

const JOB: PublishJob = {
  listingId: `demo-${config.PROFILE}`,
  title: 'Blouson aviateur B-3 doublé mouton',
  brand: 'Avirex',
  size: 'L',
  condition: 'Très bon état',
  priceEur: 189.0,
  // Kept short on purpose: at a human 110ms median between keystrokes, every
  // character is real time on the clock, and a 170-character description is 20
  // seconds of the demo spent watching a textarea fill up.
  description: 'Porté deux hivers, cuir nourri chaque année. Doublure intacte.',
};

const COLORS = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  green: '[32m',
  yellow: '[33m',
  red: '[31m',
  cyan: '[36m',
};

function bar(score: number, width = 40): string {
  const filled = Math.round((Math.min(100, Math.max(0, score)) / 100) * width);
  const color = score >= 60 ? COLORS.red : score >= 30 ? COLORS.yellow : COLORS.green;
  return `${color}${'█'.repeat(filled)}${COLORS.dim}${'░'.repeat(width - filled)}${COLORS.reset}`;
}

async function main(): Promise<void> {
  const needsBrowser = config.PROFILE !== 'raw-http';
  const host = needsBrowser ? new BrowserHost(config.PROFILE) : null;

  try {
    const result = await runPublishJob(JOB, host, {
      profile: config.PROFILE,
      seed: config.BEHAVIOR_SEED,
    });

    const { outcome } = result;
    const score = 'score' in outcome ? outcome.score : 0;
    const seconds = (result.durationMs / 1000).toFixed(1);

    const lines: string[] = [
      '',
      `${COLORS.bold}${COLORS.cyan}  revendo — ${config.PROFILE} profile${COLORS.reset}`,
      `${COLORS.dim}  ${'─'.repeat(58)}${COLORS.reset}`,
      `  identity    ${result.identity ?? 'n/a'}${result.egressIp ? `  ·  egress ${result.egressIp}` : ''}`,
      `  duration    ${seconds}s`,
      '',
      `  suspicion   ${bar(score)}  ${COLORS.bold}${score}${COLORS.reset}/100`,
      '',
    ];

    switch (outcome.kind) {
      case 'published':
        lines.push(
          `  ${COLORS.green}${COLORS.bold}✓ PUBLISHED${COLORS.reset}  listing ${outcome.marketplaceId} is live`,
        );
        break;
      case 'blocked':
        lines.push(`  ${COLORS.red}${COLORS.bold}✗ BLOCKED${COLORS.reset}  Sentinelle refused the publish`);
        lines.push('');
        for (const reason of outcome.reasons.slice(0, 8)) {
          lines.push(`    ${COLORS.dim}·${COLORS.reset} ${reason}`);
        }
        break;
      case 'challenged':
        lines.push(
          `  ${COLORS.yellow}${COLORS.bold}⚠ CHALLENGED${COLORS.reset}  interstitial served and not solved`,
        );
        break;
      case 'failed':
        lines.push(`  ${COLORS.red}${COLORS.bold}✗ FAILED${COLORS.reset}  ${outcome.error}`);
        break;
    }

    lines.push(
      '',
      `${COLORS.dim}  full signal breakdown → http://localhost:8080/__sentinelle${COLORS.reset}`,
      '',
    );

    process.stdout.write(lines.join('\n') + '\n');

    // Exit code carries the verdict so `make` and CI can branch on it. A blocked bot
    // is a successful *demo*, so only a genuine error is non-zero.
    process.exitCode = outcome.kind === 'failed' ? 1 : 0;
  } catch (err) {
    logger.error({ err }, 'cli run failed');
    process.exitCode = 1;
  } finally {
    await host?.close();
  }
}

void main();
