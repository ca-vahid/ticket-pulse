import { jest } from '@jest/globals';

/**
 * Splitting a conversation out of a ticket (QA 09-08).
 *
 * These pin the decisions that make split safe, each of which is the opposite
 * of an obvious shortcut:
 *   - entries are COPIED with provenance, never moved (an FS-sourced entry
 *     moved off its ticket is resurrected by the next sync);
 *   - the parent may be FS-BORN (473 of the 482 real candidates are);
 *   - the child is always TP-born;
 *   - attachments on the copied entries are RE-POINTED, not duplicated;
 *   - the parent's conversation and status are never modified.
 */

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn(), createMany: jest.fn() },
  ticketAttachment: { updateMany: jest.fn(), findMany: jest.fn() },
  ticketLink: { upsert: jest.fn() },
};
const ticketServiceMock = { createTicket: jest.fn(), addPrivateNote: jest.fn() };
const linkServiceMock = { setParent: jest.fn() };
const attachmentServiceMock = { copyToTicket: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: { create: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: linkServiceMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: attachmentServiceMock }));

const { default: ticketSplitService } = await import('../src/services/ticketSplitService.js');

// An FS-born parent — the common case, and the one merge would refuse.
const fsParent = {
  id: 500, workspaceId: 1, subject: 'Laptop is slow and also my VPN drops',
  status: 'Open', priority: 2, origin: 'freshservice', freshserviceTicketId: 231164n,
  nativeNumber: null, internalCategoryId: 4, internalSubcategoryId: 9, requesterId: 77,
  requester: { id: 77, email: 'jsmith@bgcengineering.ca', name: 'John Smith' },
};
const entry = (id, over = {}) => ({
  id, ticketId: 500, source: 'freshservice_conversation', eventType: 'reply',
  actorName: 'John Smith', actorEmail: 'jsmith@bgcengineering.ca', actorFreshserviceId: 1n,
  authorType: 'requester', incoming: true, isPrivate: false, visibility: null,
  title: null, content: 'my VPN drops every hour', bodyHtml: '<p>my VPN drops every hour</p>',
  bodyText: 'my VPN drops every hour', occurredAt: new Date('2026-09-01T10:00:00Z'), ...over,
});

const actor = { email: 'cora@bgcengineering.ca', name: 'Cora Coordinator', kind: 'member' };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue(fsParent);
  // Behave like the real query: return only the ids asked for.
  prismaMock.ticketThreadEntry.findMany.mockImplementation(({ where }) => {
    const ids = where?.id?.in ?? [9001, 9002];
    return Promise.resolve([9001, 9002].filter((id) => ids.includes(id)).map((id) => entry(id)));
  });
  prismaMock.ticketThreadEntry.createMany.mockImplementation(({ data }) => Promise.resolve({ count: data.length }));
  prismaMock.ticketAttachment.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ticketAttachment.findMany.mockResolvedValue([]);
  attachmentServiceMock.copyToTicket.mockResolvedValue({ id: 1 });
  prismaMock.ticketLink.upsert.mockResolvedValue({});
  linkServiceMock.setParent.mockResolvedValue({});
  ticketServiceMock.addPrivateNote.mockResolvedValue({});
  ticketServiceMock.createTicket.mockResolvedValue({
    id: 900, nativeNumber: 1050, displayRef: 'TP-1050', origin: 'ticketpulse',
  });
});

describe('ticketSplitService.split — from a point in time (QA 09-18 #6)', () => {
  test('fromEntryId carries that message and everything after it, in order, deduped with entryIds', async () => {
    const all = [
      entry(9001, { occurredAt: new Date('2026-09-01T10:00:00Z') }),
      entry(9002, { occurredAt: new Date('2026-09-02T09:00:00Z') }),
      entry(9003, { occurredAt: new Date('2026-09-02T10:00:00Z'), isPrivate: true, authorType: 'agent' }),
    ];
    prismaMock.ticketThreadEntry.findFirst = jest.fn().mockResolvedValue(all[1]);
    prismaMock.ticketThreadEntry.findMany.mockImplementation(({ where }) => {
      if (where?.id?.in) return Promise.resolve(all.filter((e) => where.id.in.includes(e.id)));
      // the "onward" query: at/after the anchor
      return Promise.resolve(all.filter((e) => e.occurredAt >= all[1].occurredAt));
    });
    const out = await ticketSplitService.split(500, 1, { subject: 'VPN drops', fromEntryId: 9002, entryIds: [9003] }, actor);
    const copiedIds = prismaMock.ticketThreadEntry.createMany.mock.calls[0][0].data.map((d) => d.externalEntryId);
    expect(copiedIds).toEqual(['split:500:9002', 'split:500:9003']);
    expect(out.copied).toBe(2);
    expect(out.fromEntryId).toBe(9002);
    // the parent's note says where the cut was
    const parentNote = ticketServiceMock.addPrivateNote.mock.calls.find((c) => c[0] === 500)[2].bodyText;
    expect(parentNote).toMatch(/Everything from the message of .* by John Smith onward went with it/);
  });

  test('an anchor from another ticket is refused', async () => {
    prismaMock.ticketThreadEntry.findFirst = jest.fn().mockResolvedValue(null);
    await expect(ticketSplitService.split(500, 1, { subject: 'VPN', fromEntryId: 4242 }, actor))
      .rejects.toThrow(/not part of this ticket/);
  });

  test('a requester override makes someone else the child\'s requester; the parent keeps theirs', async () => {
    await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001], requesterEmail: 'ANNA@bgcengineering.ca', requesterName: 'Anna Lee' }, actor);
    const data = ticketServiceMock.createTicket.mock.calls[0][1];
    expect(data.requesterEmail).toBe('anna@bgcengineering.ca');
    expect(data.requesterName).toBe('Anna Lee');
    expect(data.requesterId).toBeUndefined();
  });

  test('parentStatus is applied after the split — FS-born parents through the FS write-back, failures reported not thrown', async () => {
    ticketServiceMock.updateFsTicket = jest.fn().mockResolvedValue({});
    const out = await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001], parentStatus: 'Pending' }, actor);
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledWith(500, 1, { status: 'Pending' }, actor);
    expect(out.parentStatus).toEqual({ requested: 'Pending', applied: true });

    ticketServiceMock.updateFsTicket.mockRejectedValue(new Error('FS queue busy'));
    const out2 = await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001], parentStatus: 'Resolved' }, actor);
    expect(out2.child.ref).toBe('TP-1050');
    expect(out2.parentStatus).toMatchObject({ requested: 'Resolved', applied: false });

    ticketServiceMock.changeStatus = jest.fn().mockResolvedValue({});
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsParent, origin: 'ticketpulse', nativeNumber: 77, freshserviceTicketId: null });
    await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001], parentStatus: 'Resolved' }, actor);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(500, 1, 'Resolved', actor, expect.objectContaining({ resolutionNote: expect.stringMatching(/Split into TP-1050/) }));
  });
});

describe('ticketSplitService.split', () => {
  test('an FS-born parent can be split — the case merge would refuse', async () => {
    const out = await ticketSplitService.split(500, 1, { subject: 'VPN drops every hour', entryIds: [9001, 9002] }, actor);
    expect(out.child.ref).toBe('TP-1050');
    expect(out.parent.ref).toBe('#231164');
    expect(out.copied).toBe(2);
  });

  test('the child is created TP-born, inheriting the parent context, with no AI triage', async () => {
    await ticketSplitService.split(500, 1, { subject: 'VPN drops', entryIds: [9001] }, actor);
    const [, input] = ticketServiceMock.createTicket.mock.calls[0];
    expect(input.subject).toBe('VPN drops');
    expect(input.requesterId).toBe(77);
    expect(input.internalCategoryId).toBe(4);
    expect(input.priority).toBe(2);
    // The agent already chose the category; don't pay for an LLM run.
    expect(input.runAiTriage).toBe(false);
    // And don't email the requester unless explicitly asked.
    expect(input.notifyRequester).toBe(false);
  });

  test('entries are COPIED with split provenance, never moved', async () => {
    await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001, 9002] }, actor);
    const { data } = prismaMock.ticketThreadEntry.createMany.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data[0].externalEntryId).toBe('split:500:9001');
    expect(data[0].ticketId).toBe(900);
    // The copy must never be mirrored back to FreshService.
    expect(data[0].mirrorState).toBeNull();
    // Original author and timestamp survive so the thread reads naturally.
    expect(data[0].actorEmail).toBe('jsmith@bgcengineering.ca');
    expect(data[0].occurredAt).toEqual(new Date('2026-09-01T10:00:00Z'));
    // Nothing was deleted or updated on the parent's thread.
    expect(prismaMock.ticketThreadEntry.createMany).toHaveBeenCalledTimes(1);
  });

  test('attachments on the copied entries are re-pointed, not duplicated', async () => {
    const out = await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001, 9002] }, actor);
    const call = prismaMock.ticketAttachment.updateMany.mock.calls[0][0];
    expect(call.where.threadEntryId.in).toEqual([9001, 9002]);
    expect(call.where.ticketId).toBe(500);
    expect(call.data).toEqual({ ticketId: 900 });
    expect(out.attachmentsMoved).toBe(1);
  });

  test('moveAttachments:false leaves every attachment on the parent', async () => {
    const out = await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001], moveAttachments: false }, actor);
    expect(prismaMock.ticketAttachment.updateMany).not.toHaveBeenCalled();
    expect(out.attachmentsMoved).toBe(0);
  });

  test('the family link goes through setParent so its invariants hold', async () => {
    const out = await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001] }, actor);
    expect(linkServiceMock.setParent).toHaveBeenCalledWith(900, 1, { parentTicketId: 500 }, actor);
    expect(out.linkKind).toBe('parent_of');
  });

  test('a refused parent link falls back to related_to rather than losing the split', async () => {
    linkServiceMock.setParent.mockRejectedValue(new Error('That would create a loop'));
    const out = await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001] }, actor);
    expect(out.linkKind).toBe('related_to');
    expect(out.child.ref).toBe('TP-1050');
    expect(prismaMock.ticketLink.upsert).toHaveBeenCalled();
  });

  test('both tickets get a note, and a failed note never fails the split', async () => {
    ticketServiceMock.addPrivateNote.mockRejectedValue(new Error('FreshService queue timeout'));
    const out = await ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001] }, actor);
    // On an FS-born parent the note is an FS API write on the interactive
    // lane — it can 503, and the split is already durable by then.
    expect(out.child.ref).toBe('TP-1050');
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledTimes(2);
  });

  test('a split with no messages selected still produces a linked child', async () => {
    const out = await ticketSplitService.split(500, 1, { subject: 'Follow-up work' }, actor);
    expect(out.copied).toBe(0);
    expect(prismaMock.ticketThreadEntry.createMany).not.toHaveBeenCalled();
    expect(out.child.ref).toBe('TP-1050');
  });

  test('an entry id from another ticket is refused by name', async () => {
    // 4242 does not exist on this ticket, so the query cannot return it.
    await expect(ticketSplitService.split(500, 1, { subject: 'VPN', entryIds: [9001, 4242] }, actor))
      .rejects.toThrow(/not part of this ticket's conversation: 4242/);
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('a subject is required, and an over-long one is refused', async () => {
    await expect(ticketSplitService.split(500, 1, { subject: '  ' }, actor)).rejects.toThrow(/needs a subject/);
    await expect(ticketSplitService.split(500, 1, { subject: 'x'.repeat(501) }, actor)).rejects.toThrow(/too long/);
  });

  test('deleted and spam tickets cannot be split', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsParent, status: 'Spam' });
    await expect(ticketSplitService.split(500, 1, { subject: 'VPN' }, actor)).rejects.toThrow(/Cannot split a spam ticket/);
  });

  test('a ticket outside the workspace is a not-found, not an empty split', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    await expect(ticketSplitService.split(500, 2, { subject: 'VPN' }, actor)).rejects.toThrow(/no longer exists/);
  });
});

describe('ticketSplitService.split — the original description travels with the split (QA 09-15 #2)', () => {
  // TP-1517 "App Testing Feedback": three test-plan PDFs sat on the DESCRIPTION
  // (no thread entry) and the child opened with "Split out of TP-1517" and
  // nothing else. Copies, never moves: the parent keeps its evidence.
  const descParent = { ...fsParent, description: '<p>Through Company Portal, install and test the following apps:</p><ul><li>AdminHub</li></ul>' };
  const descAttachments = [
    { id: 67048, ticketId: 500, workspaceId: 1, threadEntryId: null, fileName: 'BGC_AdminHub_Pilot_Checks.pdf', blobName: 'b1', contentType: 'application/pdf', source: 'upload' },
    { id: 67049, ticketId: 500, workspaceId: 1, threadEntryId: null, fileName: 'BGC-Network-Drives-Test-Plan.pdf', blobName: 'b2', contentType: 'application/pdf', source: 'upload' },
  ];

  test('by default the child quotes the parent description and gets copies of its attachments', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(descParent);
    prismaMock.ticketAttachment.findMany.mockResolvedValue(descAttachments);
    const out = await ticketSplitService.split(500, 1, { subject: 'Child ticket - test', entryIds: [] }, actor);
    const [, input] = ticketServiceMock.createTicket.mock.calls[0];
    expect(input.description).toContain('original description');
    expect(input.description).toContain('<blockquote');
    expect(input.description).toContain('AdminHub');
    expect(attachmentServiceMock.copyToTicket).toHaveBeenCalledTimes(2);
    expect(attachmentServiceMock.copyToTicket.mock.calls[0][1]).toMatchObject({ ticketId: 900 });
    // The lookup targeted description-level rows only, and nothing on the parent moved.
    expect(prismaMock.ticketAttachment.findMany.mock.calls[0][0].where).toMatchObject({ ticketId: 500, threadEntryId: null });
    expect(prismaMock.ticketAttachment.updateMany).not.toHaveBeenCalled();
    expect(out.attachmentsCopied).toBe(2);
  });

  test('the agent\'s own opening text comes first, the quoted original after it', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(descParent);
    await ticketSplitService.split(500, 1, { subject: 'Child', entryIds: [], description: '<p>Just the DriveMapping part.</p>' }, actor);
    const [, input] = ticketServiceMock.createTicket.mock.calls[0];
    expect(input.description.indexOf('DriveMapping')).toBeLessThan(input.description.indexOf('original description'));
  });

  test('includeDescription:false keeps today\'s placeholder and copies nothing', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(descParent);
    prismaMock.ticketAttachment.findMany.mockResolvedValue(descAttachments);
    const out = await ticketSplitService.split(500, 1, { subject: 'Child', entryIds: [], includeDescription: false }, actor);
    const [, input] = ticketServiceMock.createTicket.mock.calls[0];
    expect(input.description).toContain('Split out of');
    expect(attachmentServiceMock.copyToTicket).not.toHaveBeenCalled();
    expect(out.attachmentsCopied).toBe(0);
  });

  test('one failed copy does not abort the split', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(descParent);
    prismaMock.ticketAttachment.findMany.mockResolvedValue(descAttachments);
    attachmentServiceMock.copyToTicket.mockRejectedValueOnce(new Error('blob gone')).mockResolvedValueOnce({ id: 2 });
    const out = await ticketSplitService.split(500, 1, { subject: 'Child', entryIds: [] }, actor);
    expect(out.attachmentsCopied).toBe(1);
    expect(out.child.ref).toBe('TP-1050');
  });
});
