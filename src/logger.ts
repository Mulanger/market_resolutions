import pino from 'pino';
import { loadConfig } from './config.js';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger) return _logger;

  const config = loadConfig();
  _logger = pino({
    level: config.logLevel,
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  return _logger;
}
