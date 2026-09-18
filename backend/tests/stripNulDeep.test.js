import { stripNulDeep } from '../src/utils/textEncoding.js';

describe('stripNulDeep — U+0000 never reaches Postgres', () => {
  test('removes NUL from strings at any depth', () => {
    const out = stripNulDeep({
      subject: 'Invoice\u0000 4471',
      customFields: { note: 'a\u0000b', list: ['x\u0000', 'y'] },
    });
    expect(out).toEqual({ subject: 'Invoice 4471', customFields: { note: 'ab', list: ['x', 'y'] } });
  });

  test('returns the same reference when there is nothing to strip', () => {
    const data = { subject: 'clean', nested: { a: [1, 'b'] } };
    expect(stripNulDeep(data)).toBe(data);
  });

  test('leaves Date, BigInt, Buffer, null, numbers and booleans alone', () => {
    const when = new Date('2026-09-18T20:25:00Z');
    const buf = Buffer.from([0, 1, 2]);
    const out = stripNulDeep({ when, id: 243099n, buf, none: null, n: 3, ok: false, s: '\u0000' });
    expect(out.when).toBe(when);
    expect(out.id).toBe(243099n);
    expect(out.buf).toBe(buf);
    expect(out.none).toBeNull();
    expect(out.n).toBe(3);
    expect(out.ok).toBe(false);
    expect(out.s).toBe('');
  });

  test('does not mutate its input', () => {
    const data = { subject: 'a\u0000' };
    stripNulDeep(data);
    expect(data.subject).toBe('a\u0000');
  });
});
