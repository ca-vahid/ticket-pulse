import { jest } from '@jest/globals';

// FreshService switch: the FreshService id is a tombstone that stays findable.
//  - an adopted ticket resolves by '#<fsId>', by the bare FS number AND by 'TP-n';
//  - a mirrored TP-born ticket in an Off workspace still resolves by '#<mirrorId>'
//    and still carries freshserviceTicketId (Off stops copying; it never forgets
//    the copy's id — integrations store it).

const rows = [
  // Adopted from FreshService #245001 → TP-2001 (workspace 1).
  { id: 77, workspaceId: 1, subject: 'Printer jam', status: 'Open', origin: 'ticketpulse', nativeNumber: 2001, freshserviceTicketId: 245001n, mirrorState: 'adopted' },
  // TP-born TP-1500, mirrored to FreshService #246100 before the workspace went Off.
  { id: 88, workspaceId: 1, subject: 'VPN token', status: 'Open', origin: 'ticketpulse', nativeNumber: 1500, freshserviceTicketId: 246100n, mirrorState: 'mirrored' },
];

function matches(row, where) {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(typeof v === 'bigint')) return false; // the resolver uses equality only
    return row[k] === v;
  });
}
const prismaMock = {
  ticket: {
    findFirst: jest.fn(async ({ where, select }) => {
      const hit = rows.find((r) => matches(r, where));
      if (!hit) return null;
      return Object.fromEntries(Object.keys(select).map((k) => [k, hit[k]]));
    }),
  },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { resolveTicketRef, resolveTicketRefOrThrow } = await import('../src/services/ticketRefResolver.js');
const { ticketDisplayRef } = await import('../src/utils/ticketOrigin.js');

describe('adopted ticket: the FS number stays a working reference', () => {
  test.each([['#245001'], ['245001'], ['TP-2001'], ['tp2001']])('%s resolves to the adopted ticket', async (ref) => {
    const hit = await resolveTicketRef(ref, 1);
    expect(hit?.id).toBe(77);
    expect(hit.freshserviceTicketId).toBe(245001n);
  });

  test('the by-FS-id lookup is not limited to FS-born tickets', async () => {
    await resolveTicketRef('#245001', 1);
    const fsLookup = prismaMock.ticket.findFirst.mock.calls.map(([q]) => q.where).find((w) => 'freshserviceTicketId' in w);
    expect(fsLookup).toEqual({ workspaceId: 1, freshserviceTicketId: 245001n });
    expect(fsLookup).not.toHaveProperty('origin');
  });

  test('an adopted ticket reads TP-n everywhere', async () => {
    const t = await resolveTicketRefOrThrow('#245001', 1);
    expect(t.displayRef).toBe('TP-2001');
    expect(ticketDisplayRef({ origin: 'freshservice', mirrorState: 'adopted', nativeNumber: 2001, freshserviceTicketId: 245001n })).toBe('TP-2001');
    expect(ticketDisplayRef({ origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 245001n })).toBe('#245001');
  });
});

describe('mirrored TP-born ticket in an Off workspace', () => {
  test("still resolves by '#<mirrorId>' and still carries freshserviceTicketId", async () => {
    const hit = await resolveTicketRefOrThrow('#246100', 1);
    expect(hit.id).toBe(88);
    expect(hit.freshserviceTicketId).toBe(246100n);
    expect(hit.displayRef).toBe('TP-1500');
    const byTp = await resolveTicketRef('TP-1500', 1);
    expect(byTp.freshserviceTicketId).toBe(246100n);
  });
});
