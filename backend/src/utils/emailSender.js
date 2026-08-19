/**
 * Outbound sender-identity helpers (Phase EB).
 *
 * SendGrid's v3 API takes `from: { email, name }` natively, but the SMTP
 * (nodemailer) path and any raw header wants a single RFC 5322 mailbox
 * string: `"Display Name" <address>`. Quoting matters — commas and other
 * specials in an unquoted display name split the header, and quotes /
 * backslashes inside a quoted string must be escaped.
 */

const MAX_FROM_NAME_LENGTH = 80;

/**
 * Normalize a from display name: trim, strip characters that could break
 * out of the display-name position (angle brackets, CR/LF header
 * injection), and cap the length. Returns null when nothing usable is left.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function sanitizeFromName(value) {
  const text = String(value ?? '')
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.slice(0, MAX_FROM_NAME_LENGTH).trim() || null;
}

/**
 * Format an RFC 5322 sender mailbox. With a display name the result is
 * always the quoted-string form (`"Name" <addr>`) — quoting unconditionally
 * sidesteps the atom/special distinction and is valid for every name.
 * Without a usable name (or address) it degrades gracefully.
 *
 * @param {{ name?: string|null, email?: string|null }} sender
 * @returns {string|null} `"Name" <addr>`, plain address, or null when no address
 */
export function formatSender({ name = null, email = null } = {}) {
  const address = String(email ?? '').trim();
  if (!address) return null;
  const displayName = sanitizeFromName(name);
  if (!displayName) return address;
  const escaped = displayName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}" <${address}>`;
}

export { MAX_FROM_NAME_LENGTH };

export default { formatSender, sanitizeFromName, MAX_FROM_NAME_LENGTH };
