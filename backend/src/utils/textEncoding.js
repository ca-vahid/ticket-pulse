/**
 * Text encoding repair + decoding utilities (FR 08-05 item 2 — "special
 * characters in names").
 *
 * Corruption classes observed in production:
 *  1. Mojibake — UTF-8 bytes mis-decoded as Latin-1/Windows-1252 somewhere in
 *     the FreshService list API: "Rógenes" arrives as "RÃ³genes". Because the
 *     corrupted variant is always LONGER than the clean one, the old
 *     longest-name-wins tiebreaks in requesterRepository kept re-applying it
 *     every sync ("self-healing in reverse").
 *  1b. Mojibake via DOS codepages — UTF-8 bytes mis-decoded as IBM CP437 (or
 *     its western-European sibling CP850): "Rógenes" arrives as "R├│genes"
 *     (0xC3 → U+251C '├', 0xB3 → U+2502 '│'). This is the pattern actually
 *     found in prod requester rows; the giveaway is box-drawing/block chars
 *     embedded in words.
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

// ---------------------------------------------------------------------------
// IBM CP437 (and CP850 variant) — DOS OEM codepages.
//
// Canonical CP437 codepoints for bytes 0x80-0xFF, from the unicode.org
// CP437 mapping table (verified against Python's cp437 codec). Index i in
// this list is byte 0x80 + i. Notable for the prod corruption signature:
// 0xC3 → U+251C '├' and 0xB3 → U+2502 '│', so UTF-8 "ó" (0xC3 0xB3)
// mis-decoded as CP437 renders "├│".
const CP437_HIGH_CODEPOINTS = [
  // 0x80-0x8F: Ç ü é â ä à å ç ê ë è ï î ì Ä Å
  0x00C7, 0x00FC, 0x00E9, 0x00E2, 0x00E4, 0x00E0, 0x00E5, 0x00E7,
  0x00EA, 0x00EB, 0x00E8, 0x00EF, 0x00EE, 0x00EC, 0x00C4, 0x00C5,
  // 0x90-0x9F: É æ Æ ô ö ò û ù ÿ Ö Ü ¢ £ ¥ ₧ ƒ
  0x00C9, 0x00E6, 0x00C6, 0x00F4, 0x00F6, 0x00F2, 0x00FB, 0x00F9,
  0x00FF, 0x00D6, 0x00DC, 0x00A2, 0x00A3, 0x00A5, 0x20A7, 0x0192,
  // 0xA0-0xAF: á í ó ú ñ Ñ ª º ¿ ⌐ ¬ ½ ¼ ¡ « »
  0x00E1, 0x00ED, 0x00F3, 0x00FA, 0x00F1, 0x00D1, 0x00AA, 0x00BA,
  0x00BF, 0x2310, 0x00AC, 0x00BD, 0x00BC, 0x00A1, 0x00AB, 0x00BB,
  // 0xB0-0xBF: ░ ▒ ▓ │ ┤ ╡ ╢ ╖ ╕ ╣ ║ ╗ ╝ ╜ ╛ ┐
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
  // 0xC0-0xCF: └ ┴ ┬ ├ ─ ┼ ╞ ╟ ╚ ╔ ╩ ╦ ╠ ═ ╬ ╧
  0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F,
  0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567,
  // 0xD0-0xDF: ╨ ╤ ╥ ╙ ╘ ╒ ╓ ╫ ╪ ┘ ┌ █ ▄ ▌ ▐ ▀
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B,
  0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580,
  // 0xE0-0xEF: α ß Γ π Σ σ µ τ Φ Θ Ω δ ∞ φ ε ∩
  0x03B1, 0x00DF, 0x0393, 0x03C0, 0x03A3, 0x03C3, 0x00B5, 0x03C4,
  0x03A6, 0x0398, 0x03A9, 0x03B4, 0x221E, 0x03C6, 0x03B5, 0x2229,
  // 0xF0-0xFF: ≡ ± ≥ ≤ ⌠ ⌡ ÷ ≈ ° ∙ · √ ⁿ ² ■ NBSP
  0x2261, 0x00B1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00F7, 0x2248,
  0x00B0, 0x2219, 0x00B7, 0x221A, 0x207F, 0x00B2, 0x25A0, 0x00A0,
];

const CP437_HIGH_CHARS = CP437_HIGH_CODEPOINTS.map((cp) => String.fromCodePoint(cp));

/** byte (0x80-0xFF) → char under CP437. Exported for tests/fixtures. */
export const CP437_BYTE_TO_CHAR = new Map(
  CP437_HIGH_CHARS.map((char, i) => [0x80 + i, char]),
);

const CP437_CHAR_TO_BYTE = new Map(
  CP437_HIGH_CHARS.map((char, i) => [char, 0x80 + i]),
);

// CP850 = CP437 with these bytes remapped (western-European Latin-1 coverage
// traded for the double-line box chars and symbols). From unicode.org cp850.
const CP850_BYTE_OVERRIDES = new Map([
  [0x9B, 0x00F8], [0x9D, 0x00D8], [0x9E, 0x00D7], [0xA9, 0x00AE],
  [0xB5, 0x00C1], [0xB6, 0x00C2], [0xB7, 0x00C0], [0xB8, 0x00A9],
  [0xBD, 0x00A2], [0xBE, 0x00A5], [0xC6, 0x00E3], [0xC7, 0x00C3],
  [0xCF, 0x00A4], [0xD0, 0x00F0], [0xD1, 0x00D0], [0xD2, 0x00CA],
  [0xD3, 0x00CB], [0xD4, 0x00C8], [0xD5, 0x0131], [0xD6, 0x00CD],
  [0xD7, 0x00CE], [0xD8, 0x00CF], [0xDD, 0x00A6], [0xDE, 0x00CC],
  [0xE0, 0x00D3], [0xE2, 0x00D4], [0xE3, 0x00D2], [0xE4, 0x00F5],
  [0xE5, 0x00D5], [0xE7, 0x00FE], [0xE8, 0x00DE], [0xE9, 0x00DA],
  [0xEA, 0x00DB], [0xEB, 0x00D9], [0xEC, 0x00FD], [0xED, 0x00DD],
  [0xEE, 0x00AF], [0xEF, 0x00B4], [0xF0, 0x00AD], [0xF2, 0x2017],
  [0xF3, 0x00BE], [0xF4, 0x00B6], [0xF5, 0x00A7], [0xF7, 0x00B8],
  [0xF9, 0x00A8], [0xFB, 0x00B9], [0xFC, 0x00B3],
]);

const CP850_CHAR_TO_BYTE = new Map();
CP437_HIGH_CODEPOINTS.forEach((cp, i) => {
  const byte = 0x80 + i;
  const char = String.fromCodePoint(CP850_BYTE_OVERRIDES.get(byte) ?? cp);
  if (!CP850_CHAR_TO_BYTE.has(char)) CP850_CHAR_TO_BYTE.set(char, byte);
});

// CP437 detection classes (none of these chars are regex metacharacters —
// the whole high set is non-ASCII — so plain join() inside [...] is safe).
//
// STRONG: box-drawing + block-element chars (U+2500-U+259F slice of the CP437
// set). A legitimate display name never contains these, so ONE anywhere flags
// the string. Conveniently every UTF-8 two-byte lead (0xC2-0xDF) maps to a
// STRONG char under CP437, so all mis-decoded two-byte sequences (the entire
// Latin-1 accented range — the real-world name corruption) are covered.
const CP437_STRONG_CHARS = CP437_HIGH_CHARS.filter((char) => {
  const cp = char.codePointAt(0);
  return cp >= 0x2500 && cp <= 0x259F;
});
// Continuation class: chars for bytes 0x80-0xBF (valid UTF-8 continuations).
const CP437_CONT_CHARS = CP437_HIGH_CHARS.slice(0x00, 0x40);
// Three-byte-lead class: chars for bytes 0xE0-0xEF (mostly Greek, plus ß/µ).
// These are legit in real text ("5µm", "Ω"), so they only flag when followed
// by TWO continuation-class chars — the exact mis-decoded three-byte UTF-8
// shape (e.g. '’' = E2 80 99 → "ΓÇÖ"). Lone Greek letters, ÷, ± never flag.
const CP437_LEAD3_CHARS = CP437_HIGH_CHARS.slice(0x60, 0x70);

const CP437_STRONG_RE = new RegExp(`[${CP437_STRONG_CHARS.join('')}]`);
const CP437_LEAD3_RE = new RegExp(
  `[${CP437_LEAD3_CHARS.join('')}][${CP437_CONT_CHARS.join('')}]{2}`,
);

// ---------------------------------------------------------------------------

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
 * True when the string carries a mis-decoded-UTF-8 signature:
 *  - Latin-1/CP1252: "RÃ³genes", "JosÃ©", "donâ€™t";
 *  - CP437/CP850 (DOS codepages, the prod requester pattern): "R├│genes" —
 *    any box-drawing/block char flags, and CP437 Greek/symbol chars flag only
 *    in the three-byte lead+continuation+continuation shape ("ΓÇÖ").
 * Clean accented names ("Rógenes", "José"), lone Greek/math symbols
 * ("5µm", "±2"), CJK and emoji do not match.
 * @param {*} value
 * @returns {boolean}
 */
export function looksMojibake(value) {
  if (typeof value !== 'string' || !value) return false;
  return MOJIBAKE_RE.test(value)
    || CP437_STRONG_RE.test(value)
    || CP437_LEAD3_RE.test(value);
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
 * Re-encode a mis-decoded string back to a DOS-codepage byte stream.
 * Strict: ASCII maps to itself; high bytes only through the codec table.
 * Returns null when any char is not producible by that codec's decode —
 * i.e. the string was never a mis-decoded stream of that codepage.
 */
function toOemBytes(value, charToByte) {
  const bytes = [];
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (charToByte.has(char)) {
      bytes.push(charToByte.get(char));
    } else {
      return null;
    }
  }
  return Buffer.from(bytes);
}

// Reverse codecs tried in order per repair pass. CP1252/Latin-1 first
// (pre-existing behavior), then CP437 (the observed prod DOS-codepage
// pattern), then CP850 (same box-drawing signature, different accented-char
// bytes — e.g. é arrives as "├®" under CP850 vs "├⌐" under CP437). The
// codecs are mutually exclusive on real corruption: CP1252 mojibake contains
// Ã/Â/â which CP437 cannot re-encode, and CP437 mojibake contains box chars
// which CP1252 cannot re-encode, so first-match-wins is unambiguous.
const REVERSE_CODECS = [
  toCp1252Bytes,
  (value) => toOemBytes(value, CP437_CHAR_TO_BYTE),
  (value) => toOemBytes(value, CP850_CHAR_TO_BYTE),
];

/**
 * Repair mis-decoded-UTF-8 mojibake: "RÃ³genes" → "Rógenes" (CP1252/Latin-1),
 * "R├│genes" → "Rógenes" (CP437/CP850).
 *
 * Guarded — a repaired string is only returned when:
 *  - the input actually looks like mojibake (clean strings pass through
 *    untouched, so this is safe to call at every write barrier);
 *  - some reverse codec maps every char back to a byte, and that byte stream
 *    decodes as UTF-8 losslessly (exact round-trip, no U+FFFD replacements);
 *  - the repaired string is strictly shorter in codepoints (a genuine repair
 *    always collapses multi-char sequences);
 *  - the repaired string no longer looks like mojibake (double-encoded input
 *    is handled by iterating, max 3 passes; if residual corruption remains
 *    the ORIGINAL input is returned unchanged).
 *
 * Repair-if-valid semantics: a string that legitimately contains box-drawing
 * chars (ASCII-art diagrams) is flagged by looksMojibake, but almost never
 * survives the UTF-8 round-trip guard (stray box chars re-encode to invalid
 * byte sequences), so it passes through unchanged.
 *
 * Non-strings and empty strings are returned as-is.
 * @param {*} value
 * @returns {*} repaired string, or the input unchanged
 */
export function repairMojibake(value) {
  if (typeof value !== 'string' || !value || !looksMojibake(value)) return value;
  let current = value;
  for (let pass = 0; pass < 3 && looksMojibake(current); pass++) {
    let repaired = null;
    for (const toBytes of REVERSE_CODECS) {
      const bytes = toBytes(current);
      if (!bytes) continue;
      const candidate = bytes.toString('utf8');
      if (candidate.includes('�')) continue;
      if (Buffer.compare(Buffer.from(candidate, 'utf8'), bytes) !== 0) continue;
      if ([...candidate].length >= [...current].length) continue;
      repaired = candidate;
      break;
    }
    if (repaired === null) break;
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
