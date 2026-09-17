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
// Agents of ws1 (16 Sep 2026 fix): a ticket an agent filed is usually for someone else.
const techFindMany = jest.fn(async () => ([{ email: 'snasiri@bgcengineering.ca' }]));
const techFindFirst = jest.fn(async () => null);
const requesterFindFirst = jest.fn(async () => null);
jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    competencyCategory: { findMany: jest.fn(async () => ([
      { id: 11, name: 'New Hire Workstation', parentId: 1 },
      { id: 12, name: 'Laptop / Workstation Procurement', parentId: 2 },
    ])) },
    ticket: { findMany },
    technician: { findMany: techFindMany, findFirst: techFindFirst },
    requester: { findFirst: requesterFindFirst },
    workspace: { findUnique: jest.fn(async () => ({ internalDomains: ['bgcengineering.ca'] })) },
  },
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { isConfigured: () => false } }));
jest.unstable_mockModule('../src/services/fsApprovalRefreshService.js', () => ({
  refreshFsApprovalStatus: async (t) => t, refreshFsApprovalStatuses: async (ts) => ts, resetFsApprovalRefreshCache: () => {}, default: {},
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  default: svc, parsePerson, usernameFromSubject, deriveState, rowState, namedRecipientFromSubject, subjectNamesPerson,
} = await import('../src/services/hardwareHandoutService.js');
const { clearPersonNameCache } = await import('../src/services/personDirectoryService.js');

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

beforeEach(() => {
  findMany.mockReset(); findMany.mockResolvedValue([]);
  techFindFirst.mockReset(); techFindFirst.mockResolvedValue(null);
  requesterFindFirst.mockReset(); requesterFindFirst.mockResolvedValue(null);
  clearPersonNameCache();
});

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

describe('an agent filing for someone else — Assetron 16 Sep 2026 (#219171)', () => {
  // Real ws1 row: Soheil (IT agent) requested a laptop for Cristian Orellana in
  // April; Assetron asked about Soheil and was told #219171 covers him.
  const soheilForCristian = (over = {}) => ticket({
    id: 21787, subject: 'Request for Cristian Orellana : Laptop', status: 'Closed', freshserviceTicketId: 219171n,
    requester: { id: 9, name: 'Soheil Nasiri', email: 'snasiri@bgcengineering.ca' },
    internalCategory: { name: 'Onboarding & Offboarding' }, internalSubcategory: { name: 'New Hire Workstation' },
    ...over,
  });

  test('subject parsing: the named recipient, and whether a subject names a given person', () => {
    expect(namedRecipientFromSubject('Request for Cristian Orellana : Laptop')).toBe('cristian orellana');
    expect(namedRecipientFromSubject('Laptop for Ana De Souza (Calgary)')).toBe('ana de souza');
    expect(namedRecipientFromSubject('New laptop request')).toBeNull();
    expect(namedRecipientFromSubject('Ready for pickup tomorrow')).toBeNull();
    expect(subjectNamesPerson('Request for Cristian Orellana : Laptop', { name: 'Cristian Orellana' })).toBe(true);
    expect(subjectNamesPerson('Laptop - corellana - setup', { username: 'corellana' })).toBe(true);
    expect(subjectNamesPerson('Request for Cristian Orellana : Laptop', { name: 'Soheil Nasiri', username: 'snasiri' })).toBe(false);
  });

  test('the AGENT is not cleared by a ticket he filed for somebody else — NO_TICKET, with the ticket listed as excluded', async () => {
    findMany.mockResolvedValue([soheilForCristian()]);
    const r = await svc.check(1, 'snasiri@bgcengineering.ca');
    expect(r.decision).toBe('NO_TICKET');
    expect(r.ticket).toBeNull();
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0].ref).toBe('#219171');
    expect(r.excluded[0].why).toMatch(/filed by Soheil Nasiri \(IT agent\) for Cristian Orellana, not for snasiri/);
    expect(r.reason).toMatch(/not counted/);
  });

  test('the RECIPIENT named in the subject is cleared by that ticket (looked up by display name)', async () => {
    findMany.mockResolvedValue([soheilForCristian()]);
    requesterFindFirst.mockResolvedValue({ name: 'Cristian Orellana' });
    const r = await svc.check(1, 'corellana@bgcengineering.ca');
    expect(r.decision).toBe('ALLOW');
    expect(r.person.matchedBy).toBe('subject_name');
    expect(r.person.name).toBe('Cristian Orellana');
    expect(r.person.filedBy).toBe('Soheil Nasiri');
    expect(r.ticket.ref).toBe('#219171');
  });

  test('a bare username still resolves the name through the workspace domain', async () => {
    findMany.mockResolvedValue([soheilForCristian()]);
    requesterFindFirst.mockResolvedValue({ name: 'Cristian Orellana' });
    const r = await svc.check(1, 'corellana');
    expect(r.decision).toBe('ALLOW');
    expect(r.person.matchedBy).toBe('subject_name');
  });

  test("an agent's OWN ticket (subject names nobody) still counts for the agent", async () => {
    findMany.mockResolvedValue([soheilForCristian({ subject: 'Replacement laptop — battery swelling' })]);
    const r = await svc.check(1, 'snasiri');
    expect(r.decision).toBe('ALLOW');
    expect(r.person.matchedBy).toBe('requester_email');
    expect(r.excluded).toEqual([]);
  });

  test('a non-agent requester whose subject mentions a colleague is still their own ticket', async () => {
    findMany.mockResolvedValue([ticket({ subject: 'Laptop for Hao Guo like the one Dana Ruiz has' })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('ALLOW');
    expect(r.person.matchedBy).toBe('requester_email');
  });
});

describe('FreshService approvals on the ticket (17 Sep 2026)', () => {
  test('an FS-approved hardware ticket ALLOWS with isApproved true and names FreshService', async () => {
    // #219171 "Request for Cristian Orellana : Laptop": approved in FreshService on 20 Apr 2026,
    // no Ticket Pulse rows — used to read "needs no approval".
    findMany.mockResolvedValue([ticket({ approvals: [], fsApprovalStatusName: 'Approved' })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('ALLOW');
    expect(r.isApproved).toBe(true);
    expect(r.approval.state).toBe('APPROVED');
    expect(r.approval.source).toBe('freshservice');
    expect(r.approval.decidedBy).toBe('FreshService approval');
    expect(r.reason).toMatch(/Approved in FreshService/);
  });

  test('an FS approval still Requested HOLDS', async () => {
    findMany.mockResolvedValue([ticket({ approvals: [], fsApprovalStatusName: 'Requested' })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('HOLD');
    expect(r.approval.state).toBe('PENDING');
    expect(r.approval.source).toBe('freshservice');
  });

  test('"Not Requested" in FreshService changes nothing', async () => {
    findMany.mockResolvedValue([ticket({ approvals: [], fsApprovalStatusName: 'Not Requested' })]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('ALLOW');
    expect(r.isApproved).toBe(false);
    expect(r.approval.source).toBeNull();
  });

  test('a Ticket Pulse approval beats an FS rejection on an older ticket (re-request that succeeded)', async () => {
    findMany.mockResolvedValue([
      ticket({ id: 2, approvals: [approval('approved')] }),
      ticket({ id: 1, approvals: [], fsApprovalStatusName: 'Rejected' }),
    ]);
    const r = await svc.check(1, 'haguo@bgcengineering.ca');
    expect(r.decision).toBe('ALLOW');
    expect(r.approval.state).toBe('APPROVED');
    expect(r.approval.source).toBe('ticketpulse');
    expect(r.approval.decidedBy).toBe('A Manager');
  });
});
