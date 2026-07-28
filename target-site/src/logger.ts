import pino from 'pino';
import { config } from './config.js';

/**
 * Structured logs, always. The demo prints them through pino-pretty for humans, but
 * the shape on the wire is JSON so it would drop straight into Loki or CloudWatch
 * without a parser that has to be maintained forever.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'vitrine' },
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino/file', options: { destination: 1 } },
});
