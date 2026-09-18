/**
 * Fold bare primitives that follow a log message INTO the message.
 *
 * Winston treats the second argument as a metadata object and copies its keys
 * onto the log record. Hand it a string — `logger.error('…failed:', err.message)`
 * — and it copies the string's characters one by one, so production printed
 *
 *   SSE workspace validation failed (DB); allowing stream: { "0": "D", "1": "a", "2": "t", … }
 *
 * and the actual reason had to be read down a column (hourly review, 18 Sep
 * 2026). Thirteen call sites share the habit, and the next one written will
 * too, so the fix lives here once instead of at every caller.
 *
 * Pure and dependency-free so it can be tested without loading the logger
 * (which pulls in config and opens file transports in production).
 *
 * Left alone on purpose:
 *  - printf-style calls (`logger.info('took %d ms', n)`) — winston's splat
 *    format owns those arguments;
 *  - objects, Errors and arrays — they are real metadata.
 */
const PRINTF_TOKEN = /%[sdifjoO]/;
const isFoldable = (v) => ['string', 'number', 'boolean', 'bigint'].includes(typeof v);

export function foldPrimitiveMeta(message, rest = []) {
  if (!rest.length) return [message];
  if (typeof message === 'string' && PRINTF_TOKEN.test(message)) return [message, ...rest];
  const remaining = [...rest];
  let folded = message;
  while (remaining.length && isFoldable(remaining[0])) {
    folded = `${folded} ${remaining.shift()}`;
  }
  return [folded, ...remaining];
}

export default { foldPrimitiveMeta };
