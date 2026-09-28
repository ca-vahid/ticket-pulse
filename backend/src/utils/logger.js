import winston from 'winston';
import config from '../config/index.js';
import { foldPrimitiveMeta } from './logArgs.js';

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

// Tell winston about our colors
winston.addColors(colors);

// Define log format
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
);

// Serialise log metadata without ever throwing. An HTTP client error carries its
// request and response, which point at each other; plain JSON.stringify threw
// "Converting circular structure to JSON" from inside logger.error, and that
// TypeError replaced the real error in the caller (28 Sep 2026: FreshService
// 404s for deleted tickets surfaced as 759 circular-JSON failures).
const OPAQUE = new Set(['ClientRequest', 'IncomingMessage', 'Socket', 'TLSSocket', 'Agent', 'HTTPParser', 'Timeout']);
export function safeMetaString(meta) {
  try {
    return JSON.stringify(meta, null, 2);
  } catch { /* circular or otherwise unserialisable: fall through */ }
  const seen = new WeakSet();
  try {
    return JSON.stringify(meta, (key, value) => {
      if (value && typeof value === 'object') {
        const ctor = value.constructor?.name;
        if (ctor && OPAQUE.has(ctor)) return `[${ctor}]`;
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }, 2);
  } catch (err) {
    return `[unserialisable log metadata: ${err.message}]`;
  }
}

// Define console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(info => {
    const { timestamp, level, message, ...meta } = info;
    const metaStr = Object.keys(meta).length ? safeMetaString(meta) : '';
    return `${timestamp} [${level}]: ${message} ${metaStr}`;
  }),
);

// Define transports
const transports = [];

// Console transport (always enabled)
transports.push(
  new winston.transports.Console({
    format: consoleFormat,
  }),
);

// File transports (only in production)
if (config.isProduction) {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format,
    }),
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: config.isDevelopment ? 'debug' : 'info',
  levels,
  format,
  transports,
  exitOnError: false,
});

// A bare string after the message (`logger.error('…failed:', err.message)`) is
// read by winston as a metadata OBJECT and spread one character per key. Fold
// such primitives into the message before winston sees them — see logArgs.js.
for (const level of Object.keys(levels)) {
  const original = logger[level].bind(logger);
  logger[level] = (message, ...rest) => original(...foldPrimitiveMeta(message, rest));
}

// Create stream for morgan (HTTP logging)
logger.stream = {
  write: message => {
    logger.http(message.trim());
  },
};

export default logger;
