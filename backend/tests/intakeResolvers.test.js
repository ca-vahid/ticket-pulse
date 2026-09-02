import { jest } from '@jest/globals';

/**
 * Autofill v2 (AF2) — intakeResolvers: name/email hints → identities.
 * Rule under test: `matched` only from an unambiguous identity (exact email,
 * unique exact full name, or — technicians only — a unique first name);
 * partials are `ambiguous` (≤ 5 candidates) or `none`, never `matched`.
 */

const requesterFindFirst = jest.fn();
const requesterFindMany = jest.fn();
const technicianFindMany = jest.fn();
const searchUsersMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    requester: { findFirst: requesterFindFirst, findMany: requesterFindMany },
    technician: { findMany: technicianFindMany },
  },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { searchUsers: searchUsersMock } }));

const { resolveRequesterHint, resolveAssigneeHint, resolveConversingAgent, normalizeName } = await import('../src/services/intakeResolvers.js');

const TECHS = [
  { id: 1, name: 'Soheil Nasiri', email: 'SNasiri@example.com' },
  { id: 2, name: 'Vahid Haeri', email: 'vhaeri@example.com' },
  { id: 3, name: 'Vahid Haeri Domain Admin', email: null },
  { id: 4, name: 'Mehdi Abbaspour', email: 'mabbaspour@example.com' },
  { id: 5, name: 'Ticket Pulse', email: 'bot@example.com' },
];

beforeEach(() => {
  jest.clearAllMocks();
  requesterFindFirst.mockResolvedValue(null);
  requesterFindMany.mockResolvedValue([]);
  technicianFindMany.mockResolvedValue(TECHS);
  searchUsersMock.mockResolvedValue([]);
});

describe('normalizeName', () => {
  test('case/space/punctuation-insensitive', () => {
    expect(normalizeName('  Simon   P. Dickinson ')).toBe('simon p dickinson');
    expect(normalizeName('O’Neil, Sam')).toBe('oneil sam');
  });
});

describe('resolveRequesterHint', () => {
  test('empty hint → none; nothing is queried', async () => {
    const out = await resolveRequesterHint(1, null);
    expect(out).toEqual({ status: 'none', candidate: null, candidates: [], reason: expect.any(String) });
    expect(requesterFindFirst).not.toHaveBeenCalled();
    expect(requesterFindMany).not.toHaveBeenCalled();
  });

  test('email hint → known requester by email (case-insensitive) → matched, source requester', async () => {
    requesterFindFirst.mockResolvedValue({ id: 99, name: 'Simon Dickinson', email: 'SDickinson@bgcengineering.ca' });
    const out = await resolveRequesterHint(1, 'sdickinson@BGCengineering.ca');
    expect(requesterFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true, email: { equals: 'sdickinson@bgcengineering.ca', mode: 'insensitive' } },
    }));
    expect(out).toEqual({
      status: 'matched',
      candidate: { requesterId: 99, email: 'sdickinson@bgcengineering.ca', name: 'Simon Dickinson', source: 'requester' },
      candidates: [],
      reason: expect.stringContaining('Known requester'),
    });
    expect(searchUsersMock).not.toHaveBeenCalled();
  });

  test('email hint unknown locally → exact directory mail → matched, source directory, requesterId null', async () => {
    searchUsersMock.mockResolvedValue([{ displayName: 'New Person', mail: 'New.Person@example.com' }]);
    const out = await resolveRequesterHint(1, 'new.person@example.com');
    expect(out.status).toBe('matched');
    expect(out.candidate).toEqual({ requesterId: null, email: 'new.person@example.com', name: 'New Person', source: 'directory' });
  });

  test('email hint unknown everywhere → none (directory unavailable is named in the reason)', async () => {
    let out = await resolveRequesterHint(1, 'ghost@example.com');
    expect(out).toMatchObject({ status: 'none', candidate: null, candidates: [] });
    searchUsersMock.mockRejectedValue(new Error('Graph 401'));
    out = await resolveRequesterHint(1, 'ghost@example.com');
    expect(out.status).toBe('none');
    expect(out.reason).toMatch(/directory unavailable/);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  test('name hint upgraded to an email via peopleMentioned when the model saw the address verbatim', async () => {
    requesterFindFirst.mockResolvedValue({ id: 5, name: 'Sam Lee', email: 'sam.lee@example.com' });
    const out = await resolveRequesterHint(1, 'Sam Lee', [{ name: 'sam lee', email: 'Sam.Lee@example.com', role: 'requester' }]);
    expect(requesterFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ email: { equals: 'sam.lee@example.com', mode: 'insensitive' } }),
    }));
    expect(out.status).toBe('matched');
    expect(out.candidate.requesterId).toBe(5);
  });

  test('exact full name held by exactly one known requester → matched (partial "Geoff Dickinson" is not it)', async () => {
    requesterFindMany.mockResolvedValue([
      { id: 99, name: 'Simon Dickinson', email: 'sdickinson@example.com' },
      { id: 676, name: 'Geoff Dickinson', email: 'gdickinson@example.com' },
    ]);
    const out = await resolveRequesterHint(1, 'simon dickinson');
    expect(requesterFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isActive: true, name: { contains: 'dickinson', mode: 'insensitive' } }),
    }));
    expect(out.status).toBe('matched');
    expect(out.candidate).toEqual({ requesterId: 99, email: 'sdickinson@example.com', name: 'Simon Dickinson', source: 'requester' });
    expect(searchUsersMock).not.toHaveBeenCalled();
  });

  test('two known requesters with the same exact name → ambiguous with both', async () => {
    requesterFindMany.mockResolvedValue([
      { id: 1, name: 'Sam Lee', email: 'sam.lee@example.com' },
      { id: 2, name: 'Sam Lee', email: 'slee@contractor.example' },
    ]);
    const out = await resolveRequesterHint(1, 'Sam Lee');
    expect(out.status).toBe('ambiguous');
    expect(out.candidate).toBeNull();
    expect(out.candidates.map((c) => c.requesterId)).toEqual([1, 2]);
  });

  test('no known requester → exactly one directory person with that display name → matched, source directory', async () => {
    searchUsersMock.mockResolvedValue([
      { displayName: 'Simon Dickinson', mail: 'SDickinson@example.com', jobTitle: 'Geologist' },
      { displayName: 'Simon Dickinson-Smith', mail: 'sds@example.com' },
    ]);
    const out = await resolveRequesterHint(1, 'Simon Dickinson');
    expect(searchUsersMock).toHaveBeenCalledWith('Simon Dickinson', 8);
    expect(out.status).toBe('matched');
    expect(out.candidate).toEqual({ requesterId: null, email: 'sdickinson@example.com', name: 'Simon Dickinson', source: 'directory' });
  });

  test('several directory people with the same display name → ambiguous (≤ 5)', async () => {
    searchUsersMock.mockResolvedValue(Array.from({ length: 7 }, (_, i) => ({ displayName: 'John Smith', mail: `js${i}@example.com` })));
    const out = await resolveRequesterHint(1, 'John Smith');
    expect(out.status).toBe('ambiguous');
    expect(out.candidates).toHaveLength(5);
    expect(out.candidates[0].source).toBe('directory');
  });

  test('a first name alone NEVER matches — similar names come back as ambiguous', async () => {
    requesterFindMany.mockResolvedValue([{ id: 7, name: 'Simon Dickinson', email: 's@example.com' }]);
    const out = await resolveRequesterHint(1, 'Simon');
    expect(out.status).toBe('ambiguous');
    expect(out.candidate).toBeNull();
    expect(out.candidates).toEqual([{ requesterId: 7, email: 's@example.com', name: 'Simon Dickinson', source: 'requester' }]);
    expect(out.reason).toMatch(/partial name/);
  });

  test('no exact match, no similar names → none; too many similar → none with a hand-search hint', async () => {
    let out = await resolveRequesterHint(1, 'Nobody Here');
    expect(out).toMatchObject({ status: 'none', candidate: null, candidates: [] });

    requesterFindMany.mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({ id: i, name: `Sam Lee${i}`, email: `s${i}@example.com` })));
    out = await resolveRequesterHint(1, 'Sam Lee');
    expect(out.status).toBe('none');
    expect(out.reason).toMatch(/too many/);
  });
});

describe('resolveAssigneeHint', () => {
  test('exact full name → matched; email → matched; service account excluded', async () => {
    let out = await resolveAssigneeHint(1, 'soheil nasiri');
    expect(technicianFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 1, isActive: true } }));
    expect(out).toEqual({
      status: 'matched',
      technician: { id: 1, name: 'Soheil Nasiri', email: 'snasiri@example.com' },
      candidates: [],
      reason: expect.any(String),
    });
    out = await resolveAssigneeHint(1, 'VHaeri@example.com');
    expect(out.status).toBe('matched');
    expect(out.technician.id).toBe(2);
    out = await resolveAssigneeHint(1, 'Ticket Pulse');
    expect(out.status).toBe('none');
  });

  test('unique first name → matched ("Soheil" → Soheil Nasiri)', async () => {
    const out = await resolveAssigneeHint(1, 'Soheil');
    expect(out.status).toBe('matched');
    expect(out.technician).toEqual({ id: 1, name: 'Soheil Nasiri', email: 'snasiri@example.com' });
    expect(out.reason).toMatch(/Only one active technician is named Soheil/);
  });

  test('shared first name → ambiguous with the candidates; a last-name initial narrows it', async () => {
    let out = await resolveAssigneeHint(1, 'Vahid');
    expect(out.status).toBe('ambiguous');
    expect(out.technician).toBeNull();
    expect(out.candidates.map((c) => c.id)).toEqual([2, 3]);

    // "Vahid H." still ties (both start with H); "Vahid Haeri" is exact → matched.
    out = await resolveAssigneeHint(1, 'Vahid H.');
    expect(out.status).toBe('ambiguous');
    out = await resolveAssigneeHint(1, 'Vahid Haeri');
    expect(out.status).toBe('matched');
    expect(out.technician.id).toBe(2);
  });

  test('last name only → ambiguous (offered, never matched); unknown → none; empty → none', async () => {
    let out = await resolveAssigneeHint(1, 'Abbaspour');
    expect(out.status).toBe('ambiguous');
    expect(out.candidates).toEqual([{ id: 4, name: 'Mehdi Abbaspour', email: 'mabbaspour@example.com' }]);

    out = await resolveAssigneeHint(1, 'Zed Nobody');
    expect(out).toEqual({ status: 'none', technician: null, candidates: [], reason: expect.stringContaining('No active technician') });

    out = await resolveAssigneeHint(1, '   ');
    expect(out.status).toBe('none');
    technicianFindMany.mockResolvedValue([]);
    out = await resolveAssigneeHint(1, 'Soheil');
    expect(out.status).toBe('none');
  });
});

describe('resolveConversingAgent', () => {
  test('unique → id + email; ambiguous → name only; empty → null', async () => {
    expect(await resolveConversingAgent(1, 'Soheil')).toEqual({ name: 'Soheil Nasiri', technicianId: 1, email: 'snasiri@example.com' });
    expect(await resolveConversingAgent(1, 'Vahid')).toEqual({ name: 'Vahid', technicianId: null, email: null });
    expect(await resolveConversingAgent(1, '')).toBeNull();
  });

  test('the calling technician id breaks a first-name tie but never overrides a unique match', async () => {
    expect(await resolveConversingAgent(1, 'Vahid', { preferTechnicianId: 3 })).toEqual({ name: 'Vahid Haeri Domain Admin', technicianId: 3, email: null });
    expect(await resolveConversingAgent(1, 'Vahid', { preferTechnicianId: '2' })).toEqual({ name: 'Vahid Haeri', technicianId: 2, email: 'vhaeri@example.com' });
    expect(await resolveConversingAgent(1, 'Vahid', { preferTechnicianId: 4 })).toEqual({ name: 'Vahid', technicianId: null, email: null });
    expect(await resolveConversingAgent(1, 'Soheil', { preferTechnicianId: 2 })).toMatchObject({ technicianId: 1 });
  });
});
