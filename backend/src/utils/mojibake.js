// Repairs one specific kind of garbled name: UTF-8 bytes that were read as
// code page 437 (the Windows console code page) and stored that way, so
// "é" (C3 A9) became "├⌐" (QA 10-26 #8). Only strings holding the CP437 form
// of a UTF-8 Latin-1 lead byte (├ = C3, ┬ = C2) are touched, and only when
// every character maps back to a byte and the bytes decode as valid UTF-8.
// Anything else comes back unchanged.

// CP437 characters for bytes 0x80..0xFF, in byte order.
const CP437_HIGH = [
  'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å',
  'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ',
  'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»',
  '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐',
  '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧',
  '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀',
  'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩',
  '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', ' ',
];
const CP437_BYTE = new Map(CP437_HIGH.map((char, index) => [char, 0x80 + index]));
const LEAD_MARKERS = /[├┬]/;

export function repairCp437Mojibake(value) {
  if (typeof value !== 'string' || !LEAD_MARKERS.test(value)) return value;
  const bytes = [];
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const byte = CP437_BYTE.get(char);
    if (byte === undefined) return value;
    bytes.push(byte);
  }
  let repaired;
  try {
    repaired = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return value;
  }
  return LEAD_MARKERS.test(repaired) ? value : repaired;
}

export default repairCp437Mojibake;
