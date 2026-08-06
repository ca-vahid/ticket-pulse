/**
 * FR 08-05 item 2 — mojibake detection/repair + RFC 2047 decoding.
 *
 * Corrupted fixtures are built programmatically (utf8 bytes re-decoded as
 * latin1/cp1252) so the test source stays encoding-agnostic: moji('Rógenes')
 * === 'RÃ³genes'.
 */
import {
  looksMojibake,
  repairMojibake,
  decodeRfc2047,
  cleanDisplayName,
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

const CLEAN = 'Erick Rógenes Soares';

describe('looksMojibake', () => {
  test.each([
    ['latin1-corrupted o-acute', moji('Rógenes'), true],
    ['latin1-corrupted e-acute', moji('José'), true],
    ['latin1-corrupted n-tilde', moji('España'), true],
    ['latin1-corrupted u-umlaut', moji('Müller'), true],
    ['cp1252-corrupted apostrophe', mojiCp1252('don’t'), true],
    ['full corrupted name', moji(CLEAN), true],
    ['clean accented name', CLEAN, false],
    ['clean ASCII', 'John Smith', false],
    ['clean A-tilde name (letter follows)', 'Ãngela', false],
    ['clean a-tilde name', 'João', false],
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
