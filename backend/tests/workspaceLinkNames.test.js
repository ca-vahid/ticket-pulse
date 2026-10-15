import { jest } from '@jest/globals';

/**
 * Workspace link names (14 Oct 2026): the short first part of a ticket link
 * (/it/TP-10000, /acct/TP-10001). Separate from the slug, which FreshService
 * webhooks post to and which must never change.
 */
const store = new Map();
const prismaMock = { workspace: { findMany: jest.fn() } };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async (k) => store.get(k) ?? null), set: jest.fn(async (k, v) => { store.set(k, v); }) },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAll: jest.fn(), getMergedWorkspaces: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const link = await import('../src/utils/ticketLink.js');
const svc = (await import('../src/services/workspaceLinkNameService.js')).default;
const { findWorkspace } = await import('../src/services/ticketShortLinkService.js');

const WS = [
  { id: 1, name: 'IT', slug: 'it' },
  { id: 2, name: 'Accounting Team', slug: 'accounting-team' },
  { id: 5, name: 'Project Accounting Team', slug: 'project-accounting-team' },
];

beforeEach(() => {
  store.clear();
  prismaMock.workspace.findMany.mockResolvedValue(WS);
  link.setWorkspaceLinkNames({});
});

describe('ticket links for e-mails and cards', () => {
  test('long form until the link names are loaded', () => {
    expect(link.ticketLinkUrl('https://tp.example/', { id: 62936, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1876 }))
      .toBe('https://tp.example/tickets/62936');
  });

  test('short form once loaded: TP number for Ticket Pulse tickets, FreshService number otherwise', async () => {
    store.set('workspace_link_name_ws2', 'acct');
    await svc.refresh();
    expect(link.ticketLinkUrl('https://tp.example', { id: 62936, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 10000, freshserviceTicketId: 247100n }))
      .toBe('https://tp.example/it/TP-10000');
    expect(link.ticketLinkUrl('https://tp.example', { id: 9, workspaceId: 2, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 246718n }))
      .toBe('https://tp.example/acct/246718');
  });

  test('a ticket object without its numbers keeps the long form', async () => {
    await svc.refresh();
    expect(link.ticketLinkUrl('https://tp.example', { id: 5, workspaceId: 1 })).toBe('https://tp.example/tickets/5');
    expect(link.ticketLinkUrl('https://tp.example', null)).toBeNull();
  });

  test('a link to an unknown workspace keeps the long form', async () => {
    await svc.refresh();
    expect(link.ticketLinkUrl('https://tp.example', { id: 5, workspaceId: 99, origin: 'ticketpulse', nativeNumber: 7 })).toBe('https://tp.example/tickets/5');
  });
});

describe('link names', () => {
  test('a workspace without one uses its slug', async () => {
    expect(await svc.getLinkNames()).toEqual({ 1: 'it', 2: 'accounting-team', 5: 'project-accounting-team' });
  });

  test('saving one validates, stores and reloads; old long links still find the workspace', async () => {
    expect(await svc.setLinkName(2, ' ACCT ')).toEqual({ ok: true, linkName: 'acct' });
    expect(store.get('workspace_link_name_ws2')).toBe('acct');
    expect(link.workspaceLinkName(2)).toBe('acct');
    expect(findWorkspace(WS, 'acct')?.id).toBe(2);
    expect(findWorkspace(WS, 'accounting-team')?.id).toBe(2);
    expect(findWorkspace(WS, 'Accounting Team')?.id).toBe(2);
  });

  test.each([
    ['tickets', /page/], ['TP-12', /ticket number/], ['1234', /ticket number/], ['a b', /lowercase/], ['', /lowercase/],
    ['it', /already used by IT/], ['project-accounting-team', /already used/],
  ])('refuses %s', async (name, why) => {
    const out = await svc.setLinkName(2, name);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(why);
  });
});
