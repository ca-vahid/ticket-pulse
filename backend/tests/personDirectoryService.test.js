import { jest } from '@jest/globals';

const prismaMock = { technician: { findFirst: jest.fn() }, requester: { findFirst: jest.fn() } };
const azureMock = { isConfigured: jest.fn(() => true), resolveAddress: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { resolvePersonName, fillPersonNames, clearPersonNameCache } = await import('../src/services/personDirectoryService.js');

beforeEach(() => { jest.clearAllMocks(); clearPersonNameCache(); });

test('technician → requester → Entra, in that order; misses cached', async () => {
  prismaMock.technician.findFirst.mockResolvedValue({ name: 'Vahid Haeri' });
  expect(await resolvePersonName('VHaeri@x.io')).toBe('Vahid Haeri');
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.requester.findFirst.mockResolvedValue({ name: 'Rita Req' });
  expect(await resolvePersonName('rita@x.io')).toBe('Rita Req');
  prismaMock.requester.findFirst.mockResolvedValue(null);
  azureMock.resolveAddress.mockResolvedValue({ status: 'found', displayName: 'Neville Vyland' });
  expect(await resolvePersonName('nvyland@x.io')).toBe('Neville Vyland');
  azureMock.resolveAddress.mockResolvedValue({ status: 'absent' });
  expect(await resolvePersonName('ghost@x.io')).toBeNull();
  expect(await resolvePersonName('ghost@x.io')).toBeNull();
  expect(azureMock.resolveAddress).toHaveBeenCalledTimes(2); // second ghost lookup served from cache
  expect(await resolvePersonName('not-an-email')).toBeNull();
});

test('fillPersonNames only touches nameless rows and never throws', async () => {
  prismaMock.technician.findFirst.mockRejectedValue(new Error('db down'));
  prismaMock.requester.findFirst.mockRejectedValue(new Error('db down'));
  azureMock.resolveAddress.mockResolvedValue({ status: 'found', displayName: 'Bryan Baker' });
  const rows = [{ email: 'bbaker@x.io', name: null }, { email: 'a@x.io', name: 'Already' }];
  await fillPersonNames(rows);
  expect(rows[0].name).toBe('Bryan Baker');
  expect(rows[1].name).toBe('Already');
});
