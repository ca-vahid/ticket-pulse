/**
 * Browser stand-in for `iconv-lite` (aliased in vite.config.js).
 *
 * @kenjiuno/msgreader (Outlook .msg previews) requires iconv-lite only to
 * decode the odd 8-bit (ANSI code page) string property. The real package
 * pulls in `safer-buffer`, which reads Node's `Buffer` at load time and
 * crashes in the browser, and ships ~300 KB of code-page tables. The
 * browser's own TextDecoder knows every code page an Outlook file uses.
 */

const ALIASES = {
  utf16le: 'utf-16le',
  ucs2: 'utf-16le',
  'ucs-2': 'utf-16le',
  utf8: 'utf-8',
  latin1: 'windows-1252',
  binary: 'windows-1252',
  ascii: 'windows-1252',
};

function label(encoding) {
  const e = String(encoding || 'utf-8').toLowerCase();
  if (ALIASES[e]) return ALIASES[e];
  const cp = /^(?:cp|windows-?)(\d{3,5})$/.exec(e);
  if (cp) return cp[1] === '65001' ? 'utf-8' : `windows-${cp[1]}`;
  return e;
}

export function decode(bytes, encoding) {
  try {
    return new TextDecoder(label(encoding)).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function encode(text, encoding) {
  const enc = label(encoding);
  if (enc === 'utf-8') return new TextEncoder().encode(String(text));
  // Only used when msgreader WRITES a file, which the preview never does.
  const s = String(text);
  if (enc === 'utf-16le') {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      out[i * 2] = c & 0xff;
      out[i * 2 + 1] = c >> 8;
    }
    return out;
  }
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
}

export function encodingExists(encoding) {
  try { new TextDecoder(label(encoding)); return true; } catch { return false; }
}

export default { decode, encode, encodingExists };
