import { jest } from '@jest/globals';

// 14 Sep 2026: the assignment model called get_technician_ad_profile with
// guessed addresses (first.last@…) that exist in neither the roster nor
// Entra — 120 failed Graph lookups in one hour. Only roster emails may reach
// Graph; a miss is answered locally with a "did you mean".

const prismaMock = { technician: { findFirst: jest.fn() }, ticket: { findFirst: jest.fn() }, workspace: { findUnique: jest.fn() } };
const graphMock = { getUserProfile: jest.fn(), isConfigured: jest.fn(() => true) };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { executeTool, emailIsInternal } = await import('../src/services/assignmentTools.js');

describe('get_technician_ad_profile — only roster emails reach Graph', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a guessed address is refused locally, with the roster match suggested', async () => {
    prismaMock.technician.findFirst
      .mockResolvedValueOnce(null) // exact email: not on the roster
      .mockResolvedValueOnce({ name: 'Mehdi Abbaspour', email: 'mabbaspour@bgcengineering.ca' }); // name guess
    const result = await executeTool('get_technician_ad_profile', { email: 'mehdi.abbaspour@bgcengineering.ca' }, {});
    expect(result.error).toMatch(/not.*roster|No technician/i);
    expect(result.didYouMean).toEqual({ name: 'Mehdi Abbaspour', email: 'mabbaspour@bgcengineering.ca' });
    expect(graphMock.getUserProfile).not.toHaveBeenCalled();
  });

  test('a roster email goes to Graph as before', async () => {
    prismaMock.technician.findFirst.mockResolvedValueOnce({ name: 'Mehdi Abbaspour', email: 'mabbaspour@bgcengineering.ca' });
    graphMock.getUserProfile.mockResolvedValue({ success: true, displayName: 'Mehdi Abbaspour', jobTitle: 'IT Support 3', department: 'IT' });
    const result = await executeTool('get_technician_ad_profile', { email: 'MAbbaspour@bgcengineering.ca' }, {});
    expect(graphMock.getUserProfile).toHaveBeenCalledWith('mabbaspour@bgcengineering.ca');
    expect(result.displayName).toBe('Mehdi Abbaspour');
    expect(result.senioritySignals).toBeDefined();
  });
});

describe('get_requester_site_context — the directory is only asked about our own people', () => {
  beforeEach(() => jest.clearAllMocks());

  test('emailIsInternal', () => {
    expect(emailIsInternal('rita@bgcengineering.ca', ['bgcengineering.ca'])).toBe(true);
    expect(emailIsInternal('x@mail.bgcengineering.ca', ['bgcengineering.ca'])).toBe(true);
    expect(emailIsInternal('quarantine@messaging.microsoft.com', ['bgcengineering.ca'])).toBe(false);
    expect(emailIsInternal('anyone@example.com', [])).toBe(true); // no list configured → unchanged behaviour
    expect(emailIsInternal('', ['bgcengineering.ca'])).toBe(false);
  });

  test('an external requester (vendor no-reply, quarantine digest) never reaches Graph', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['bgcengineering.ca'] });
    prismaMock.ticket.findFirst.mockResolvedValue({
      id: 7, freshserviceTicketId: null, subject: 'Quarantine digest', descriptionText: '',
      requester: { name: 'Quarantine', email: 'quarantine@messaging.microsoft.com', department: null, jobTitle: null, timeZone: null },
    });
    const result = await executeTool('get_requester_site_context', { ticket_id: 7 }, { workspaceId: 1 });
    expect(graphMock.getUserProfile).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
  });
});
