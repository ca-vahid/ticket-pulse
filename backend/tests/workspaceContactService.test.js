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
    findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), groupBy: jest.fn(),
  },
  ticket: { count: jest.fn(), groupBy: jest.fn() },
  $transaction: jest.fn(async (fn) => fn(prismaMock)),
  $executeRaw: jest.fn(async () => 1),
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
  prismaMock.workspaceContact.count.mockReset().mockResolvedValue(0);
  prismaMock.ticket.count.mockReset().mockResolvedValue(0);
  prismaMock.workspaceContact.groupBy.mockReset().mockResolvedValue([]);
  prismaMock.ticket.groupBy.mockReset().mockResolvedValue([]);
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
    expect(out.contact).toMatchObject({ id: 900, requesterId: 77, name: 'Avery Stone', email: 'avery.stone@example.com', note: 'Vendor support', addedBy: ADMIN, managedByFreshService: false, detailsLocked: null, hiddenFromPickers: null });
  });

  test('the lookup runs under a transaction-scoped advisory lock on the lowercased e-mail', async () => {
    await service.add(1, { name: 'Avery Stone', email: 'Avery.Stone@Example.com' }, ADMIN);
    const [strings, key] = prismaMock.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toMatch(/pg_advisory_xact_lock\(hashtext\(\?::text\)\)/);
    expect(key).toBe('workspace_contact:avery.stone@example.com');
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.requester.findFirst.mock.invocationCallOrder[0]);
  });

  test('linking a person another workspace already knows (mail, no FreshService id) keeps their details read-only here', async () => {
    prismaMock.requester.findFirst.mockResolvedValue(person());
    prismaMock.ticket.count.mockResolvedValue(3);
    const out = await service.add(1, { name: 'Someone Else', email: 'avery.stone@example.com' }, ADMIN);
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
    expect(out.contact.name).toBe('Avery Stone');
    expect(out.contact.detailsLocked).toMatch(/also known outside this workspace/);
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
    expect(out.contact.detailsLocked).toMatch(/FreshService keeps/);
    // The BigInt FreshService id never reaches the JSON payload.
    expect(JSON.stringify(out.contact)).not.toMatch(/123/);
  });

  test('a person already in this workspace\'s contacts is a 409', async () => {
    prismaMock.requester.findFirst.mockResolvedValue(person());
    prismaMock.workspaceContact.findFirst.mockResolvedValue({ id: 5 });
    await expect(service.add(1, { name: 'Avery Stone', email: 'avery.stone@example.com' }, ADMIN)).rejects.toMatchObject({ statusCode: 409 });
    expect(prismaMock.workspaceContact.create).not.toHaveBeenCalled();
  });

  test('adding back a person Contacts removed clears the suppression and takes the typed details', async () => {
    prismaMock.requester.findFirst.mockResolvedValue(person({ suppressedAt: new Date(), suppressedReason: CONTACT_REMOVED }));
    const out = await service.add(1, { name: 'Avery Stone-Hill', email: 'avery.stone@example.com', phone: '604-555-0100' }, ADMIN);
    expect(prismaMock.requester.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 41 },
      data: { suppressedAt: null, suppressedReason: null, name: 'Avery Stone-Hill', phone: '604-555-0100' },
    }));
    // Still a person Contacts made: the new link carries the mark again.
    expect(prismaMock.workspaceContact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ createdRequester: true }) });
    expect(out.contact.hiddenFromPickers).toBeNull();
    expect(out.contact.detailsLocked).toBeNull();
  });

  test('adding back a removed person who now has tickets in another workspace: unhidden, details untouched', async () => {
    prismaMock.requester.findFirst.mockResolvedValue(person({ suppressedAt: new Date(), suppressedReason: CONTACT_REMOVED }));
    prismaMock.ticket.count.mockResolvedValue(1);
    const out = await service.add(1, { name: 'Different Name', email: 'avery.stone@example.com', jobTitle: 'Buyer' }, ADMIN);
    expect(prismaMock.ticket.count).toHaveBeenCalledWith({ where: { requesterId: 41, workspaceId: { not: 1 } } });
    expect(prismaMock.requester.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 41 },
      data: { suppressedAt: null, suppressedReason: null },
    }));
    expect(out.contact.name).toBe('Avery Stone');
    expect(out.contact.detailsLocked).toMatch(/also known outside/);
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
  const link = (over = {}, r = {}) => ({ id: 900, workspaceId: 1, requesterId: 41, note: null, addedByEmail: ADMIN, createdRequester: true, createdAt: new Date(), requester: person(r), ...over });

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
    expect(out.contact).toMatchObject({ name: 'Avery Stone-Hill', note: 'Billing', detailsLocked: null });
    // "Nobody else sees this row" was checked: other links (not this one) and tickets elsewhere.
    expect(prismaMock.workspaceContact.count).toHaveBeenCalledWith({ where: { requesterId: 41, id: { not: 900 } } });
    expect(prismaMock.ticket.count).toHaveBeenCalledWith({ where: { requesterId: 41, workspaceId: { not: 1 } } });
  });

  test.each([
    ['linked, not made here (another workspace\'s mail requester)', { createdRequester: false }, 0, 0],
    ['made here, but another workspace lists them too', {}, 1, 0],
    ['made here, but they have tickets in another workspace', {}, 0, 2],
  ])('%s: name/phone/title refused, note still saved', async (_label, over, otherLinks, ticketsElsewhere) => {
    prismaMock.workspaceContact.findFirst.mockResolvedValue(link(over));
    prismaMock.workspaceContact.count.mockResolvedValue(otherLinks);
    prismaMock.ticket.count.mockResolvedValue(ticketsElsewhere);
    await expect(service.update(1, 900, { name: 'Changed Name', note: 'x' }, ADMIN)).rejects.toThrow(/also known outside this workspace.*Only the note/);
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
    expect(prismaMock.workspaceContact.update).not.toHaveBeenCalled();
    prismaMock.workspaceContact.update.mockImplementation(async ({ data }) => ({ ...link(over), ...data }));
    const out = await service.update(1, 900, { name: 'Avery Stone', note: 'Courier' }, ADMIN);
    expect(out).toMatchObject({ changed: ['note'], contact: { note: 'Courier', detailsLocked: expect.stringMatching(/also known outside/) } });
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
  });

  test('when the check cannot be read, details stay locked (fails closed)', async () => {
    prismaMock.workspaceContact.findFirst.mockResolvedValue(link());
    prismaMock.ticket.count.mockRejectedValue(new Error('db down'));
    await expect(service.update(1, 900, { name: 'Changed Name' }, ADMIN)).rejects.toThrow(/could not be checked/);
    expect(prismaMock.requester.update).not.toHaveBeenCalled();
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

  test('each row says whether this workspace may edit the details, from two grouped reads', async () => {
    const row = (id, requesterId, createdRequester, r = {}) => ({ id, requesterId, createdRequester, note: null, createdAt: new Date(), requester: person({ id: requesterId, ...r }) });
    prismaMock.workspaceContact.findMany.mockResolvedValue([
      row(1, 41, true), // ours, nobody else: editable
      row(2, 42, true), // ours, but another workspace lists them
      row(3, 43, true), // ours, but tickets in another workspace
      row(4, 44, false), // linked someone else's requester
      row(5, 45, true, { freshserviceId: 7n }), // FreshService person
    ]);
    prismaMock.workspaceContact.count.mockResolvedValue(5);
    prismaMock.workspaceContact.groupBy.mockResolvedValue([
      { requesterId: 41, _count: { _all: 1 } }, { requesterId: 42, _count: { _all: 2 } }, { requesterId: 43, _count: { _all: 1 } },
    ]);
    prismaMock.ticket.groupBy.mockResolvedValue([{ requesterId: 43, _count: { _all: 4 } }]);
    const out = await service.list(1);
    expect(prismaMock.ticket.groupBy.mock.calls[0][0].where).toEqual({ requesterId: { in: [41, 42, 43] }, workspaceId: { not: 1 } });
    const locks = out.contacts.map((c) => c.detailsLocked);
    expect(locks[0]).toBeNull();
    expect(locks[1]).toMatch(/also known outside/);
    expect(locks[2]).toMatch(/also known outside/);
    expect(locks[3]).toMatch(/also known outside/);
    expect(locks[4]).toMatch(/FreshService keeps/);
  });

  test('a failed check never fails the list; those rows come back locked', async () => {
    prismaMock.workspaceContact.findMany.mockResolvedValue([
      { id: 1, requesterId: 41, createdRequester: true, note: null, createdAt: new Date(), requester: person() },
    ]);
    prismaMock.workspaceContact.count.mockResolvedValue(1);
    prismaMock.ticket.groupBy.mockRejectedValue(new Error('db down'));
    const out = await service.list(1);
    expect(out.contacts[0].detailsLocked).toMatch(/could not be checked/);
  });
});
