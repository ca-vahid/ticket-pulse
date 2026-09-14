import { jest } from '@jest/globals';

// 14 Sep 2026: every new external requester (vendor no-reply mailboxes,
// quarantine digests) produced TWO directory lookups — the primary client
// answered "no such user" at info, then the mail client asked the same
// directory again and logged an [error]. 46 error lines in one hour.

const azureMock = { isConfigured: jest.fn(() => true), getUserProfile: jest.fn() };
const graphMock = { isConfigured: jest.fn(() => true), getUserProfile: jest.fn() };
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: { requester: { update: jest.fn() } } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { fetchEntraProfile } = await import('../src/services/requesterProfileService.js');

describe('requester Entra lookup — one directory, one question', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a miss on the primary client is final; the mail client is not asked again', async () => {
    azureMock.getUserProfile.mockResolvedValue(null);
    expect(await fetchEntraProfile('no-reply@amazon.com')).toBeNull();
    expect(azureMock.getUserProfile).toHaveBeenCalledTimes(1);
    expect(graphMock.getUserProfile).not.toHaveBeenCalled();
  });

  test('a hit on the primary client is normalised', async () => {
    azureMock.getUserProfile.mockResolvedValue({ officeLocation: 'Vancouver', city: 'Vancouver', department: 'IT', jobTitle: 'Analyst', usageLocation: 'CA' });
    const p = await fetchEntraProfile('rita@bgcengineering.ca');
    expect(p).toMatchObject({ officeLocation: 'Vancouver', department: 'IT', countryCode: 'CA' });
    expect(graphMock.getUserProfile).not.toHaveBeenCalled();
  });

  test('the mail client is the fallback only when the primary is not configured', async () => {
    azureMock.isConfigured.mockReturnValueOnce(false);
    graphMock.getUserProfile.mockResolvedValue({ success: true, officeLocation: 'Calgary', department: 'Ops' });
    const p = await fetchEntraProfile('sam@bgcengineering.ca');
    expect(p).toMatchObject({ officeLocation: 'Calgary' });
    expect(azureMock.getUserProfile).not.toHaveBeenCalled();
    expect(graphMock.getUserProfile).toHaveBeenCalledTimes(1);
  });
});
