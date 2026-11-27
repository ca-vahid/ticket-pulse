import { jest } from '@jest/globals';

/**
 * Settings → Contacts (QA 11-26 item 2): the service rules.
 *   - the e-mail is the identity: trimmed, lowercased, validated; a known
 *     requester (any case) is linked, never duplicated; FreshService untouched;
 *   - remove deletes the link only, and hides the requester from pickers ONLY
 *     when Contacts created it, no other workspace lists it and it has no tickets;
 *   - adding a 'contact_removed' person back clears that;
 *   - integration sandboxes (6–9) are read-only.
 */

const prismaMock = {
  requester: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  workspaceContact: {
    findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(),
  },
  ticket: { count: jest.fn() },
  $transaction: jest.fn(async (fn) => fn(prismaMock)),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: service, normaliseEmail, CONTACT_REMOVED } = await import('../src/services/workspaceContactService.js');

const ADMIN = 'admin.one@example.com';
const person = (over = {}) => ({
  id: 41, name: 'Avery Stone', email: 'avery.stone@example.com', phone: null, jobTitle: null,
  freshserviceId: null, isActive: true, suppressedAt: null, suppressedReason: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  prismaMock.workspaceContact.create.mockImplementation(async ({ data }) => ({ id: 900, createdAt: new Date('2026-11-26T18:00:00Z'), ...data }));
  prismaMock.requester.create.mockImplementation(async ({ data }) => ({ id: 77, suppressedAt: null, suppressedReason: null, ...data }));
  prismaMock.requester.update.mockImplementation(async ({ where, data }) => ({ ...person({ id: where.id }), ...data }));
  prismaMock.workspaceContact.findFirst.mockReset().mockResolvedValue(null);
  prismaMock.workspaceContact.update.mockReset();
  prismaMock.requester.findFirst.mockResolvedValue(null);
});

describe('e-mail validation', () => {
  test('trims and lowercases', () => {
    expect(normaliseEmail('  Avery.Stone@Example.COM ')).toBe('avery.stone@example.com');
  });
  test.each(['', 'avery', 'avery@', '@example.com', 'avery stone@example.com', 'avery@example', 'a<b>@example.com'])('refuses %p', (bad) => {
    expect(() => normaliseEmail(bad)).toThrow(/e-mail/i);
  });
  test('add refuses a bad address and a missing name before touching the database', async () => {
    await expect(service.add(1, { name: 'Avery Stone', email: 'not-an-address' }, ADMIN)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.add(1, { name: '   ', email: 'avery@example.com' }, ADMIN)).rejects.toThrow(/Name is required/);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe('add', () => {
  test('a new address creates a TP-native requester and a link marked "Contacts made this person"', async () => {
    const out = await service.add(1, { name: ' Avery  Stone ', email: ' Avery.Stone@Example.com ', phone: '604-555-0100', note: 'Vendor support' }, ADMIN);
    expect(prismaMock.requester.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: { equals: 'avery.stone@example.com', mode: 'insensitive' } },
    }));
    expect(prismaMock.requester.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        freshserviceId: null, name: 'Avery Stone', email: 'avery.stone@example.com', phone: '604-555-0100', isActive: true,
      }),
    }));
    expect(prismaMock.workspaceContact.create).toHaveBeenCalledWith({
      data: { workspaceId: 1, requesterId: 77, note: 'Vendor support', addedByEmail: ADMIN, createdRequester: true },
    });
    expect(out.existing).toBe(false);
    expect(out.contact).toMatchObject({ id: 900, requesterId: 77, name: 'Avery Stone', email: 'avery.stone@example.com', note: 'Vendor support', addedBy: ADMIN, managedByFreshService: false, hiddenFromPickers: null });
  });

  test('a known address (other case) is linked, not duplicated, and the UI is told so', async () => {
    prismaMock.requester.findFirst.mockResolvedValue(person({ email: 'Avery.Stone@example.com', freshserviceId: 123n }));
    const out = await service.add(1, { name: 'Avery S.', email: 'avery.stone@example.com' }, ADMIN);
    expect(prismaMock.requester.create).not.toHaveBeenCalled();
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
    expect(prismaMock.workspaceContact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ workspaceId: 1, requesterId: 41, createdRequester: false }) });
    expect(out.existing).toBe(true);
    expect(out.message).toMatch(/already known/);
    expect(out.contact.managedByFreshService).toBe(true);
    // The BigInt FreshService id never reaches the JSON payload.
    expect(JSON.stringify(out.contact)).not.toMatch(/123/);
  });

  test('a person already in this workspace\'s contacts is a 409', async () => {
    prismaMock.requester.findFirst.mockResolvedValue(person());
    prismaMock.workspaceContact.findFirst.mockResolvedValue({ id: 5 });
    await expect(service.add(1, { name: 'Avery Stone', email: 'avery.stone@example.com' }, ADMIN)).rejects.toMatchObject({ statusCode: 409 });
    expect(prismaMock.workspaceContact.create).not.toHaveBeenCalled();
  });

  test('adding back a person Contacts removed clears the suppression', async () => {
    prismaMock.requester.findFirst.mockResolvedValue(person({ suppressedAt: new Date(), suppressedReason: CONTACT_REMOVED }));
    const out = await service.add(1, { name: 'Avery Stone', email: 'avery.stone@example.com' }, ADMIN);
    expect(prismaMock.requester.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 41 },
      data: expect.objectContaining({ suppressedAt: null, suppressedReason: null }),
    }));
    // Still a person Contacts made: the new link carries the mark again.
    expect(prismaMock.workspaceContact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ createdRequester: true }) });
    expect(out.contact.hiddenFromPickers).toBeNull();
  });

  test('a person hidden for another reason stays hidden, and the message says so', async () => {
    prismaMock.requester.findFirst.mockResolvedValue(person({ suppressedAt: new Date(), suppressedReason: 'qa_artifact' }));
    const out = await service.add(1, { name: 'Avery Stone', email: 'avery.stone@example.com' }, ADMIN);
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
    expect(out.contact.hiddenFromPickers).toBe('a test address');
    expect(out.message).toMatch(/stays out of the pickers/);
  });

  test('a unique-index race becomes a 409, not a 500', async () => {
    prismaMock.workspaceContact.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    await expect(service.add(1, { name: 'Avery Stone', email: 'avery.stone@example.com' }, ADMIN)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('logs carry ids, never e-mail addresses', async () => {
    await service.add(1, { name: 'Avery Stone', email: 'avery.stone@example.com' }, ADMIN);
    const lines = loggerMock.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toMatch(/contact 900/);
    expect(lines).not.toMatch(/@/);
  });
});

describe('sandbox workspaces 6–9', () => {
  test.each([6, 7, 8, 9])('workspace %i refuses add, update and remove', async (ws) => {
    await expect(service.add(ws, { name: 'Avery Stone', email: 'avery.stone@example.com' }, ADMIN)).rejects.toMatchObject({ statusCode: 403, code: 'sandbox_workspace' });
    await expect(service.update(ws, 1, { note: 'x' }, ADMIN)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.remove(ws, 1, ADMIN)).rejects.toMatchObject({ statusCode: 403 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.workspaceContact.delete).not.toHaveBeenCalled();
  });
  test('reads still work (and say it is a sandbox)', async () => {
    prismaMock.workspaceContact.findMany.mockResolvedValue([]);
    prismaMock.workspaceContact.count.mockResolvedValue(0);
    await expect(service.list(7)).resolves.toMatchObject({ contacts: [], sandbox: true });
  });
});

describe('update', () => {
  const link = (over = {}, r = {}) => ({ id: 900, workspaceId: 1, requesterId: 41, note: null, addedByEmail: ADMIN, createdAt: new Date(), requester: person(r), ...over });

  test('only finds contacts of THIS workspace', async () => {
    await expect(service.update(1, 900, { note: 'x' }, ADMIN)).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.workspaceContact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 900, workspaceId: 1 } }));
  });

  test('name, phone, job title and note are saved', async () => {
    prismaMock.workspaceContact.findFirst.mockResolvedValue(link());
    prismaMock.workspaceContact.update.mockImplementation(async ({ data }) => ({ ...link(), ...data }));
    const out = await service.update(1, 900, { name: 'Avery Stone-Hill', phone: '604-555-0199', jobTitle: 'Account manager', note: 'Billing' }, ADMIN);
    expect(prismaMock.requester.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 41 }, data: { name: 'Avery Stone-Hill', phone: '604-555-0199', jobTitle: 'Account manager' } }));
    expect(prismaMock.workspaceContact.update).toHaveBeenCalledWith({ where: { id: 900 }, data: { note: 'Billing' } });
    expect(out.contact).toMatchObject({ name: 'Avery Stone-Hill', note: 'Billing' });
  });

  test('the e-mail cannot be changed (remove and add instead)', async () => {
    prismaMock.workspaceContact.findFirst.mockResolvedValue(link());
    await expect(service.update(1, 900, { email: 'someone.else@example.com' }, ADMIN)).rejects.toThrow(/remove this contact and add/);
    // Sending the same address back (any case) is fine.
    await expect(service.update(1, 900, { email: 'AVERY.STONE@example.com', note: 'ok' }, ADMIN)).resolves.toBeTruthy();
  });

  test('a FreshService-owned person: only the note can change', async () => {
    prismaMock.workspaceContact.findFirst.mockResolvedValue(link({}, { freshserviceId: 55n }));
    await expect(service.update(1, 900, { name: 'New Name' }, ADMIN)).rejects.toThrow(/FreshService keeps/);
    prismaMock.workspaceContact.update.mockImplementation(async ({ data }) => ({ ...link(), ...data }));
    await expect(service.update(1, 900, { name: 'Avery Stone', note: 'Fine' }, ADMIN)).resolves.toMatchObject({ changed: ['note'] });
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
  });
});

describe('remove', () => {
  const link = (createdRequester, r = {}) => ({ id: 900, workspaceId: 1, requesterId: 41, note: null, createdRequester, requester: person(r) });
  // findFirst answers twice: the link being removed, then "another workspace's link?".
  const links = (removed, other = null) => prismaMock.workspaceContact.findFirst
    .mockResolvedValueOnce(removed)
    .mockResolvedValueOnce(other);

  test('a person Contacts created, listed nowhere else, with no tickets: link deleted and hidden from pickers', async () => {
    links(link(true), null);
    prismaMock.ticket.count.mockResolvedValue(0);
    const out = await service.remove(1, 900, ADMIN);
    expect(prismaMock.workspaceContact.delete).toHaveBeenCalledWith({ where: { id: 900 } });
    expect(prismaMock.ticket.count).toHaveBeenCalledWith({ where: { requesterId: 41 } });
    expect(prismaMock.requester.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: { suppressedAt: expect.any(Date), suppressedReason: CONTACT_REMOVED },
    });
    expect(out).toEqual({ removed: true, hidden: true });
  });

  test('with tickets: link deleted, requester left alone', async () => {
    links(link(true), null);
    prismaMock.ticket.count.mockResolvedValue(2);
    await expect(service.remove(1, 900, ADMIN)).resolves.toEqual({ removed: true, hidden: false });
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
  });

  test('still a contact of another workspace: requester left alone, and that link inherits the mark', async () => {
    links(link(true), { id: 950 });
    await expect(service.remove(1, 900, ADMIN)).resolves.toEqual({ removed: true, hidden: false });
    expect(prismaMock.workspaceContact.findFirst.mock.calls[1][0].where).toEqual({ requesterId: 41 });
    expect(prismaMock.workspaceContact.update).toHaveBeenCalledWith({ where: { id: 950 }, data: { createdRequester: true } });
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
  });

  test('a person Contacts did not create (FreshService, mail, Entra) is never hidden', async () => {
    links(link(false, { freshserviceId: 9n }));
    await expect(service.remove(1, 900, ADMIN)).resolves.toEqual({ removed: true, hidden: false });
    expect(prismaMock.ticket.count).not.toHaveBeenCalled();
    expect(prismaMock.workspaceContact.update).not.toHaveBeenCalled();
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
  });

  test('a contact of another workspace is a 404 and nothing is deleted', async () => {
    await expect(service.remove(1, 900, ADMIN)).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.workspaceContact.delete).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  test('scoped to the workspace, searched by name or e-mail, mapped for the UI', async () => {
    prismaMock.workspaceContact.findMany.mockResolvedValue([
      { id: 900, requesterId: 41, note: 'Vendor', addedByEmail: ADMIN, createdAt: new Date('2026-11-26T18:00:00Z'), requester: person({ suppressedAt: new Date(), suppressedReason: CONTACT_REMOVED }) },
    ]);
    prismaMock.workspaceContact.count.mockResolvedValue(1);
    const out = await service.list(1, { search: ' avery ' });
    const where = prismaMock.workspaceContact.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(1);
    expect(where.requester.OR).toEqual([
      { name: { contains: 'avery', mode: 'insensitive' } },
      { email: { contains: 'avery', mode: 'insensitive' } },
    ]);
    expect(out).toMatchObject({ total: 1, sandbox: false });
    expect(out.contacts[0]).toMatchObject({ id: 900, name: 'Avery Stone', note: 'Vendor', hiddenFromPickers: 'removed from Contacts' });
  });
});
