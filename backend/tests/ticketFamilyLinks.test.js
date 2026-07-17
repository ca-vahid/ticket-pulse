import { jest } from '@jest/globals';

/** Parent/child ticket links (QA 07-16 #4) — cycle + single-parent guards. */

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  ticketLink: { findFirst: jest.fn(), findMany: jest.fn(), upsert: jest.fn().mockResolvedValue({ id: 1 }), delete: jest.fn().mockResolvedValue({}) },
};
const mirrorMock = { getInteractiveClient: jest.fn().mockResolvedValue({ addPrivateNote: jest.fn().mockResolvedValue({}) }) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: ticketLinkService } = await import('../src/services/ticketLinkService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const CHILD = { id: 5, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 5, freshserviceTicketId: null };
const PARENT = { id: 6, workspaceId: 1, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 900n };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketLink.findMany.mockResolvedValue([]);
  prismaMock.ticketLink.upsert.mockResolvedValue({ id: 1 });
});

describe('ticketLinkService.setParent', () => {
  test('links a child to a parent and drops FS pointer notes', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(CHILD).mockResolvedValueOnce(PARENT);
    prismaMock.ticketLink.findFirst
      .mockResolvedValueOnce(null)  // _isDescendant: parent has no parent
      .mockResolvedValueOnce(null); // no existing parent on the child
    const fam = await ticketLinkService.setParent(5, 1, { parentTicketId: 6 }, { email: 'c@x.io' });
    expect(prismaMock.ticketLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ ticketId: 6, relatedTicketId: 5, kind: 'parent_of' }),
    }));
    // FS pointer note attempted on the FS-born parent.
    expect(mirrorMock.getInteractiveClient).toHaveBeenCalled();
    expect(fam).toHaveProperty('parent');
  });

  test('rejects self-parenting', async () => {
    await expect(ticketLinkService.setParent(5, 1, { parentTicketId: 5 }, {})).rejects.toThrow(ValidationError);
  });

  test('rejects a cycle (chosen parent is already a descendant of the child)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(CHILD).mockResolvedValueOnce(PARENT);
    // _isDescendant(6, 5): parent 6's parent is 5 → cycle.
    prismaMock.ticketLink.findFirst.mockResolvedValueOnce({ ticketId: 5 });
    await expect(ticketLinkService.setParent(5, 1, { parentTicketId: 6 }, {})).rejects.toThrow(/loop/i);
  });

  test('single parent: replaces an existing different parent link', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(CHILD).mockResolvedValueOnce(PARENT);
    prismaMock.ticketLink.findFirst
      .mockResolvedValueOnce(null)                 // no cycle
      .mockResolvedValueOnce({ id: 77, ticketId: 99 }); // existing parent = ticket 99
    await ticketLinkService.setParent(5, 1, { parentTicketId: 6 }, {});
    expect(prismaMock.ticketLink.delete).toHaveBeenCalledWith({ where: { id: 77 } });
  });
});
