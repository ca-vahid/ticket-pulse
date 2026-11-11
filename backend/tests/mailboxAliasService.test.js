/**
 * "Also known as" addresses of a mailbox (11 Nov 2026): storage in app
 * settings, what may be an alias, and the read-only suggestions.
 */
import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: { findMany: jest.fn() },
  mailboxHeldMessage: { findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findMany: jest.fn() },
  ticket: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const settings = new Map();
const settingsMock = {
  get: jest.fn(async (key) => (settings.has(key) ? settings.get(key) : null)),
  set: jest.fn(async (key, value) => { settings.set(key, String(value)); }),
  delete: jest.fn(async (key) => settings.delete(key)),
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  aliasSettingKey, parseAliasList, getMailboxAliases, setMailboxAliases, withAliases, clearMailboxAliases,
  suggestMailboxAliases, invalidateAliasCache, MAX_ALIASES,
} = await import('../src/services/mailboxAliasService.js');

const AR = { id: 6, workspaceId: 2, address: 'ar-tickets@example.com', mode: 'ingest', defaultGroupId: 1000210021n, defaultInternalGroupId: null };
const AP = { id: 5, workspaceId: 2, address: 'ap-tickets@example.com', mode: 'ingest', defaultGroupId: 1000209106n, defaultInternalGroupId: null };

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  invalidateAliasCache();
  prismaMock.mailboxConnection.findMany.mockResolvedValue([AP]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.requester.findMany.mockResolvedValue([]);
  prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([]);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: [] });
});

describe('storage', () => {
  test('one app setting per mailbox, comma separated; read back lowercased and distinct', async () => {
    expect(aliasSettingKey(6)).toBe('mailbox_aliases_6');
    expect(await setMailboxAliases(AR, [' Receivables@Example.com ', 'receivables@example.com', 'billing@example.com'])).toEqual(['receivables@example.com', 'billing@example.com']);
    expect(settings.get('mailbox_aliases_6')).toBe('receivables@example.com, billing@example.com');
    expect(await getMailboxAliases(6)).toEqual(['receivables@example.com', 'billing@example.com']);
    expect(parseAliasList('a@x.io; B@x.io,  not-an-address a@x.io')).toEqual(['a@x.io', 'b@x.io']);
  });

  test('cached for a minute, dropped on save; an empty list removes the setting', async () => {
    settings.set('mailbox_aliases_6', 'receivables@example.com');
    await getMailboxAliases(6);
    await getMailboxAliases(6);
    expect(settingsMock.get).toHaveBeenCalledTimes(1);
    expect(await setMailboxAliases(AR, [])).toEqual([]);
    expect(settingsMock.delete).toHaveBeenCalledWith('mailbox_aliases_6');
    expect(await getMailboxAliases(6)).toEqual([]);
  });

  test('a failed read is "no aliases", is not cached, and never throws', async () => {
    settingsMock.get.mockRejectedValueOnce(new Error('db down'));
    expect(await getMailboxAliases(6)).toEqual([]);
    settings.set('mailbox_aliases_6', 'receivables@example.com');
    expect(await getMailboxAliases(6)).toEqual(['receivables@example.com']);
    expect(await getMailboxAliases(null)).toEqual([]);
  });

  test('withAliases attaches the list; a mailbox with none is handed back untouched', async () => {
    expect(await withAliases(AR)).toBe(AR);
    settings.set('mailbox_aliases_6', 'receivables@example.com');
    invalidateAliasCache(6);
    expect(await withAliases(AR)).toEqual({ ...AR, aliases: ['receivables@example.com'] });
    const carried = { ...AR, aliases: [] };
    expect(await withAliases(carried)).toBe(carried);
  });

  test('clearMailboxAliases forgets a removed mailbox', async () => {
    settings.set('mailbox_aliases_6', 'receivables@example.com');
    await clearMailboxAliases(6);
    expect(await getMailboxAliases(6)).toEqual([]);
  });
});

describe('what may be an alias', () => {
  test('refuses: not an address, a +tag, the mailbox itself, more than ten', async () => {
    await expect(setMailboxAliases(AR, ['receivables'])).rejects.toThrow('"receivables" is not an e-mail address');
    await expect(setMailboxAliases(AR, ['ar-tickets+x@example.com'])).rejects.toThrow(/is not an e-mail address/);
    await expect(setMailboxAliases(AR, ['AR-Tickets@example.com'])).rejects.toThrow(/this mailbox's own address/);
    await expect(setMailboxAliases(AR, Array.from({ length: MAX_ALIASES + 1 }, (_, i) => `team${i}@example.com`))).rejects.toThrow(/at most 10/);
    await expect(setMailboxAliases(AR, { nope: true })).rejects.toThrow(/must be a list/);
    await expect(setMailboxAliases(null, [])).rejects.toThrow(/Mailbox not found/);
    expect(settingsMock.set).not.toHaveBeenCalled();
  });

  test('refuses another connected mailbox, an address another mailbox already answers to, and a person on the team', async () => {
    await expect(setMailboxAliases(AR, ['ap-tickets@example.com'])).rejects.toThrow('ap-tickets@example.com is a connected mailbox of its own');
    settings.set('mailbox_aliases_5', 'payables@example.com');
    await expect(setMailboxAliases(AR, ['payables@example.com'])).rejects.toThrow('payables@example.com is already another address of ap-tickets@example.com');
    prismaMock.technician.findFirst.mockResolvedValue({ email: 'Alex.Rivera@example.com' });
    await expect(setMailboxAliases(AR, ['alex.rivera@example.com'])).rejects.toThrow('alex.rivera@example.com is a person on this team');
    expect(settingsMock.set).not.toHaveBeenCalled();
  });
});

describe('suggestions (read-only)', () => {
  const heldMail = (to, cc = []) => ({ toEmails: to, ccEmails: cc });

  test('the address most of the mailbox’s mail was sent to, on its own domain, that is not the mailbox, a mailbox or a person', async () => {
    prismaMock.mailboxConnection.findMany.mockResolvedValue([AR, AP]);
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([
      ...Array(6).fill(heldMail(['sam.ortiz@example.com'], ['receivables@example.com'])),
      ...Array(4).fill(heldMail(['jo.park@client.example.org'], ['receivables@example.com', 'kim.lee@example.com'])),
      ...Array(5).fill(heldMail(['ar-tickets@example.com'], ['people-team@example.com'])), // sits next to the mailbox: a co-recipient
      ...Array(3).fill(heldMail(['ap-tickets@example.com', 'noreply@example.com'])),
    ]);
    prismaMock.ticket.findMany.mockResolvedValue(Array(5).fill(heldMail(['receivables@example.com'])));
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'Kim.Lee@example.com' }]);
    prismaMock.requester.findMany.mockResolvedValue([
      { email: 'sam.ortiz@example.com', entraJobTitle: 'Project Accountant', entraDepartment: null },
      // The shared address once became a requester: no job title, no department, still a candidate.
      { email: 'receivables@example.com', entraJobTitle: null, entraDepartment: '' },
    ]);
    expect(await suggestMailboxAliases(AR)).toEqual([{ address: 'receivables@example.com', count: 15 }]);
    // With a sibling ingest mailbox, only tickets routed to this mailbox's own group are counted.
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: 2, groupId: 1000210021n });
    // Read-only.
    expect(settingsMock.set).not.toHaveBeenCalled();
  });

  test('nothing to suggest: an address already listed, too few mails, or a lookup that fails', async () => {
    prismaMock.mailboxConnection.findMany.mockResolvedValue([AR]);
    prismaMock.mailboxHeldMessage.findMany.mockResolvedValue([...Array(5).fill(heldMail(['receivables@example.com'])), ...Array(2).fill(heldMail(['billing@example.com']))]);
    settings.set('mailbox_aliases_6', 'receivables@example.com');
    expect(await suggestMailboxAliases(AR)).toEqual([]);
    prismaMock.mailboxHeldMessage.findMany.mockRejectedValue(new Error('db down'));
    expect(await suggestMailboxAliases(AR)).toEqual([]);
    expect(await suggestMailboxAliases(null)).toEqual([]);
  });

  test('a lone ingest mailbox counts every e-mail ticket in its workspace', async () => {
    const lone = { ...AR, defaultGroupId: null };
    prismaMock.mailboxConnection.findMany.mockResolvedValue([lone]);
    prismaMock.ticket.findMany.mockResolvedValue(Array(3).fill(heldMail(['help@example.com'])));
    expect(await suggestMailboxAliases(lone)).toEqual([{ address: 'help@example.com', count: 3 }]);
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where.groupId).toBeUndefined();
  });
});
