/**
 * FR 08-05 item 2 — requester name tiebreaks must never prefer (or store) the
 * mojibake variant. The corrupted form of an accented name is always LONGER
 * ("RÃ³genes" > "Rógenes"), so the old longest-wins tiebreaks re-applied
 * corruption every sync; these tests pin the fixed behavior.
 */
import { jest } from '@jest/globals';

const prismaMock = {
  requester: {
    create: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { default: requesterRepository } = await import('../src/services/requesterRepository.js');

/** utf8 bytes mis-decoded as latin1 — the FS list-API corruption */
const moji = (s) => Buffer.from(s, 'utf8').toString('latin1');

const CLEAN = 'Erick Rógenes Soares';
const CORRUPTED = moji(CLEAN); // 'Erick RÃ³genes Soares' — longer than CLEAN

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.requester.create.mockImplementation(async ({ data }) => data);
  prismaMock.requester.upsert.mockImplementation(async ({ create }) => create);
  prismaMock.requester.update.mockResolvedValue({});
});

describe('upsert name tiebreak', () => {
  const base = { id: 123, primary_email: 'erick@example.com' };

  const upsertedName = () => prismaMock.requester.upsert.mock.calls[0][0].update.name;

  test('clean API name beats a LONGER mojibake embedded name', async () => {
    await requesterRepository.upsert(
      { ...base, first_name: 'Erick', last_name: 'Rógenes Soares' },
      { embeddedName: CORRUPTED },
    );
    expect(upsertedName()).toBe(CLEAN);
  });

  test('mojibake embedded name is repaired, then still wins when fuller', async () => {
    await requesterRepository.upsert(
      { ...base, first_name: 'Erick' },
      { embeddedName: CORRUPTED },
    );
    expect(upsertedName()).toBe(CLEAN); // repaired, never stored corrupted
  });

  test('longer clean embedded name still beats a shorter API name', async () => {
    await requesterRepository.upsert(
      { ...base, first_name: 'Erick' },
      { embeddedName: CLEAN },
    );
    expect(upsertedName()).toBe(CLEAN);
  });

  test('clean-vs-clean falls back to codepoint length (API name wins ties)', async () => {
    await requesterRepository.upsert(
      { ...base, first_name: 'Erick', last_name: 'Rógenes Soares' },
      { embeddedName: 'Erick R.' },
    );
    expect(upsertedName()).toBe(CLEAN);
  });

  test('missing candidates fall back to Unknown', async () => {
    await requesterRepository.upsert(base, {});
    expect(upsertedName()).toBe('Unknown');
  });
});

describe('fixIncompleteNames sweep', () => {
  const row = (name) => ({ id: 1, freshserviceId: BigInt(123), name });
  const sweep = (storedName, embeddedName) => {
    prismaMock.requester.findMany.mockResolvedValue([row(storedName)]);
    return requesterRepository.fixIncompleteNames(new Map([['123', embeddedName]]));
  };

  test('NEVER overwrites a clean stored name with a longer mojibake candidate', async () => {
    // repaired candidate === stored name -> nothing to do (the old code
    // overwrote here because the corrupted variant is longer)
    const fixed = await sweep(CLEAN, CORRUPTED);
    expect(fixed).toBe(0);
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
  });

  test('leaves a clean stored name alone when the candidate cannot be repaired', async () => {
    // mixed mojibake+CJK does not round-trip -> stays mojibake -> skipped
    const fixed = await sweep('Erick', `${moji('ó')}田`);
    expect(fixed).toBe(0);
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
  });

  test('repairs a mojibake stored name even when the clean candidate is SHORTER', async () => {
    const fixed = await sweep(CORRUPTED, CLEAN);
    expect(fixed).toBe(1);
    expect(prismaMock.requester.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: CLEAN },
    });
  });

  test('mojibake candidate that repairs to a fuller name is applied repaired', async () => {
    const fixed = await sweep('Erick', CORRUPTED);
    expect(fixed).toBe(1);
    expect(prismaMock.requester.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: CLEAN },
    });
  });

  test('still fills in fuller clean names (original purpose intact)', async () => {
    const fixed = await sweep('Erick', CLEAN);
    expect(fixed).toBe(1);
    expect(prismaMock.requester.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: CLEAN },
    });
  });

  test('does not shorten a clean stored name', async () => {
    const fixed = await sweep(CLEAN, 'Erick');
    expect(fixed).toBe(0);
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
  });
});

describe('createNative repair-on-write', () => {
  test('mojibake names are repaired before the row is written', async () => {
    await requesterRepository.createNative({ email: 'erick@example.com', name: CORRUPTED });
    expect(prismaMock.requester.create.mock.calls[0][0].data.name).toBe(CLEAN);
  });

  test('clean names and email fallback are untouched', async () => {
    await requesterRepository.createNative({ email: 'erick@example.com', name: CLEAN });
    expect(prismaMock.requester.create.mock.calls[0][0].data.name).toBe(CLEAN);

    prismaMock.requester.create.mockClear();
    await requesterRepository.createNative({ email: 'erick@example.com', name: null });
    expect(prismaMock.requester.create.mock.calls[0][0].data.name).toBe('erick@example.com');
  });
});
