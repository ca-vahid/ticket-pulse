import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * FR 09-12 (Vahid) — "they don't need a sandbox and they don't need all the
 * bells and whistles. Has a new laptop request been approved when an asset is
 * assigned to a person. That's it."
 *
 * The shapes below are the real ws1 rows the redesign was measured against:
 *   - 370 hardware tickets in 90 days, 12 with an approval  -> 3%
 *   - 75 "NH Laptop" tickets, 74 with no approval at all
 *   - new hires have NO requester row; their name is only in the subject
 * A gate that denied on "no approval" would have blocked 97% of handouts, so
 * the ticket is the gate and the approval is the exception.
 */

const findMany = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    competencyCategory: { findMany: jest.fn(async () => ([
      { id: 11, name: 'New Hire Workstation', parentId: 1 },
      { id: 12, name: 'Laptop / Workstation Procurement', parentId: 2 },
    ])) },
    ticket: { findMany },
  },
}));

const {
  default: svc, parsePerson, usernameFromSubject, deriveState, rowState,
} = await import('../src/services/hardwareHandoutService.js');

const ticket = (over = {}) => ({
  id: 1, subject: 'New Laptop Request', status: 'Open', createdAt: new Date('2026-09-01'),
  origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 239285n,
  requester: { id: 5, name: 'Hao Guo', email: 'haguo@bgcengineering.ca' },
  internalCategory: { name: 'Procurement & Licensing' },
  internalSubcategory: { name: 'Laptop / Workstation Procurement' },
  approvals: [],
  ...over,
});

const approval = (status, over = {}) => ({
  id: 1, status, expiresAt: null, decidedAt: new Date('2026-09-09'),
  approverEmail: 'manager@bgcengineering.ca', approverName: 'A Manager',
  approvalCategory: { name: 'New Computer Upgrade' }, ...over,
});

beforeEach(() => { findMany.mockReset(); findMany.mockResolvedValue([]); });

describe('the person key — an asset system holds a person, not a ticket number', () => {
  test('an e-mail and a bare username both parse to the same person', () => {
    expect(parsePerson('SReguige@bgcengineering.ca')).toEqual({ email: 'sreguige@bgcengineering.ca', username: 'sreguige' });
    expect(parsePerson('  SReguige ')).toEqual({ email: null, username: 'sreguige' });
    expect(parsePerson('')).toBeNull();
  });

  test('matches on the requester e-mail', async () => {
    findMany.mockResolvedValue([ticket()]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.person.matchedBy).toBe('requester_email');
    expect(r.ticket.ref).toBe('#239285');
  });

  test('a username matches a requester e-mail by its local part', async () => {
    findMany.mockResolvedValue([ticket()]);
    const r = await svc.check(1, 'haguo');
    expect(r.person.matchedBy).toBe('requester_email');
  });

  test('somebody else’s hardware ticket is not theirs', async () => {
    findMany.mockResolvedValue([ticket()]);
    const r = await svc.check(1, 'someone.else@bgcengineering.ca');
    expect(r.decision).toBe('NO_TICKET');
    expect(r.ticket).toBeNull();
  });
});

describe('new hires — the case a requester-only lookup gets wrong every time', () => {
  // The automation has emitted four subject shapes since May 2025. All four are
  // live in ws1 today (386 / 9 / 4 / 1 tickets), so the username is located
  // from the END of the subject, never at a fixed index.
  test.each([
    ['NH Workstation - Victoria - CA - SJones - 2025-09-04', 'sjones'],
    ['NH Workstation - HFX - TUser1 - 2026-06-01', 'tuser1'],
    ['NH Laptop - Vancouver - CA - WLam', 'wlam'],
    ['NH Workstation - Vancouver - KaLiu (May 5)', 'kaliu'],
    ['NH Workstation - Van - ABarth (June 2nd)', 'abarth'],
    ['NH Laptop - Vancouver - CA - beverly.yen - 2026-09-14', 'beverly.yen'],
  ])('reads the new hire out of %s', (subject, expected) => {
    expect(usernameFromSubject(subject)).toBe(expected);
  });

  test.each([
    ['Regarding swapping laptop from Dell to Mac', 'an ordinary subject'],
    ['Laptop - broken - urgent', 'a subject that merely contains dashes'],
    ['NH Laptop - Ottawa', 'too few segments'],
  ])('refuses to invent a person from %s', (subject) => {
    expect(usernameFromSubject(subject)).toBeNull();
  });

  test('a new hire with no requester row is still found, and is allowed', async () => {
    // Exactly the production shape: filed BY the automation, FOR the new hire.
    findMany.mockResolvedValue([ticket({
      id: 9, freshserviceTicketId: 241523n,
      subject: 'NH Laptop - Ottawa - CA - SReguige - 2026-09-21',
      requester: { id: 1, name: 'Ticket Pulse', email: 'ticketpulse@bgcengineering.ca' },
      internalSubcategory: { name: 'New Hire Workstation' },
      approvals: [],
    })]);
    const r = await svc.check(1, 'SReguige');
    expect(r.person.matchedBy).toBe('ticket_subject');
    expect(r.decision).toBe('ALLOW');
    expect(r.approval.state).toBe('NOT_REQUESTED');
    expect(r.reason).toMatch(/needs no approval/);
  });

  test('the automation account does not get matched as if it were the person', async () => {
    findMany.mockResolvedValue([ticket({
      subject: 'NH Laptop - Ottawa - CA - SReguige - 2026-09-21',
      requester: { id: 1, name: 'Ticket Pulse', email: 'ticketpulse@bgcengineering.ca' },
    })]);
    const r = await svc.check(1, 'someone');
    expect(r.decision).toBe('NO_TICKET');
  });
});

describe('the decision — a ticket allows, an ungranted approval holds', () => {
  test('a hardware ticket with no approval ALLOWS (the 97% path)', async () => {
    findMany.mockResolvedValue([ticket({ approvals: [] })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('ALLOW');
    expect(r.isApproved).toBe(false); // honest: nobody approved anything
  });

  test('a granted approval ALLOWS and says so', async () => {
    findMany.mockResolvedValue([ticket({ approvals: [approval('approved')] })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('ALLOW');
    expect(r.isApproved).toBe(true);
    expect(r.approval.state).toBe('APPROVED');
    expect(r.approval.decidedBy).toBe('A Manager');
  });

  test.each([
    ['pending', 'PENDING'],
    ['rejected', 'REJECTED'],
    ['info_requested', 'INFO_REQUESTED'],
  ])('an approval that is %s HOLDS', async (status, state) => {
    findMany.mockResolvedValue([ticket({ approvals: [approval(status, { decidedAt: null })] })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('HOLD');
    expect(r.isApproved).toBe(false);
    expect(r.approval.state).toBe(state);
  });

  test('a pending approval whose link has lapsed HOLDS as EXPIRED', async () => {
    findMany.mockResolvedValue([ticket({
      approvals: [approval('pending', { decidedAt: null, expiresAt: new Date('2026-09-03') })],
    })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca', { now: new Date('2026-09-12') });
    expect(r.approval.state).toBe('EXPIRED');
    expect(r.decision).toBe('HOLD');
  });

  test('a cancelled sibling is not a refusal — it ALLOWS', async () => {
    // Every approved request in ws1 carries a cancelled sibling, because the
    // first decision wins and the others auto-cancel. Cancelled alone means
    // withdrawn, which is not somebody saying no.
    findMany.mockResolvedValue([ticket({ approvals: [approval('cancelled')] })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('ALLOW');
    expect(r.approval.state).toBe('CANCELLED');
  });

  test('approved beats a cancelled sibling and an older rejection', async () => {
    findMany.mockResolvedValue([ticket({
      approvals: [approval('cancelled'), approval('rejected'), approval('approved')],
    })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.approval.state).toBe('APPROVED');
    expect(r.decision).toBe('ALLOW');
  });

  test('nothing at all is NO_TICKET, and never a silent denial', async () => {
    findMany.mockResolvedValue([]);
    const r = await svc.check(1, 'nobody@bgcengineering.ca');
    expect(r.decision).toBe('NO_TICKET');
    expect(r.isApproved).toBe(false);
    expect(r.reason).toMatch(/no record|No laptop or desktop ticket/i);
    expect(r.ticket).toBeNull();
  });
});

describe('state derivation is fail-closed', () => {
  test('an unrecognised status is never approved', () => {
    expect(rowState({ status: 'weird' })).toBe('CANCELLED');
    expect(deriveState([{ status: 'weird' }])).toBe('CANCELLED');
  });
  test('no rows is NOT_REQUESTED, not APPROVED', () => {
    expect(deriveState([])).toBe('NOT_REQUESTED');
    expect(deriveState(null)).toBe('NOT_REQUESTED');
  });
});

describe('the answer explains itself', () => {
  test('scope reports which categories and window produced the verdict', async () => {
    findMany.mockResolvedValue([ticket()]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca', { windowDays: 90 });
    expect(r.scope.windowDays).toBe(90);
    expect(r.scope.categories).toEqual(['Laptop / Workstation Procurement', 'New Hire Workstation']);
    expect(r.scope.categoriesConfigured).toBe(2);
  });

  test('other matching tickets are listed, not silently dropped', async () => {
    findMany.mockResolvedValue([
      ticket({ id: 1, freshserviceTicketId: 111n, approvals: [approval('approved')] }),
      ticket({ id: 2, freshserviceTicketId: 222n }),
    ]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.ticket.ref).toBe('#111');
    expect(r.otherTickets.map((t) => t.ref)).toEqual(['#222']);
  });
});
