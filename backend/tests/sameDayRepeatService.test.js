import { jest } from '@jest/globals';

/**
 * QA 11-23 items 4–5, the TP-1042 shape: at 9:47 AM Pacific the requester
 * opened TP-1042 ("Can't sign in to Teams"), which went to Eli Park. At
 * 10:15 AM the same person opened TP-1043 ("Still can't sign in to Teams")
 * and the AI picked Dana Fox. TP-1043 should go to Eli (Live), or say so
 * (Shadow), and its priority goes one level above what the AI chose — once.
 */
const settingsStore = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => settingsStore.get(key) ?? null),
  set: jest.fn(async (key, value) => { settingsStore.set(key, value); }),
};
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  ticketEmbedding: { findMany: jest.fn() },
  ticketActivity: { findMany: jest.fn(), create: jest.fn() },
  ticketLink: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  assignmentPipelineRun: { findMany: jest.fn() },
  technician: { findFirst: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findFirst: jest.fn() },
};
const awayMock = { forTechnician: jest.fn() };
const addPrivateNote = jest.fn();
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({ openWorkloadStatuses: jest.fn(async () => ['Open', 'Pending']) }));
jest.unstable_mockModule('../src/services/assigneeAwayService.js', () => ({ default: awayMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { addPrivateNote } }));
const isBusinessHours = jest.fn();
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours } }));
const isMonitoringSender = jest.fn();
jest.unstable_mockModule('../src/services/alertCorrelationService.js', () => ({ default: { isMonitoringSender } }));

const { default: service, settingsKey } = await import('../src/services/assignmentFollowUp/sameDayRepeatService.js');
const { invalidateMachineSenderCache } = await import('../src/services/machineSenderService.js');

const WS = 1;
const ELI = 12;
const DANA = 11;
const pst = (hhmm) => new Date(`2026-11-23T${hhmm}:00.000-08:00`);
const NOW = pst('10:16');

const NEW_TICKET = {
  id: 2001, workspaceId: WS, requesterId: 77, createdAt: pst('10:15'), subject: "Still can't sign in to Teams", triageMode: null, origin: 'ticketpulse',
  occurrenceCount: 0, requester: { email: 'dana.fox@corp.example.com', unattended: false }, internalCategoryId: null, internalSubcategoryId: null,
};
const FIRST = {
  id: 2000, subject: "Can't sign in to Teams", createdAt: pst('09:47'), status: 'Open', origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null,
  triageMode: null, occurrenceCount: 0, requester: { email: 'dana.fox@corp.example.com', unattended: false },
  internalCategoryId: 10, internalSubcategoryId: 101, assignedTechId: ELI, assignedTech: { id: ELI, name: 'Eli Park' },
};
const REC = () => ({
  internalCategoryId: 10, internalSubcategoryId: 101, assessedPriority: 'Medium', assessedPriorityId: 2, priorityRationale: 'One person blocked.',
  recommendations: [{ techId: DANA, techName: 'Dana Fox' }],
});
/** `created` rows by ticket id, and `priority_changed` rows — one findMany, two questions. */
let createdRows = [];
let priorityRows = [];

beforeEach(() => {
  jest.clearAllMocks();
  settingsStore.clear();
  service._reset();
  invalidateMachineSenderCache();
  createdRows = [];
  priorityRows = [];
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver', internalDomains: ['corp.example.com'] });
  isMonitoringSender.mockResolvedValue(false);
  prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET });
  prismaMock.ticket.findMany.mockResolvedValue([FIRST]);
  prismaMock.ticket.count.mockResolvedValue(2);
  prismaMock.ticketEmbedding.findMany.mockResolvedValue([]);
  prismaMock.ticketActivity.findMany.mockImplementation(async ({ where }) => (where?.activityType === 'created' ? createdRows : priorityRows));
  prismaMock.ticketActivity.create.mockResolvedValue({ id: 1 });
  prismaMock.ticketLink.findMany.mockResolvedValue([]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 10, name: 'Collaboration' }, { id: 101, name: 'Teams' }]);
  prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue({
    id: ELI, name: 'Eli Park', isActive: true, timezone: 'America/Vancouver', workStartTime: '08:00', workEndTime: '17:00', freshserviceId: BigInt(55),
  });
  prismaMock.technicianLeave.findMany.mockResolvedValue([]);
  prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue(null);
  awayMock.forTechnician.mockResolvedValue(null);
  addPrivateNote.mockResolvedValue({});
  isBusinessHours.mockResolvedValue({ isBusinessHours: true });
});

const find = (over = {}) => service.findSameDayRelatedOpenTicket({ ...NEW_TICKET, internalCategoryId: 10, internalSubcategoryId: 101, ...over }, { now: NOW });

describe('findSameDayRelatedOpenTicket', () => {
  test('finds the requester\'s open ticket from earlier today about the same problem', async () => {
    const found = await find();
    expect(found).toMatchObject({ ticketId: 2000, ref: 'TP-1042', matchedOn: 'subcategory', similarity: 1, owner: { techId: ELI, techName: 'Eli Park' } });
    const where = prismaMock.ticket.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: WS, requesterId: 77, id: { not: 2001 }, isNoise: false, status: { in: ['Open', 'Pending'] } });
    expect(where.createdAt.gte.toISOString()).toBe('2026-11-23T08:00:00.000Z'); // Pacific midnight
    expect(where.createdAt.lt).toEqual(pst('10:15')); // earlier than this ticket only
  });

  test('the production shape: same subcategory and one shared word ("Teams") is a repeat', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, subject: "Can't sign into Teams" }]);
    expect(await find({ subject: 'Lost access to Teams again' })).toMatchObject({ ticketId: 2000, matchedOn: 'subcategory' });
  });

  test('the licence pair in the Teams subcategory shares only the product name: not a repeat', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, subject: "Can't sign in to Teams" }]);
    expect(await find({ subject: 'Teams licence for a starter' })).toBeNull();
    expect(prismaMock.competencyCategory.findMany).toHaveBeenCalledWith({ where: { id: { in: [10, 101] } }, select: { id: true, name: true } });
    // A shared word that is not the product counts.
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, subject: 'Teams licence renewal' }]);
    expect(await find({ subject: 'Teams licence for a starter' })).toMatchObject({ ticketId: 2000, sharedWords: ['licence'] });
    // Names unreadable: shared words do not count, the symptom still does.
    prismaMock.competencyCategory.findMany.mockRejectedValue(new Error('db down'));
    expect(await find({ subject: 'Teams licence for a starter' })).toBeNull();
    prismaMock.ticket.findMany.mockResolvedValue([FIRST]);
    expect(await find()).toMatchObject({ ticketId: 2000, symptom: true });
  });

  test('the same subcategory alone is not a repeat: some shared content word is needed', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, subject: 'Printer jam on floor 3' }]);
    expect(await find({ subject: 'Need a new monitor' })).toBeNull();
    // A category-only match keeps the 0.6 bar: one shared word is not enough.
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, internalSubcategoryId: null, subject: 'Teams licence for a starter' }]);
    expect(await find()).toBeNull();
  });

  test('different words still match when both tickets are embedded and the text is close', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, subject: 'Teams keeps logging me out' }]);
    prismaMock.ticketEmbedding.findMany.mockResolvedValue([
      { ticketId: 2001, embedding: [1, 0, 0] }, { ticketId: 2000, embedding: [0.95, 0.31, 0] },
    ]);
    expect(await find()).toMatchObject({ ticketId: 2000, matchedOn: 'subcategory', similarity: 0.95 });
  });

  test('a close subject is enough when the categories are missing', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, internalCategoryId: null, internalSubcategoryId: null, subject: 'Teams sign in failing' }]);
    const found = await find({ internalCategoryId: null, internalSubcategoryId: null, subject: 'RE: Teams sign in failing' });
    expect(found).toMatchObject({ ticketId: 2000, matchedOn: 'subject' });
  });

  test('a requester with more than 3 tickets that day is automation: never a repeat', async () => {
    prismaMock.ticket.count.mockResolvedValue(4);
    expect(await find()).toBeNull();
    prismaMock.ticket.count.mockResolvedValue(3);
    expect(await find()).toMatchObject({ ticketId: 2000 });
    prismaMock.ticket.count.mockRejectedValue(new Error('db down'));
    expect(await find()).toBeNull();
  });

  test('tickets a machine made never count, on either side', async () => {
    // A workflow's child ticket copies the parent's requester.
    createdRows = [{ ticketId: 2000, performedBy: 'Notification workflow', details: { actorKind: 'workflow' } }];
    expect(await find()).toBeNull();
    // Created through the API / an integration.
    createdRows = [{ ticketId: 2001, performedBy: 'apikey:ab12', details: { actorKind: 'api', createdVia: 'api' } }];
    expect(await find()).toBeNull();
    // Alert bundling / correlation and other Ticket Pulse automation.
    createdRows = [{ ticketId: 2000, performedBy: 'Ticket Pulse alert bundling', details: { actorKind: 'system', actorEmail: 'bundles@ticketpulse.internal' } }];
    expect(await find()).toBeNull();
    createdRows = [];
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, triageMode: 'trusted' }]);
    expect(await find()).toBeNull();
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, occurrenceCount: 3 }]);
    expect(await find()).toBeNull();
    prismaMock.ticket.findMany.mockResolvedValue([FIRST]);
    expect(await find({ requester: { email: 'no-reply@example.com' } })).toBeNull();
  });

  test('mail intake is a person writing in: it still counts', async () => {
    createdRows = [
      { ticketId: 2000, performedBy: 'Ticket Pulse Mail', details: { actorKind: 'system', actorEmail: 'mailbox@ticketpulse.internal', createdVia: 'email' } },
      { ticketId: 2001, performedBy: 'Ticket Pulse Mail', details: { actorKind: 'system', actorEmail: 'mailbox@ticketpulse.internal', createdVia: 'email' } },
    ];
    expect(await find()).toMatchObject({ ticketId: 2000 });
  });

  test('tickets already linked to each other (parent/child, related) are left out', async () => {
    prismaMock.ticketLink.findMany.mockResolvedValue([{ ticketId: 2000, relatedTicketId: 2001 }]);
    expect(await find()).toBeNull();
    const where = prismaMock.ticketLink.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ ticketId: 2001, relatedTicketId: { in: [2000] } }, { ticketId: { in: [2000] }, relatedTicketId: 2001 }]);
  });

  test('loads the ticket when only the id is given; no requester means nothing', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET, internalCategoryId: 10, internalSubcategoryId: 101 });
    expect(await service.findSameDayRelatedOpenTicket({ id: 2001 })).toMatchObject({ ticketId: 2000 });
    prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET, requesterId: null });
    expect(await service.findSameDayRelatedOpenTicket({ id: 2001 })).toBeNull();
  });

  test('a database error answers null', async () => {
    prismaMock.ticket.findMany.mockRejectedValue(new Error('db down'));
    expect(await find()).toBeNull();
  });
});

describe('evaluate: the repeat raises priority one level (item 5)', () => {
  test('Medium from the AI becomes High, with the reason on the run; the rationale is left as the AI wrote it', async () => {
    const rec = REC();
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, runId: 9, recommendation: rec, now: NOW });
    expect(out.bump).toEqual({ from: 'Medium', to: 'High' });
    expect(rec).toMatchObject({ assessedPriority: 'High', assessedPriorityId: 3, priorityRationale: 'One person blocked.' });
    expect(rec.repeatReport).toMatchObject({
      relatedTicketId: 2000, relatedRef: 'TP-1042', matchedOn: 'subcategory', aiPriority: 'Medium', raisedTo: 'High', raised: true, keptAt: null,
      owner: { techId: ELI, techName: 'Eli Park' }, sentence: 'Raised to High: same problem reported again today (TP-1042).',
      historyNote: 'Same problem reported again today (TP-1042)',
    });
  });

  test('Urgent stays Urgent; no AI priority, priority assessment off or trusted intake raise nothing', async () => {
    const urgent = { ...REC(), assessedPriority: 'Urgent', assessedPriorityId: 4 };
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: urgent })).bump).toBeNull();
    expect(urgent.assessedPriority).toBe('Urgent');
    expect(urgent.repeatReport).toMatchObject({ raised: false, notRaisedReason: 'already_urgent' });

    const none = { ...REC(), assessedPriority: undefined };
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: none })).record.notRaisedReason).toBe('no_ai_priority');

    const off = REC();
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: off, priorityAssessmentEnabled: false })).bump).toBeNull();
    expect(off.assessedPriority).toBe('Medium');

    // A trusted-intake ticket is never a repeat at all now.
    prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET, triageMode: 'trusted' });
    const trusted = REC();
    expect(await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: trusted })).toBeNull();
    expect(trusted.assessedPriority).toBe('Medium');
  });

  test('business hours: a High repeat becomes Urgent', async () => {
    const rec = { ...REC(), assessedPriority: 'High', assessedPriorityId: 3 };
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: rec, now: NOW });
    expect(isBusinessHours).toHaveBeenCalledWith(NOW, 'America/Vancouver', WS);
    expect(out.bump).toEqual({ from: 'High', to: 'Urgent' });
    expect(rec).toMatchObject({ assessedPriority: 'Urgent', assessedPriorityId: 4 });
  });

  test('after hours: a High repeat stays High and says why (never pages on-call)', async () => {
    isBusinessHours.mockResolvedValue({ isBusinessHours: false });
    const rec = { ...REC(), assessedPriority: 'High', assessedPriorityId: 3 };
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: rec, now: pst('22:30') });
    expect(out.bump).toBeNull();
    expect(rec).toMatchObject({ assessedPriority: 'High', assessedPriorityId: 3 });
    expect(rec.repeatReport).toMatchObject({
      raised: false, raisedTo: null, aiPriority: 'High', notRaisedReason: 'after_hours',
      sentence: 'Kept at High: after hours, a repeat report doesn\'t page on-call.',
    });
  });

  test('after hours a Medium repeat still becomes High; an unreadable calendar counts as after hours', async () => {
    isBusinessHours.mockResolvedValue({ isBusinessHours: false });
    const medium = REC();
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: medium })).bump).toEqual({ from: 'Medium', to: 'High' });
    expect(isBusinessHours).not.toHaveBeenCalled();
    isBusinessHours.mockRejectedValue(new Error('calendar down'));
    const high = { ...REC(), assessedPriority: 'High' };
    expect((await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: high })).record.notRaisedReason).toBe('after_hours');
    expect(high.assessedPriority).toBe('High');
  });

  test('no related ticket: nothing recorded, nothing changed', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([]);
    const rec = REC();
    expect(await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: rec })).toBeNull();
    expect(rec.assessedPriority).toBe('Medium');
    expect(rec.repeatReport).toBeUndefined();
  });
});

describe('only a person on staff reports again (production, 24 Nov 2026: 6 of 7 raises were wrong)', () => {
  const ACCOUNTING = 30;
  const IT_CLOUD = 50;
  const IT_VMS = 501;
  const IT_ACCOUNTS = 502;
  const STORAGE = 40;
  const FILE_SHARES = 401;
  /** The new ticket (2001) and the same requester's earlier one (2000), same category / subcategory. */
  const pair = ({ email, unattended = false, subject, earlier, cat, sub = null }) => {
    const requester = { email, unattended };
    prismaMock.ticket.findUnique.mockResolvedValue({ ...NEW_TICKET, subject, requester, internalCategoryId: cat, internalSubcategoryId: sub });
    prismaMock.ticket.findMany.mockResolvedValue([{ ...FIRST, subject: earlier, requester, internalCategoryId: cat, internalSubcategoryId: sub }]);
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: ACCOUNTING, name: 'Accounts Payable' }, { id: IT_CLOUD, name: 'Cloud' }, { id: IT_VMS, name: 'Virtual Machines' },
      { id: IT_ACCOUNTS, name: 'User Accounts' }, { id: STORAGE, name: 'Storage' }, { id: FILE_SHARES, name: 'File Shares' },
    ]);
    return { ...REC(), internalCategoryId: cat, internalSubcategoryId: sub };
  };
  const run = (rec) => service.evaluate({ workspaceId: WS, ticketId: 2001, runId: 30, recommendation: rec, now: NOW });

  test.each([
    ['a duplicate overdue-invoice reminder', 'ar@billing-vendor.example.com', 'Reminder: Invoice 4410023 is overdue'],
    ['an "invoices are now available online" notice', 'statements@supplier-portal.example.com', 'Invoices for October are now available online!'],
    ['a "Payment on Account Receipt"', 'receipts@supplier.example.com', 'Payment on Account Receipt'],
    ['a parcel carrier\'s billing notice', 'billing-online@parcelco.example.com', 'ParcelCo Billing Online - New Invoice(s)'],
  ])('Accounting, matched on category: %s from a vendor is not raised (external_sender)', async (_label, email, subject) => {
    const rec = pair({ email, subject, earlier: subject, cat: ACCOUNTING });
    const out = await run(rec);
    expect(out).toMatchObject({ bump: null, related: null });
    expect(rec).toMatchObject({ assessedPriority: 'Medium', assessedPriorityId: 2 });
    expect(rec.repeatReport).toMatchObject({
      relatedRef: 'TP-1042', matchedOn: 'category', raised: false, raisedTo: null, keptAt: null, notRaisedReason: 'external_sender',
      notAPerson: { reason: 'external_sender', why: 'outside_internal_domains', email },
      sentence: `Not raised: ${email} is outside the workspace's internal domains; only a person on staff reporting again raises the priority.`,
    });
    // Not a person: no earlier raise is looked up or held.
    expect(prismaMock.assignmentPipelineRun.findMany).not.toHaveBeenCalled();
  });

  test('IT, matched on subcategory: an Azure Monitor "Fired:" alert for another VM is not raised (machine_sender)', async () => {
    // azure-noreply@ — the start-only service-mailbox pattern missed it, so both tickets counted as a person's.
    const email = 'azure-noreply@monitor.example.com';
    const rec = pair({
      email,
      subject: 'Fired:Sev3 Azure Monitor Alert vm availability - vm-app-01 (Microsoft.Compute/virtualMachines)',
      earlier: 'Fired:Sev3 Azure Monitor Alert vm availability - vm-app-02 (Microsoft.Compute/virtualMachines)',
      cat: IT_CLOUD, sub: IT_VMS,
    });
    rec.assessedPriority = 'Medium';
    const out = await run(rec);
    expect(out).toMatchObject({ bump: null, related: null });
    expect(rec.assessedPriority).toBe('Medium');
    expect(rec.repeatReport).toMatchObject({
      matchedOn: 'subcategory', raised: false, notRaisedReason: 'machine_sender',
      notAPerson: { reason: 'machine_sender', why: 'service_mailbox', email },
      sentence: `Not raised: ${email} is a machine sender, not a person reporting again.`,
    });
    // Outside evaluate the alert is no repeat at all (machine tickets on both sides).
    expect(await service.findSameDayRelatedOpenTicket({ id: 2001, internalCategoryId: IT_CLOUD, internalSubcategoryId: IT_VMS }, { now: NOW })).toBeNull();
  });

  test('a monitoring alert from an address with no machine word: the alert pair rule\'s sender, or the "Fired:" subject', async () => {
    const email = 'azuremon@corp.example.com';
    const subject = 'Fired:Sev3 Azure Monitor Alert vm availability - vm-app-01 (x)';
    const earlier = 'Fired:Sev3 Azure Monitor Alert vm availability - vm-app-02 (x)';
    const viaSubject = pair({ email, subject, earlier, cat: IT_CLOUD, sub: IT_VMS });
    expect((await run(viaSubject)).bump).toBeNull();
    expect(viaSubject.repeatReport).toMatchObject({ notRaisedReason: 'machine_sender', notAPerson: { why: 'monitoring_alert' } });
    expect(isMonitoringSender).toHaveBeenCalledWith(WS, email);

    isMonitoringSender.mockResolvedValue(true);
    const viaRule = pair({ email, subject: 'VM availability dropped on vm-app-01', earlier: 'VM availability dropped on vm-app-02', cat: IT_CLOUD, sub: IT_VMS });
    expect((await run(viaRule)).bump).toBeNull();
    expect(viaRule.repeatReport).toMatchObject({ notRaisedReason: 'machine_sender', notAPerson: { why: 'monitoring_alert' } });
  });

  test('IT, matched on subcategory: an HR system\'s "On Leave Notification" is not raised', async () => {
    const subject = 'On Leave Notification: Sam Okafor will be going On Leave';
    const earlier = 'On Leave Notification: Riley Chen will be going On Leave';
    const external = pair({ email: 'leave-notices@peoplehub.example.com', subject, earlier, cat: IT_CLOUD, sub: IT_ACCOUNTS });
    expect((await run(external)).bump).toBeNull();
    expect(external.repeatReport).toMatchObject({ matchedOn: 'subcategory', notRaisedReason: 'external_sender' });
    // The same notice from an unattended mailbox on the company's own domain.
    const unattended = pair({ email: 'hr-system@corp.example.com', unattended: true, subject, earlier, cat: IT_CLOUD, sub: IT_ACCOUNTS });
    expect((await run(unattended)).bump).toBeNull();
    expect(unattended.repeatReport).toMatchObject({ notRaisedReason: 'machine_sender', notAPerson: { why: 'unattended' } });
    // ... or one on the workspace's machine-sender list.
    settingsStore.set('machine_senders_ws1', JSON.stringify({ entries: ['hr-robot@corp.example.com'] }));
    invalidateMachineSenderCache(WS);
    const listed = pair({ email: 'hr-robot@corp.example.com', subject, earlier, cat: IT_CLOUD, sub: IT_ACCOUNTS });
    expect((await run(listed)).bump).toBeNull();
    expect(listed.repeatReport).toMatchObject({ notRaisedReason: 'machine_sender', notAPerson: { why: 'machine_sender_list' } });
  });

  test('the right one still raises: a person on staff writes again about the locked file', async () => {
    const rec = pair({
      email: 'dana.fox@corp.example.com',
      subject: 'ProjectsDrive files locked',
      earlier: 'Access to view ProjectsDrive to find and close a locked file',
      cat: STORAGE, sub: FILE_SHARES,
    });
    const out = await run(rec);
    expect(out.bump).toEqual({ from: 'Medium', to: 'High' });
    expect(out.related).toMatchObject({ ticketId: 2000, ref: 'TP-1042', matchedOn: 'subcategory' });
    expect(rec).toMatchObject({ assessedPriority: 'High', assessedPriorityId: 3 });
    expect(rec.repeatReport).toMatchObject({ raised: true, raisedTo: 'High', notRaisedReason: null, sentence: 'Raised to High: same problem reported again today (TP-1042).' });
    expect(rec.repeatReport.notAPerson).toBeUndefined();
    // Same requester only: the earlier ticket is looked up by this ticket's requester.
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where).toMatchObject({ requesterId: 77 });
  });

  test('a workspace with no internal domains skips the domain test (machine checks still apply)', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver', internalDomains: [] });
    const subject = 'Reminder: Invoice 4410023 is overdue';
    const vendor = pair({ email: 'ar@billing-vendor.example.com', subject, earlier: subject, cat: ACCOUNTING });
    expect((await run(vendor)).bump).toEqual({ from: 'Medium', to: 'High' });
    const robot = pair({ email: 'billing.noreply@billing-vendor.example.com', subject, earlier: subject, cat: ACCOUNTING });
    expect((await run(robot)).bump).toBeNull();
    expect(robot.repeatReport.notRaisedReason).toBe('machine_sender');
  });
});

describe('once per ticket: the raise never stacks across re-runs (review MUST 1)', () => {
  const raisedRun = { recommendation: { repeatReport: { raised: true, aiPriority: 'Medium', raisedTo: 'High', relatedRef: 'TP-1042' } } };

  test('after hours raised Medium to High; the business-hours run reads High back: it stays High', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([raisedRun]);
    const rec = { ...REC(), assessedPriority: 'High', assessedPriorityId: 3 }; // the AI anchored on the saved High
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, runId: 10, recommendation: rec, now: NOW });
    expect(out.bump).toBeNull();
    expect(rec).toMatchObject({ assessedPriority: 'High', assessedPriorityId: 3 });
    expect(rec.repeatReport).toMatchObject({
      raised: false, notRaisedReason: 'already_raised', keptAt: null,
      sentence: 'Kept at High: already raised once for this repeat report (TP-1042).',
    });
    expect(isBusinessHours).not.toHaveBeenCalled();
    const where = prismaMock.assignmentPipelineRun.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ ticketId: 2001, id: { not: 10 }, recommendation: { path: ['repeatReport', 'raised'], equals: true } });
  });

  test('a hand-back re-run where the AI now says Medium keeps the earlier raise (High), never lower, never higher', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([raisedRun]);
    const rec = REC();
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, runId: 11, recommendation: rec, now: NOW });
    expect(out).toMatchObject({ bump: null, keptAt: 'High' });
    expect(rec).toMatchObject({ assessedPriority: 'High', assessedPriorityId: 3 });
    expect(rec.repeatReport).toMatchObject({ notRaisedReason: 'already_raised', keptAt: 'High', aiPriority: 'Medium' });
  });

  test('a repeat_report history row counts as the earlier raise too; the AI\'s own higher answer stands', async () => {
    priorityRows = [{ details: { source: 'repeat_report', from: 'Medium', to: 'High', relatedRef: 'TP-1042' } }];
    const urgent = { ...REC(), assessedPriority: 'Urgent', assessedPriorityId: 4 };
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, recommendation: urgent, now: NOW });
    expect(out.keptAt).toBeNull();
    expect(urgent.assessedPriority).toBe('Urgent');
    expect(urgent.repeatReport.notRaisedReason).toBe('already_raised');
  });

  test('a person\'s change after the raise wins: raised to High, agent set Medium, the re-run leaves Medium', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([{ ...raisedRun, createdAt: pst('09:50') }]);
    priorityRows = [
      { performedAt: pst('10:05'), details: { source: 'agent', actorKind: 'human', actorName: 'Eli Park', from: 'High', to: 'Medium' } },
      { performedAt: pst('09:51'), details: { source: 'repeat_report', from: 'Medium', to: 'High', relatedRef: 'TP-1042' } },
    ];
    const rec = REC(); // the AI answers Medium
    const out = await service.evaluate({ workspaceId: WS, ticketId: 2001, runId: 12, recommendation: rec, now: NOW });
    expect(out).toMatchObject({ bump: null, keptAt: null });
    expect(rec).toMatchObject({ assessedPriority: 'Medium', assessedPriorityId: 2 });
    expect(rec.repeatReport).toMatchObject({
      raised: false, keptAt: null, notRaisedReason: 'person_changed',
      sentence: 'Not raised again: Eli Park set the priority to Medium after the repeat raise.',
    });
    expect(await service.priorRaise(2001)).toMatchObject({ overridden: true, overriddenTo: 'Medium', raisedTo: null });
    // The AI is not told about a raise a person has already replaced.
    expect(await service.priorityContextForAi(2001)).toBeNull();
  });

  test('the requester\'s status link counts as a person; a change BEFORE the raise does not', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([{ ...raisedRun, createdAt: pst('09:50') }]);
    priorityRows = [{ performedAt: pst('10:00'), details: { source: 'requester_link', actorKind: 'human', to: 'Urgent' } }];
    expect(await service.priorRaise(2001)).toMatchObject({ overridden: true, overriddenTo: 'Urgent' });
    priorityRows = [{ performedAt: pst('09:30'), details: { source: 'agent', actorKind: 'human', to: 'Low' } }];
    expect(await service.priorRaise(2001)).toMatchObject({ overridden: false, raisedTo: 'High' });
    // A workflow or the AI changing it later is not a person: the raise is held.
    priorityRows = [{ performedAt: pst('10:00'), details: { source: 'ai_assessment', actorKind: 'ai', to: 'Medium' } }];
    expect(await service.priorRaise(2001)).toMatchObject({ overridden: false, raisedTo: 'High' });
  });

  test('priorRaise: the highest earlier raise, with the AI\'s level before it', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([raisedRun]);
    priorityRows = [{ details: { source: 'ai_assessment', from: 'Low', to: 'Urgent' } }, { details: { source: 'repeat_report', from: 'Medium', to: 'High' } }];
    expect(await service.priorRaise(2001)).toEqual({ raisedTo: 'High', overridden: false, aiPriority: 'Medium', relatedRef: 'TP-1042' });
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
    priorityRows = [];
    expect(await service.priorRaise(2001)).toBeNull();
  });

  test('priorityContextForAi: the AI is told its own level and why the ticket sits higher', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([raisedRun]);
    const ctx = await service.priorityContextForAi(2001);
    expect(ctx).toMatchObject({ aiLevelBeforeRaise: 'Medium', raisedTo: 'High', relatedRef: 'TP-1042' });
    expect(ctx.note).toMatch(/raised this ticket's priority from Medium to High.*Judge the priority of this request on its own/);
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
    expect(await service.priorityContextForAi(2001)).toBeNull();
  });
});

describe('route: follow-up routing (item 4)', () => {
  const related = () => ({ ticketId: 2000, ref: 'TP-1042', subject: "can't sign into Teams", matchedOn: 'subcategory', owner: { techId: ELI, techName: 'Eli Park' } });
  const go = (over = {}) => service.route({
    workspaceId: WS, ticketId: 2001, runId: 9, decision: 'auto_assigned', related: related(), pickId: DANA, pickName: 'Dana Fox', now: NOW, ...over,
  });

  test('off by default: nothing at all', async () => {
    expect(await go()).toBeNull();
    expect(settingsRepositoryMock.get).toHaveBeenCalledWith('followup_routing_ws1');
  });

  test('Shadow: records "Would send to Eli Park", keeps Dana', async () => {
    settingsStore.set(settingsKey(WS), 'shadow');
    const out = await go();
    expect(out).toMatchObject({ techId: DANA, applied: false, sentence: null });
    expect(out.record).toMatchObject({
      mode: 'shadow', outcome: 'would_route', applied: false, notAppliedReason: 'shadow', relatedTicketId: 2000, relatedRef: 'TP-1042',
      matchedOn: 'subcategory', from: { techId: DANA, techName: 'Dana Fox' }, to: { techId: ELI, techName: 'Eli Park' },
      sentence: 'Would send to Eli Park: same problem as TP-1042 reported today.',
    });
    expect(out.step).toMatchObject({ stepName: 'followup_routing', output: { kind: 'followup_routing', outcome: 'would_route' } });
  });

  test('Live: Eli gets it when at work and not away', async () => {
    settingsStore.set(settingsKey(WS), JSON.stringify({ mode: 'live' }));
    const out = await go();
    expect(out).toMatchObject({ techId: ELI, applied: true, sentence: 'Sent to Eli Park: same problem as TP-1042 reported today.' });
    expect(out.record).toMatchObject({ mode: 'live', outcome: 'routed', notAppliedReason: null });
  });

  test('Live never acts when locked, suggest-only or dry-run', async () => {
    settingsStore.set(settingsKey(WS), 'live');
    expect((await go({ locked: true })).record).toMatchObject({ applied: false, notAppliedReason: 'locked', outcome: 'would_route' });
    expect((await go({ decision: 'pending_review' })).record).toMatchObject({ applied: false, notAppliedReason: 'suggest_only' });
    expect((await go({ dryRun: true })).record).toMatchObject({ mode: 'shadow', applied: false, notAppliedReason: 'dry_run' });
  });

  test('the owner away, on leave, off shift, or who handed it back: not sent, said why', async () => {
    settingsStore.set(settingsKey(WS), 'live');
    awayMock.forTechnician.mockResolvedValueOnce({ backOn: '2026-11-30' });
    expect((await go()).record).toMatchObject({ outcome: 'owner_unavailable', unavailableReason: 'away', applied: false });
    prismaMock.technicianLeave.findMany.mockResolvedValueOnce([{ category: 'OFF' }]);
    expect((await go()).record.unavailableReason).toBe('away today');
    prismaMock.technician.findFirst.mockResolvedValueOnce({ id: ELI, isActive: true, timezone: 'America/Vancouver', workStartTime: '12:00', workEndTime: '20:00' });
    expect((await go()).record.unavailableReason).toBe('not at work now');
    prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValueOnce({ id: 1 });
    expect((await go()).record.unavailableReason).toBe('handed this ticket back');
    const out = await go();
    expect(out.applied).toBe(true);
  });

  test('a site visit is not "away today"; a physio appointment still is (25 Nov 2026)', async () => {
    settingsStore.set(settingsKey(WS), 'live');
    prismaMock.technicianLeave.findMany.mockResolvedValueOnce([{ category: 'OTHER', leaveTypeName: 'Site visit' }]);
    const out = await go();
    expect(out.applied).toBe(true);
    expect(out.record.unavailableReason ?? null).toBeNull();
    prismaMock.technicianLeave.findMany.mockResolvedValueOnce([{ category: 'OTHER', leaveTypeName: 'Physio' }]);
    expect((await go()).record.unavailableReason).toBe('away today');
  });

  test('a local person cannot take a FreshService-born ticket', async () => {
    settingsStore.set(settingsKey(WS), 'live');
    prismaMock.technician.findFirst.mockResolvedValueOnce({ id: ELI, isActive: true, timezone: 'America/Vancouver', freshserviceId: null });
    expect((await go({ ticketOrigin: 'freshservice' })).record.unavailableReason).toBe('cannot hold FreshService tickets');
  });

  test('the AI already picked the owner, or the first ticket has nobody: recorded, no step', async () => {
    settingsStore.set(settingsKey(WS), 'shadow');
    const same = await go({ pickId: ELI });
    expect(same.record.outcome).toBe('already_there');
    expect(same.step).toBeNull();
    const nobody = await go({ related: { ...related(), owner: null } });
    expect(nobody.record.outcome).toBe('no_owner');
  });

  test('saveSettings validates and keeps a history line', async () => {
    expect((await service.saveSettings(WS, { mode: 'maybe' }, { by: 'Dana Fox' })).errors.length).toBe(1);
    const ok = await service.saveSettings(WS, { mode: 'shadow' }, { by: 'Dana Fox' });
    expect(ok.settings.mode).toBe('shadow');
    expect(JSON.parse(settingsStore.get('followup_routing_ws1'))).toMatchObject({ mode: 'shadow', updatedBy: 'Dana Fox' });
  });
});

describe('addMergeNote', () => {
  test('a private system note on the new ticket suggesting the merge', async () => {
    const ok = await service.addMergeNote({ ticketId: 2001, workspaceId: WS, related: { ref: 'TP-1042', subject: "can't sign into Teams", owner: { techName: 'Eli Park' } } });
    expect(ok).toBe(true);
    const [ticketId, ws, body, actor, files, opts] = addPrivateNote.mock.calls[0];
    expect([ticketId, ws, files, opts]).toEqual([2001, WS, [], { systemNote: true }]);
    expect(actor).toMatchObject({ name: 'Ticket Pulse' });
    expect(body.bodyText).toMatch(/TP-1042 \("can't sign into Teams"\) is still open with Eli Park.*Consider merging this ticket into TP-1042\./);
  });
});