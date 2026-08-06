/**
 * Text encoding repair + decoding utilities (FR 08-05 item 2 — "special
 * characters in names").
 *
 * Two corruption classes observed in production:
 *  1. Mojibake — UTF-8 bytes mis-decoded as Latin-1/Windows-1252 somewhere in
 *     the FreshService list API: "Rógenes" arrives as "RÃ³genes". Because the
 *     corrupted variant is always LONGER than the clean one, the old
 *     longest-name-wins tiebreaks in requesterRepository kept re-applying it
 *     every sync ("self-healing in reverse").
 *  2. RFC 2047 encoded-words in email display names ("=?utf-8?Q?...?=")
 *     stored verbatim as thread actor names.
 */

// Windows-1252 remaps for bytes 0x80-0x9F (every other byte in 0x80-0xFF
// decodes to the same codepoint under Latin-1 and Windows-1252).
const CP1252_BYTE_TO_CHAR = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
  0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ',
  0x8E: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›',
  0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ',
};

const CP1252_CHAR_TO_BYTE = new Map(
  Object.entries(CP1252_BYTE_TO_CHAR).map(([byte, char]) => [char, Number(byte)]),
);

// Character class matching a UTF-8 continuation byte (0x80-0xBF) after it has
// been mis-decoded: either verbatim (Latin-1, U+0080-U+00BF) or through the
// Windows-1252 punctuation remaps above (e.g. 0x99 → "™").
const CONTINUATION_CHARS = `\u0080-\u00BF${Object.values(CP1252_BYTE_TO_CHAR).join('')}`;

// Mojibake signature: a mis-decoded UTF-8 LEAD byte followed by mis-decoded
// continuation byte(s). We only match the lead bytes that cover real-world
// name corruption — 0xC3 "Ã" (Latin letters U+00C0-U+00FF), 0xC2 "Â"
// (U+0080-U+00BF, incl. NBSP) and 0xE2 "â" (general punctuation, e.g.
// "â€™" = '’') — deliberately NOT every accented lead-alike, so that
// legitimate names containing "Ã" (followed by a plain letter, e.g. "Ãngela")
// never match.
const MOJIBAKE_RE = new RegExp(
  `[ÃÂ][${CONTINUATION_CHARS}]|â[${CONTINUATION_CHARS}]{2}`,
);

/**
 * True when the string carries the UTF-8-as-Latin-1/CP1252 signature
 * ("RÃ³genes", "JosÃ©", "donâ€™t"). Clean accented names ("Rógenes"), CJK and
 * emoji do not match.
 * @param {*} value
 * @returns {boolean}
 */
export function looksMojibake(value) {
  if (typeof value !== 'string' || !value) return false;
  return MOJIBAKE_RE.test(value);
}

/**
 * Re-encode a mis-decoded string back to the byte stream it came from.
 * Returns null when a character is not representable in CP1252/Latin-1 —
 * i.e. the string was never a mis-decoded single-byte stream.
 */
function toCp1252Bytes(value) {
  const bytes = [];
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0xFF) {
      bytes.push(codePoint);
    } else if (CP1252_CHAR_TO_BYTE.has(char)) {
      bytes.push(CP1252_CHAR_TO_BYTE.get(char));
    } else {
      return null;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Repair UTF-8-as-Latin-1/CP1252 mojibake: "RÃ³genes" → "Rógenes".
 *
 * Guarded — the repaired string is only returned when:
 *  - the input actually looks like mojibake (clean strings pass through
 *    untouched, so this is safe to call at every write barrier);
 *  - the decode round-trips losslessly (re-encoding the repaired string as
 *    UTF-8 reproduces the exact byte stream — no U+FFFD replacements);
 *  - the repaired string is strictly shorter in codepoints (a genuine repair
 *    always collapses multi-char sequences);
 *  - the repaired string no longer looks like mojibake (double-encoded input
 *    is handled by iterating; if residual corruption remains the ORIGINAL
 *    input is returned unchanged).
 *
 * Non-strings and empty strings are returned as-is.
 * @param {*} value
 * @returns {*} repaired string, or the input unchanged
 */
export function repairMojibake(value) {
  if (typeof value !== 'string' || !value || !looksMojibake(value)) return value;
  let current = value;
  for (let pass = 0; pass < 3 && looksMojibake(current); pass++) {
    const bytes = toCp1252Bytes(current);
    if (!bytes) break;
    const repaired = bytes.toString('utf8');
    if (repaired.includes('�')) break;
    if (Buffer.compare(Buffer.from(repaired, 'utf8'), bytes) !== 0) break;
    if ([...repaired].length >= [...current].length) break;
    current = repaired;
  }
  return looksMojibake(current) ? value : current;
}

// RFC 2047 encoded-word: =?charset?encoding?encoded-text?=
const ENCODED_WORD_RE = /=\?([A-Za-z0-9!#$%&'*+/^_`{|}~-]+)(?:\*[A-Za-z-]+)?\?([BbQq])\?([^?\s]*)\?=/g;
// Whitespace between two adjacent encoded-words is not rendered (RFC 2047 §6.2).
const ADJACENT_WORDS_RE = /(=\?[A-Za-z0-9!#$%&'*+/^_`{|}~-]+(?:\*[A-Za-z-]+)?\?[BbQq]\?[^?\s]*\?=)[ \t\r\n]+(?==\?)/g;

function decodeBytesForCharset(bytes, charset) {
  const normalized = String(charset).toLowerCase();
  if (normalized === 'utf-8' || normalized === 'utf8' || normalized === 'us-ascii' || normalized === 'ascii') {
    return bytes.toString('utf8');
  }
  if (
    normalized === 'iso-8859-1' || normalized === 'iso8859-1' || normalized === 'latin1'
    || normalized === 'windows-1252' || normalized === 'cp1252'
  ) {
    let out = '';
    for (const byte of bytes) out += CP1252_BYTE_TO_CHAR[byte] || String.fromCharCode(byte);
    return out;
  }
  return null; // unknown charset — leave the encoded-word untouched
}

/**
 * Decode RFC 2047 encoded-words in a header value ("=?utf-8?Q?R=C3=B3genes?=").
 * Supports B (base64) and Q (quoted-printable-ish) encodings for utf-8,
 * us-ascii, iso-8859-1 and windows-1252 charsets; collapses whitespace between
 * adjacent encoded-words per the RFC. Undecodable words (unknown charset,
 * malformed data) are left verbatim. Non-strings pass through unchanged.
 * @param {*} value
 * @returns {*}
 */
export function decodeRfc2047(value) {
  if (typeof value !== 'string' || !value.includes('=?')) return value;
  const joined = value.replace(ADJACENT_WORDS_RE, '$1');
  return joined.replace(ENCODED_WORD_RE, (match, charset, encoding, data) => {
    try {
      let bytes;
      if (encoding.toUpperCase() === 'B') {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return match;
        bytes = Buffer.from(data, 'base64');
      } else {
        const text = data.replace(/_/g, ' ');
        const byteList = [];
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
            byteList.push(parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            byteList.push(text.charCodeAt(i) & 0xFF);
          }
        }
        bytes = Buffer.from(byteList);
      }
      const decoded = decodeBytesForCharset(bytes, charset);
      if (decoded === null || decoded.includes('�')) return match;
      return decoded;
    } catch {
      return match;
    }
  });
}

/**
 * Full display-name cleanup for email/FS-sourced names: RFC 2047 decode, then
 * mojibake repair. Safe on clean input; non-strings pass through unchanged.
 * @param {*} value
 * @returns {*}
 */
export function cleanDisplayName(value) {
  if (typeof value !== 'string' || !value) return value;
  return repairMojibake(decodeRfc2047(value));
}
