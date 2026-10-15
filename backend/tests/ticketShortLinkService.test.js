import { jest } from '@jest/globals';

/**
 * Short ticket links (14 Oct 2026): ticketpulse.bgcsaas.com/it/1876, /TP-1876, /246762.
 * TP numbers are one sequence across workspaces; a bare number may also be a
 * FreshService number. Only workspaces the user can open are searched.
 */
const prismaMock = { ticket: { findMany: jest.fn() } };
const wsRepoMock = { getAll: jest.fn(), getMergedWorkspaces: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: wsRepoMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { parseTicketRef, findWorkspace, resolveTicketShortLink, RESERVED_WORKSPACE_SLUGS } = await import('../src/services/ticketShortLinkService.js');

const IT = { id: 1, name: 'IT', slug: 'it' };
const AP = { id: 2, name: 'Accounting Team', slug: 'accounting-team' };
const PA = { id: 5, name: 'Project Accounting Team', slug: 'project-accounting-team' };

beforeEach(() => {
  jest.clearAllMocks();
  wsRepoMock.getAll.mockResolvedValue([AP, IT, PA]);
  wsRepoMock.getMergedWorkspaces.mockResolvedValue([IT]);
  prismaMock.ticket.findMany.mockResolvedValue([]);
});

describe('parseTicketRef', () => {
  test.each([
    ['TP-1876', { tp: true, n: 1876 }], ['tp1876', { tp: true, n: 1876 }], ['TP 10000', { tp: true, n: 10000 }],
    ['1876', { tp: false, n: 1876 }], ['#246762', { tp: false, n: 246762 }], [' 246762 ', { tp: false, n: 246762 }],
  ])('%s', (raw, expected) => expect(parseTicketRef(raw)).toEqual(expected));

  test.each(['dashboard', 'TP-', '0', 'TP-12a', '', null, '12345678901234'])('rejects %s', (raw) => {
    expect(parseTicketRef(raw)).toBeNull();
  });
});

describe('findWorkspace', () => {
  test('by slug or by name, any case', () => {
    expect(findWorkspace([IT, AP], 'it')).toBe(IT);
    expect(findWorkspace([IT, AP], 'IT')).toBe(IT);
    expect(findWorkspace([IT, AP], 'Accounting Team')).toBe(AP);
    expect(findWorkspace([IT, AP], 'accounting-team')).toBe(AP);
    expect(findWorkspace([IT, AP], 'hr')).toBeNull();
  });
});

describe('resolveTicketShortLink', () => {
  const user = { email: 'agent@example.com', role: 'viewer' };

  test('TP number: searches the TP sequence only, in the workspaces the user can open', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 62936, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1876, freshserviceTicketId: 246762n, subject: 'FW: Shared Voicemail', status: 'Open' },
    ]);
    const out = await resolveTicketShortLink({ ref: 'TP-1876', workspace: 'IT', user });
    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: { in: [1] }, OR: [{ nativeNumber: 1876 }] },
    }));
    expect(out).toEqual({ status: 'ok', matches: [expect.objectContaining({ ticketId: 62936, ref: 'TP-1876', workspaceSlug: 'it', matchedAs: 'tp' })] });
  });

  test('bare number: TP and FreshService numbers both searched, TP match listed first', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 9, workspaceId: 1, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 80000n, subject: 'old', status: 'Closed' },
      { id: 70000, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 80000, freshserviceTicketId: 300000n, subject: 'new', status: 'Open' },
    ]);
    const out = await resolveTicketShortLink({ ref: '80000', user });
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where.OR).toEqual([{ nativeNumber: 80000 }, { freshserviceTicketId: 80000n }]);
    expect(out.matches.map((m) => [m.ref, m.matchedAs])).toEqual([['TP-80000', 'tp'], ['#80000', 'freshservice']]);
  });

  test('a workspace the user cannot open is never searched or revealed', async () => {
    const out = await resolveTicketShortLink({ ref: '1876', workspace: 'accounting-team', user });
    expect(out).toEqual({ status: 'unknown_workspace' });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test('admins search every active workspace', async () => {
    await resolveTicketShortLink({ ref: 'TP-5', user: { email: 'a@example.com', role: 'admin' } });
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where.workspaceId).toEqual({ in: [2, 1, 5] });
    expect(wsRepoMock.getMergedWorkspaces).not.toHaveBeenCalled();
  });

  test('not a ticket number', async () => {
    expect(await resolveTicketShortLink({ ref: 'settings', user })).toEqual({ status: 'bad_ref' });
  });

  test('no access anywhere: empty, no query', async () => {
    wsRepoMock.getMergedWorkspaces.mockResolvedValue([]);
    expect(await resolveTicketShortLink({ ref: 'TP-1', user })).toEqual({ status: 'ok', matches: [] });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

test('every live workspace slug is free of page names', () => {
  for (const slug of ['it', 'accounting-team', 'health-safety-team', 'field-equipment-team', 'project-accounting-team']) {
    expect(RESERVED_WORKSPACE_SLUGS).not.toContain(slug);
  }
  expect(RESERVED_WORKSPACE_SLUGS).toEqual(expect.arrayContaining(['tickets', 'dashboard', 'settings', 'workspace']));
});
