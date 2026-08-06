/**
 * FR 08-05 item 2 — mojibake detection/repair + RFC 2047 decoding.
 *
 * Corrupted fixtures are built programmatically (utf8 bytes re-decoded as
 * latin1/cp1252/cp437) so the test source stays encoding-agnostic:
 * moji('Rógenes') === 'RÃ³genes', mojiCp437('Rógenes') === 'R├│genes'.
 */
import {
  looksMojibake,
  repairMojibake,
  decodeRfc2047,
  cleanDisplayName,
  CP437_BYTE_TO_CHAR,
} from '../src/utils/textEncoding.js';

const CP1252_REMAP = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
  0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ',
  0x8E: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›',
  0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ',
};

/** utf8 bytes mis-decoded as latin1 — the FS list-API corruption */
const moji = (s) => Buffer.from(s, 'utf8').toString('latin1');
/** utf8 bytes mis-decoded as windows-1252 — the smart-quote corruption */
const mojiCp1252 = (s) => [...Buffer.from(s, 'utf8')]
  .map((b) => CP1252_REMAP[b] || String.fromCharCode(b))
  .join('');
/** utf8 bytes mis-decoded as IBM CP437 — the DOS-codepage corruption in prod */
const mojiCp437 = (s) => [...Buffer.from(s, 'utf8')]
  .map((b) => (b < 0x80 ? String.fromCharCode(b) : CP437_BYTE_TO_CHAR.get(b)))
  .join('');

const CLEAN = 'Erick Rógenes Soares';
// Literal prod row (queried live 2026-08): '├' U+251C, '│' U+2502.
const PROD_CP437 = 'Erick R├│genes Soares';

describe('looksMojibake', () => {
  test.each([
    ['latin1-corrupted o-acute', moji('Rógenes'), true],
    ['latin1-corrupted e-acute', moji('José'), true],
    ['latin1-corrupted n-tilde', moji('España'), true],
    ['latin1-corrupted u-umlaut', moji('Müller'), true],
    ['cp1252-corrupted apostrophe', mojiCp1252('don’t'), true],
    ['full corrupted name', moji(CLEAN), true],
    ['cp437-corrupted o-acute (prod evidence)', PROD_CP437, true],
    ['cp437-corrupted e-acute', mojiCp437('José'), true],
    ['cp437-corrupted n-tilde', mojiCp437('España'), true],
    ['cp437-corrupted u-umlaut', mojiCp437('Müller'), true],
    ['cp437-corrupted apostrophe (Greek 3-byte shape)', mojiCp437('don’t'), true],
    ['lone box-drawing char (never legit in a name)', 'x│y', true],
    ['clean accented name', CLEAN, false],
    ['clean ASCII', 'John Smith', false],
    ['clean A-tilde name (letter follows)', 'Ãngela', false],
    ['clean a-tilde name', 'João', false],
    ['lone Greek letters (no continuation pair)', 'α β Ω delta', false],
    ['micro-units', '5µm fiber', false],
    ['math symbols', '±5 ÷ 2 ≈ 2.5°', false],
    ['CJK', '田中太郎', false],
    ['emoji', 'Party \u{1F389}', false],
    ['empty string', '', false],
  ])('%s -> %s', (_label, input, expected) => {
    expect(looksMojibake(input)).toBe(expected);
  });

  test('non-strings are false', () => {
    expect(looksMojibake(null)).toBe(false);
    expect(looksMojibake(undefined)).toBe(false);
    expect(looksMojibake(42)).toBe(false);
  });
});

describe('repairMojibake', () => {
  test('repairs the QA case: latin1-mis-decoded accented name', () => {
    expect(repairMojibake(moji(CLEAN))).toBe(CLEAN);
  });

  test.each([
    ['José'], ['España'], ['Müller'], ['don’t'],
  ])('round-trips %s', (clean) => {
    expect(repairMojibake(moji(clean))).toBe(clean);
  });

  test('repairs cp1252-mis-decoded smart quotes', () => {
    expect(repairMojibake(mojiCp1252('don’t'))).toBe('don’t');
  });

  test('repairs double-encoded input by iterating', () => {
    expect(repairMojibake(moji(moji(CLEAN)))).toBe(CLEAN);
  });

  test('no-op on clean input (accented, ASCII, CJK, emoji)', () => {
    for (const s of [CLEAN, 'John Smith', '田中太郎', 'Party \u{1F389}', 'Ãngela']) {
      expect(repairMojibake(s)).toBe(s);
    }
  });

  test('no-op on non-strings and empty', () => {
    expect(repairMojibake(null)).toBe(null);
    expect(repairMojibake(undefined)).toBe(undefined);
    expect(repairMojibake('')).toBe('');
  });

  test('leaves mixed mojibake+CJK untouched (not a mis-decoded byte stream)', () => {
    const mixed = moji('ó') + '田';
    expect(repairMojibake(mixed)).toBe(mixed);
  });

  test('leaves strings that do not decode as valid UTF-8 untouched', () => {
    // Â£ looks like a mojibake pair but the trailing Ã is a
    // truncated lead byte -> decode would need U+FFFD -> guard rejects.
    const notUtf8 = 'Â£Ã';
    expect(repairMojibake(notUtf8)).toBe(notUtf8);
  });

  test('repaired output is strictly shorter in codepoints', () => {
    const corrupted = moji(CLEAN);
    const repaired = repairMojibake(corrupted);
    expect([...repaired].length).toBeLessThan([...corrupted].length);
  });
});

describe('repairMojibake — CP437/CP850 (DOS codepages, the prod pattern)', () => {
  test('CP437 reverse table maps the signature chars to the right bytes', () => {
    expect(CP437_BYTE_TO_CHAR.size).toBe(128);
    expect(CP437_BYTE_TO_CHAR.get(0xC3)).toBe('├'); // U+251C
    expect(CP437_BYTE_TO_CHAR.get(0xB3)).toBe('│'); // U+2502
    expect(CP437_BYTE_TO_CHAR.get(0xA9)).toBe('⌐'); // U+2310
    expect('├'.codePointAt(0)).toBe(0x251C);
    expect('│'.codePointAt(0)).toBe(0x2502);
  });

  test('EXACT prod case: "Erick R├│genes Soares" → "Erick Rógenes Soares"', () => {
    // ó = UTF-8 0xC3 0xB3; decoded as CP437 → U+251C U+2502.
    expect([...PROD_CP437].map((c) => c.codePointAt(0)))
      .toEqual(expect.arrayContaining([0x251C, 0x2502]));
    expect(mojiCp437(CLEAN)).toBe(PROD_CP437); // helper reproduces the live row
    expect(looksMojibake(PROD_CP437)).toBe(true);
    expect(repairMojibake(PROD_CP437)).toBe(CLEAN);
    expect(cleanDisplayName(PROD_CP437)).toBe(CLEAN);
  });

  test('é as CP437: 0xC3 0xA9 → "├⌐"', () => {
    expect(mojiCp437('José')).toBe('Jos├⌐');
    expect(repairMojibake('Jos├⌐')).toBe('José');
  });

  test.each([
    ['España'], ['Müller'], ['João'], ['Çelik'], ['Rógenes'],
  ])('round-trips %s through CP437 corruption', (clean) => {
    expect(repairMojibake(mojiCp437(clean))).toBe(clean);
  });

  test('CP437-corrupted smart quote (3-byte UTF-8, Greek lead)', () => {
    expect(mojiCp437('don’t')).toBe('donΓÇÖt'); // ’ = E2 80 99 → Γ Ç Ö
    expect(repairMojibake('donΓÇÖt')).toBe('don’t');
  });

  test('CP850 variant: é arrives as "├®" (0xA9 = ® under CP850)', () => {
    expect(repairMojibake('Jos├®')).toBe('José');
  });

  test('double-encoded CP437 repairs by iterating', () => {
    expect(repairMojibake(mojiCp437(mojiCp437(CLEAN)))).toBe(CLEAN);
  });

  test('box-drawing diagram text flags but survives repair untouched', () => {
    // Repair-if-valid semantics: these flag as mojibake (box chars are never
    // legit in a NAME), but stray box chars re-encode to invalid UTF-8 byte
    // sequences, so every repair guard rejects and the input passes through.
    // A diagram string that DID round-trip as valid UTF-8 would be repaired —
    // accepted, since that shape is exactly the corruption we hunt.
    for (const s of ['│ Legend │ Value │', '├─ item ─┤', '░░ 50% ░░']) {
      expect(looksMojibake(s)).toBe(true);
      expect(repairMojibake(s)).toBe(s);
    }
  });

  test('mixed CP1252+CP437 corruption is left untouched (no single byte stream)', () => {
    const mixed = `${moji('ó')} ${mojiCp437('ó')}`; // "Ã³ ├│"
    expect(looksMojibake(mixed)).toBe(true);
    expect(repairMojibake(mixed)).toBe(mixed);
  });

  test('CP1252 corruption still repairs (regression: codec order)', () => {
    expect(repairMojibake(moji(CLEAN))).toBe(CLEAN);
    expect(repairMojibake(mojiCp1252('don’t'))).toBe('don’t');
  });
});

describe('decodeRfc2047', () => {
  test('Q-encoded utf-8 (underscore = space, =XX bytes)', () => {
    expect(decodeRfc2047('=?utf-8?Q?Erick_R=C3=B3genes?=')).toBe('Erick Rógenes');
  });

  test('B-encoded utf-8', () => {
    const b64 = Buffer.from(CLEAN, 'utf8').toString('base64');
    expect(decodeRfc2047(`=?UTF-8?B?${b64}?=`)).toBe(CLEAN);
  });

  test('Q-encoded iso-8859-1', () => {
    expect(decodeRfc2047('=?iso-8859-1?Q?R=F3genes?=')).toBe('Rógenes');
  });

  test('Q-encoded windows-1252 remaps 0x80-0x9F punctuation', () => {
    expect(decodeRfc2047('=?windows-1252?Q?don=92t?=')).toBe('don’t');
  });

  test('adjacent encoded-words: separating whitespace is dropped (RFC 2047 6.2)', () => {
    expect(decodeRfc2047('=?utf-8?Q?Erick?= =?utf-8?Q?_R=C3=B3genes?='))
      .toBe('Erick Rógenes');
    expect(decodeRfc2047('=?utf-8?B?RXJpY2s=?=\r\n =?utf-8?Q?_Soares?='))
      .toBe('Erick Soares');
  });

  test('encoded-words mixed with plain text keep the plain text', () => {
    expect(decodeRfc2047('Hello =?utf-8?Q?R=C3=B3genes?= world'))
      .toBe('Hello Rógenes world');
  });

  test('plain strings and non-strings pass through unchanged', () => {
    expect(decodeRfc2047('Plain Name')).toBe('Plain Name');
    expect(decodeRfc2047(null)).toBe(null);
    expect(decodeRfc2047(undefined)).toBe(undefined);
  });

  test('unknown charsets and malformed data are left verbatim', () => {
    expect(decodeRfc2047('=?ks_c_5601-1987?B?eA==?=')).toBe('=?ks_c_5601-1987?B?eA==?=');
    expect(decodeRfc2047('=?utf-8?B?not base64!!?=')).toBe('=?utf-8?B?not base64!!?=');
  });
});

describe('parseRfc822Address (transformer integration)', () => {
  test('decodes RFC 2047 encoded display names', async () => {
    const { parseRfc822Address } = await import('../src/integrations/freshserviceTransformer.js');
    expect(parseRfc822Address('=?utf-8?Q?Erick_R=C3=B3genes?= <erick@example.com>'))
      .toEqual({ name: 'Erick Rógenes', email: 'erick@example.com' });
  });

  test('repairs mojibake display names', async () => {
    const { parseRfc822Address } = await import('../src/integrations/freshserviceTransformer.js');
    expect(parseRfc822Address(`"${moji(CLEAN)}" <erick@example.com>`))
      .toEqual({ name: CLEAN, email: 'erick@example.com' });
  });

  test('clean headers are unaffected', async () => {
    const { parseRfc822Address } = await import('../src/integrations/freshserviceTransformer.js');
    expect(parseRfc822Address('"Andrii Grynik" <it@bgcengineering.ca>'))
      .toEqual({ name: 'Andrii Grynik', email: 'it@bgcengineering.ca' });
  });
});

describe('cleanDisplayName', () => {
  test('decodes RFC 2047 then repairs mojibake', () => {
    // an encoded-word whose *decoded payload* is itself mojibake
    const b64 = Buffer.from(moji(CLEAN), 'utf8').toString('base64');
    expect(cleanDisplayName(`=?utf-8?B?${b64}?=`)).toBe(CLEAN);
  });

  test('no-op on clean input and non-strings', () => {
    expect(cleanDisplayName('John Smith')).toBe('John Smith');
    expect(cleanDisplayName(null)).toBe(null);
  });
});
