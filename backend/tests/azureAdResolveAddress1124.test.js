import { jest } from '@jest/globals';

/**
 * 24 Nov 2026 — azureAdService.resolveAddress for "Everyone on the original
 * e-mail": an address with an apostrophe is a valid OData literal (the quote
 * doubled), a caller can limit each Graph call, and found/alias answers carry
 * accountEnabled. Invented names and example.com only.
 */

const axiosMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: azureAdService } = await import('../src/services/azureAdService.js');

const notFound = () => Object.assign(new Error('Not found'), { response: { status: 404 } });

beforeEach(() => {
  jest.clearAllMocks();
  azureAdService.getAccessToken = jest.fn().mockResolvedValue('token');
});

test('the alias search doubles the apostrophe in the OData filter', async () => {
  axiosMock.get
    .mockRejectedValueOnce(notFound())
    .mockResolvedValueOnce({ data: { value: [{ userPrincipalName: 'pat.obrien@example.com', jobTitle: 'Surveyor', accountEnabled: true }] } });
  const result = await azureAdService.resolveAddress("Pat.O'Brien@example.com");
  const filter = axiosMock.get.mock.calls[1][1].params.$filter;
  expect(filter).toBe("proxyAddresses/any(x:x eq 'smtp:pat.o''brien@example.com')");
  expect(result).toMatchObject({ status: 'alias', accountEnabled: true, jobTitle: 'Surveyor' });
});

test('both alias filters escape the quote', async () => {
  axiosMock.get
    .mockRejectedValueOnce(notFound())
    .mockResolvedValueOnce({ data: { value: [] } })
    .mockResolvedValueOnce({ data: { value: [] } });
  expect(await azureAdService.resolveAddress("d'souza.r@example.com")).toEqual({ status: 'absent' });
  expect(axiosMock.get.mock.calls[2][1].params.$filter).toBe("otherMails/any(x:x eq 'd''souza.r@example.com')");
});

test('found answers carry accountEnabled; a disabled account says so', async () => {
  axiosMock.get.mockResolvedValueOnce({ data: { userPrincipalName: 'projects@example.com', accountEnabled: false, department: 'Projects' } });
  expect(await azureAdService.resolveAddress('projects@example.com')).toMatchObject({ status: 'found', accountEnabled: false });
});

test('timeoutMs reaches every Graph call; without it nothing changes', async () => {
  axiosMock.get.mockRejectedValueOnce(notFound()).mockResolvedValue({ data: { value: [] } });
  await azureAdService.resolveAddress('lee.chen@example.com', { timeoutMs: 3000 });
  for (const call of axiosMock.get.mock.calls) expect(call[1].timeout).toBe(3000);

  axiosMock.get.mockReset();
  axiosMock.get.mockResolvedValueOnce({ data: { userPrincipalName: 'lee.chen@example.com', accountEnabled: true } });
  await azureAdService.resolveAddress('lee.chen@example.com');
  expect(axiosMock.get.mock.calls[0][1]).not.toHaveProperty('timeout');
});

test('a timed-out direct lookup is "unavailable", not "absent"', async () => {
  axiosMock.get.mockRejectedValueOnce(Object.assign(new Error('timeout of 3000ms exceeded'), { code: 'ECONNABORTED' }));
  expect(await azureAdService.resolveAddress('lee.chen@example.com', { timeoutMs: 3000 })).toEqual({ status: 'unavailable' });
});
