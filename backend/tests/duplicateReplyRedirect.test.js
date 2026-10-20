import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const prismaMock = {
  ticketLink: { findFirst: jest.fn() },
  ticket: { findUnique: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn() },
};
const activityMock = { create: jest.fn(async () => ({})) };
const mirrorMock = { enqueueThreadEntry: jest.fn(async () => ({})) };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { redirectReplyOnClosedDuplicate, MAX_REDIRECT_HOPS } = await import('../src/services/duplicateReplyRedirect.js');

const dup = { id: 64074, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 247899, nativeNumber: null, requester: { name: 'Rita Requester' } };
const survivor = { id: 63883, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 10198, freshserviceTicketId: 247700, subject: 'Email archive' };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketLink.findFirst.mockResolvedValue({ relatedTicketId: survivor.id, kind: 'duplicate_of' });
  prismaMock.ticket.findUnique.mockResolvedValue(survivor);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ id: 900, actorName: 'Rita Requester', bodyText: 'Any update?', bodyHtml: '<p>Any update?</p>', occurredAt: new Date('2026-10-19T23:13:00Z') });
  prismaMock.ticketThreadEntry.create.mockImplementation(async ({ data }) => ({ id: 5001, ...data }));
});

describe('redirectReplyOnClosedDuplicate', () => {
  it('copies a reply on a closed duplicate to the surviving ticket as a private note and re-raises it there', async () => {
    const moved = await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Closed', extra: { externalEntryId: 'fs-conv-77', fromEmail: 'rita@example.com' }, dedupeStamp: 'fs-conv-77' });

    expect(moved).toMatchObject({ targetId: survivor.id, hops: 1, dedupeStamp: 'fs-conv-77:via:64074' });
    expect(moved.extra).toMatchObject({ redirectedFrom: dup.id, redirectedNoteId: 5001, redirectHops: 1 });
    expect(moved.extra.entryId).toBeUndefined();
    const note = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(note).toMatchObject({ ticketId: survivor.id, isPrivate: true, eventType: 'note', externalEntryId: 'dupreply:64074:fs-conv-77' });
    expect(note.bodyText).toContain('Rita Requester replied on #247899');
    expect(note.bodyText).toContain('Any update?');
    expect(activityMock.create).toHaveBeenCalledTimes(2);
  });

  it('leaves an open duplicate alone, and a ticket with no duplicate link', async () => {
    expect(await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Open', extra: {} })).toBeNull();
    prismaMock.ticketLink.findFirst.mockResolvedValue(null);
    expect(await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Resolved', extra: {} })).toBeNull();
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  it('never follows a link into another workspace, and stops after the hop limit', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...survivor, workspaceId: 2 });
    expect(await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Closed', extra: {} })).toBeNull();
    prismaMock.ticket.findUnique.mockResolvedValue(survivor);
    expect(await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Closed', extra: { redirectHops: MAX_REDIRECT_HOPS } })).toBeNull();
  });

  it('a second delivery of the same reply is recognised and not copied twice', async () => {
    prismaMock.ticketThreadEntry.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const moved = await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Closed', extra: { externalEntryId: 'fs-conv-77' }, dedupeStamp: 'fs-conv-77' });
    expect(moved).toMatchObject({ targetId: survivor.id, duplicateEvent: true });
    expect(activityMock.create).not.toHaveBeenCalled();
  });

  it('a lookup failure falls back to the old behaviour (null)', async () => {
    prismaMock.ticketLink.findFirst.mockRejectedValue(new Error('pool timeout'));
    expect(await redirectReplyOnClosedDuplicate(dup, { statusBase: 'Closed', extra: {} })).toBeNull();
  });
});
