import { jest } from '@jest/globals';

/**
 * 24 Nov 2026 — "Everyone on the original e-mail" (recipient token
 * `original_ccs`). A requester wrote to four colleagues and the IT mailbox,
 * everyone on To, and the "Ticket arrived" acknowledgement reached the
 * requester only: the token read the Cc lists and never the To line.
 * Invented names, example.com (our domain) and example.net (outside) only.
 */

const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflow: { findUnique: jest.fn(), findFirst: jest.fn() },
  notificationWorkflowVersion: { findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  customFieldDefinition: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { create: jest.fn(), findMany: jest.fn() },
  mirrorJob: { findFirst: jest.fn(), create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn(), findFirst: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  mailboxConnection: { findMany: jest.fn() },
  requester: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  workspaceAccess: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
};

const settings = new Map();
const settingsMock = { get: jest.fn(async (key) => settings.get(key) ?? null), set: jest.fn(), delete: jest.fn() };
const alsoForMock = {
  additionalRequesterCc: jest.fn().mockResolvedValue([]),
  isAlsoForNotifyEnabled: jest.fn().mockResolvedValue(false),
};
const directoryMock = { resolveAddress: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/alsoForNotifyService.js', () => ({ default: alsoForMock, ...alsoForMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: directoryMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn().mockResolvedValue({ success: true, status: 'sent' }),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: { create: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueFieldSync: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { executeDefinition, executePreview } = await import('../src/services/notificationWorkflowEngine.js');
const svc = await import('../src/services/originalRecipientsService.js');
const { invalidateMachineSenderCache } = await import('../src/services/machineSenderService.js');

const REQUESTER = 'dana.fox@example.com';
const COLLEAGUES = ['priya.nair@example.com', 'sam.okafor@example.com', 'lee.chen@example.com', 'ada.ruiz@example.com'];

const eventContext = (ticket = {}, over = {}) => ({
  event: { type: 'ticket.created', source: 'test', occurredAt: '2026-11-24T10:00:00.000Z', dedupeStamp: `t-${Math.random()}` },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, subject: 'Shared drive access', status: 'Open', priorityLabel: 'Low', isNoise: false, toEmails: [], ccEmails: [], replyCcEmails: [], ...ticket },
  requester: { name: 'Dana Fox', email: REQUESTER },
  assignedAgent: { name: 'Eli Park', email: 'eli.park@example.com' },
  previousAgent: null,
  ...over,
});

function definition(recipientData) {
  return {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
      { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'], cc: ['original_ccs'], bcc: [], ...recipientData } },
      { id: 'template', type: 'template_render', data: { contentSource: 'template_only', subject: 'We have your request', html: '<p>Thanks</p>', text: 'Thanks' } },
      { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'recipients' },
      { id: 'e2', source: 'recipients', target: 'template' },
      { id: 'e3', source: 'template', target: 'send' },
    ],
  };
}

const workflow = { id: 77, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };

async function run(context, recipientData = {}, mode = 'live') {
  await executeDefinition({ workflow, definition: definition(recipientData), eventContext: context, executionMode: mode });
  const created = prismaMock.notificationDelivery.create.mock.calls[0]?.[0]?.data;
  return created ? { to: created.toRecipients, cc: created.ccRecipients, bcc: created.bccRecipients } : null;
}
const resolve = (ticket, recipientData = {}, mode = 'live') => run(eventContext(ticket), recipientData, mode);

// A requester the directory described: a person.
const personRow = (email, over = {}) => ({
  email, unattended: false, isActive: true, suppressedAt: null, entraMissingAt: null,
  entraJobTitle: 'Analyst', entraDepartment: null, jobTitle: null, department: null, ...over,
});
const enabled = (over = {}) => ({ status: 'found', accountEnabled: true, ...over });

let replies = [];
let ccChanges = [];
let people = new Set();
let originalEntry = null;

beforeEach(() => {
  jest.clearAllMocks();
  svc.invalidateOwnMailboxCache();
  invalidateMachineSenderCache();
  settings.clear();
  settingsMock.get.mockImplementation(async (key) => settings.get(key) ?? null);
  replies = [];
  ccChanges = [];
  originalEntry = null;
  // Colleagues on our own domain are people (active requesters).
  people = new Set(COLLEAGUES);
  let stepId = 100;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: stepId += 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({ enabled: false });
  prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 100, workspaceId: 1 });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticketActivity.create.mockResolvedValue({});
  prismaMock.ticketActivity.findMany.mockImplementation(async () => ccChanges);
  prismaMock.mirrorJob.findFirst.mockResolvedValue({ id: 1 });
  prismaMock.ticketThreadEntry.findMany.mockImplementation(async ({ where } = {}) => (where?.eventType === 'reply' ? replies : []));
  prismaMock.ticketThreadEntry.findFirst.mockImplementation(async () => originalEntry);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 700, ...data }));
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
  // Our mailboxes: IT's (with a public alias) and another workspace's.
  prismaMock.mailboxConnection.findMany.mockResolvedValue([
    { id: 1, address: 'it-tickets@example.com' },
    { id: 2, address: 'accounts@example.com' },
  ]);
  settings.set('mailbox_aliases_1', 'it@example.com');
  prismaMock.requester.findMany.mockImplementation(async ({ where }) => where.email.in
    .filter((a) => people.has(a))
    .map((email) => personRow(email)));
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['example.com'] });
  directoryMock.resolveAddress.mockResolvedValue({ status: 'absent' });
  alsoForMock.additionalRequesterCc.mockResolvedValue([]);
});

describe('bareAddress', () => {
  test('keeps apostrophes and the usual local-part characters', () => {
    expect(svc.bareAddress("o'brien@example.com")).toBe("o'brien@example.com");
    expect(svc.bareAddress("D'Souza.R@Example.com")).toBe("d'souza.r@example.com");
    expect(svc.bareAddress('first+tag_x-y@example.net')).toBe('first+tag_x-y@example.net');
  });

  test('takes the address inside <…>, trims whitespace, lowercases', () => {
    expect(svc.bareAddress('Pat O\'Brien <Pat.OBrien@Example.com>')).toBe('pat.obrien@example.com');
    expect(svc.bareAddress('"Nair, Priya" <priya.nair@example.com>')).toBe('priya.nair@example.com');
    expect(svc.bareAddress("   o'brien@example.com \n")).toBe("o'brien@example.com");
  });

  test('anything that is not one address is nothing', () => {
    for (const bad of ['', 'not-an-address', '@example.com', 'a@', 'a b@example.com', 'a@example', 'a@b.com, c@d.com', '.a@example.com']) {
      expect(svc.bareAddress(bad)).toBe('');
    }
  });

  test('an apostrophe address reaches the e-mail whole', async () => {
    people.add("o'brien@example.com");
    const delivery = await resolve({ toEmails: ['it@example.com', "O'Brien@example.com"] });
    expect(delivery.cc).toEqual(["o'brien@example.com"]);
  });
});

describe('the To line counts', () => {
  test('the reported case: four colleagues and the IT mailbox on To, nobody on Cc', async () => {
    const delivery = await resolve({ toEmails: ['IT@example.com', ...COLLEAGUES] });
    expect(delivery.to).toEqual([REQUESTER]);
    expect(delivery.cc).toEqual(COLLEAGUES);
  });

  test('"Ticket arrived" on a mail-in ticket reads the arriving e-mail in memory (the row is still empty)', async () => {
    const context = eventContext({}, {
      originalEmailRecipients: { toEmails: ['it@example.com', 'priya.nair@example.com'], ccEmails: ['manager@example.net'], viaMailbox: true },
    });
    const delivery = await run(context);
    expect(delivery.cc).toEqual(['manager@example.net', 'priya.nair@example.com']);
  });

  test('Cc and reply Cc still count, To joins them', async () => {
    const delivery = await resolve({ ccEmails: ['manager@example.net'], replyCcEmails: ['lead@example.net'], toEmails: ['it@example.com', 'priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['manager@example.net', 'lead@example.net', 'priya.nair@example.com']);
  });
});

describe('other workflows are untouched (the mail\'s To/Cc never reach the ticket early)', () => {
  const mailIn = (over = {}) => eventContext({ ccEmails: [], toEmails: [] }, {
    originalEmailRecipients: { toEmails: ['it@example.com'], ccEmails: ['manager@example.net'], viaMailbox: true },
    ...over,
  });

  test('the requester token\'s unattended fallback reads the ticket\'s Cc, as before (empty at creation)', async () => {
    const delivery = await run(mailIn({ requester: { name: 'Scanner', email: 'scanner@example.net', unattended: true } }), { cc: [] });
    expect(delivery).toBeNull(); // nobody on To, as before: the mail's Cc is not on the ticket yet
    expect(prismaMock.mailboxConnection.findMany).not.toHaveBeenCalled();
  });

  test('"Also notify additional requesters" sees the ticket as before', async () => {
    await run(mailIn(), { cc: [] });
    expect(alsoForMock.additionalRequesterCc).toHaveBeenCalledTimes(1);
    expect(alsoForMock.additionalRequesterCc.mock.calls[0][1].ccEmails).toEqual([]);
    expect(prismaMock.notificationDelivery.create.mock.calls[0][0].data.ccRecipients).toEqual([]);
  });
});

describe('who is left out', () => {
  test('our own mailboxes in any workspace, their aliases, +tag variants and the FreshService relay', async () => {
    const delivery = await resolve({
      toEmails: ['it-tickets@example.com', 'it@example.com', 'accounts@example.com', 'it-tickets+tp42@example.com', 'help@acme.freshservice.com', 'priya.nair@example.com'],
      ccEmails: ['Accounts@Example.com'],
    });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('the global sender from Settings', async () => {
    settings.set('sendgrid_from_email', 'ticketpulse@example.net');
    const delivery = await resolve({ toEmails: ['it@example.com', 'ticketpulse@example.net', 'priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('the requester, in any case', async () => {
    const delivery = await resolve({ toEmails: ['it@example.com', 'Dana.Fox@Example.com', 'priya.nair@example.com'], ccEmails: [REQUESTER] });
    expect(delivery.to).toEqual([REQUESTER]);
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('active agents of the ticket\'s workspace (they see the ticket in the app)', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'Eli.Park@example.com' }]);
    const delivery = await resolve({ toEmails: ['it@example.com', 'eli.park@example.com', 'priya.nair@example.com'], ccEmails: ['ELI.PARK@example.com'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
    expect(prismaMock.technician.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: 1, isActive: true });
  });

  test('no-reply and the workspace machine senders', async () => {
    settings.set('machine_senders_ws1', JSON.stringify({ entries: [{ value: 'alerts.example.net' }] }));
    const delivery = await resolve({
      toEmails: ['it@example.com', 'no-reply@example.net', 'noreply.billing@example.net', 'mailer-daemon@example.net', 'watch@alerts.example.net', 'priya.nair@example.com'],
    });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('unattended requesters (an automation mailbox on the To line)', async () => {
    prismaMock.requester.findMany.mockResolvedValue([
      personRow('scanner@example.net', { unattended: true }),
      personRow('priya.nair@example.com'),
    ]);
    const delivery = await resolve({ toEmails: ['it@example.com', 'scanner@example.net', 'priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('repeats across To, Cc and reply Cc, compared case-insensitively', async () => {
    const delivery = await resolve({
      ccEmails: ['Priya.Nair@example.com'],
      replyCcEmails: ['priya.nair@EXAMPLE.com', 'sam.okafor@example.com'],
      toEmails: ['it@example.com', 'PRIYA.NAIR@example.com', 'Sam Okafor <Sam.Okafor@example.com>'],
    });
    expect(delivery.cc).toEqual(['priya.nair@example.com', 'sam.okafor@example.com']);
  });
});

describe('our mailbox list must be read in full', () => {
  test('mailbox list unreadable: nobody from the original e-mail (not even the Cc)', async () => {
    prismaMock.mailboxConnection.findMany.mockRejectedValue(new Error('db down'));
    const delivery = await resolve({ ccEmails: ['manager@example.net'], toEmails: ['it@example.com', 'priya.nair@example.com'] });
    expect(delivery).toEqual({ to: [REQUESTER], cc: [], bcc: [] });
  });

  test('an alias read failure reaches nobody, and the partial list is not cached', async () => {
    let failAliases = true;
    settingsMock.get.mockImplementation(async (key) => {
      if (key === 'mailbox_aliases_1' && failAliases) throw new Error('settings down');
      return settings.get(key) ?? null;
    });
    const first = await resolve({ toEmails: ['it@example.com', 'priya.nair@example.com'] });
    expect(first.cc).toEqual([]);
    failAliases = false;
    jest.clearAllMocks();
    prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 701, ...data }));
    // No list had loaded yet, so the failure is not remembered (24 Nov 2026):
    // the next run reads again (nothing partial was cached) and it@ is known as ours.
    const realNow = Date.now;
    try {
      prismaMock.notificationDelivery.create.mockClear();
      const second = await resolve({ toEmails: ['it@example.com', 'priya.nair@example.com'] });
      expect(second.cc).toEqual(['priya.nair@example.com']);
      expect(prismaMock.mailboxConnection.findMany).toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('lists, loops and long To lines', () => {
  test('a mail that did not come straight to our mailbox (a list or unknown alias): To line left out, Cc kept', async () => {
    const delivery = await resolve({ toEmails: ['all-staff@example.com', 'priya.nair@example.com'], ccEmails: ['manager@example.net'] });
    expect(delivery.cc).toEqual(['manager@example.net']);
  });

  test('the same for the arriving e-mail in memory (viaMailbox false)', async () => {
    const context = eventContext({}, { originalEmailRecipients: { toEmails: ['priya.nair@example.com'], ccEmails: ['manager@example.net'], viaMailbox: false } });
    expect((await run(context)).cc).toEqual(['manager@example.net']);
  });

  test('the original e-mail entry decides how the mail arrived (the mailbox was on its Cc)', async () => {
    originalEntry = { rawPayload: { to_emails: ['priya.nair@example.com'], cc_emails: ['it@example.com'] } };
    const delivery = await resolve({ toEmails: ['priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('an agent\'s forward: To line left out, Cc kept', async () => {
    originalEntry = { rawPayload: { to_emails: ['it@example.com'], forwarded: { by: 'eli.park@example.com' } } };
    const delivery = await resolve({ toEmails: ['it@example.com', 'priya.nair@example.com'], ccEmails: ['manager@example.net'] });
    expect(delivery.cc).toEqual(['manager@example.net']);
  });

  test('more than 10 people on To: To line left out, Cc kept', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `person${i}@example.net`);
    const delivery = await resolve({ toEmails: ['it@example.com', ...many], ccEmails: ['manager@example.net'] });
    expect(delivery.cc).toEqual(['manager@example.net']);
  });

  test('exactly 10 people on To are all reached', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `person${i}@example.net`);
    const delivery = await resolve({ toEmails: ['it@example.com', ...ten] });
    expect(delivery.cc).toEqual(ten);
  });
});

describe('addresses on our own domains must be a person', () => {
  test('active requester or member: kept; external addresses kept with no lookup', async () => {
    people = new Set(['priya.nair@example.com']);
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'coord@example.com' }]);
    const delivery = await resolve({ toEmails: ['it@example.com', 'priya.nair@example.com', 'coord@example.com', 'partner@example.net'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com', 'coord@example.com', 'partner@example.net']);
    expect(directoryMock.resolveAddress).not.toHaveBeenCalled();
  });

  test('a suppressed or inactive requester is not a person (and the directory does not know them)', async () => {
    people = new Set();
    prismaMock.requester.findMany.mockResolvedValue([
      personRow('old.hand@example.com', { isActive: false }),
      personRow('qa.box@example.com', { suppressedAt: new Date() }),
    ]);
    const delivery = await resolve({ toEmails: ['it@example.com', 'old.hand@example.com', 'qa.box@example.com'] });
    expect(delivery.cc).toEqual([]);
  });

  test('a requester row counts only when the directory described it (title or department, not marked missing)', () => {
    expect(svc.requesterIsPerson(personRow('a@example.com'))).toBe(true);
    expect(svc.requesterIsPerson(personRow('a@example.com', { entraJobTitle: null, department: 'Finance' }))).toBe(true);
    expect(svc.requesterIsPerson(personRow('a@example.com', { entraJobTitle: null }))).toBe(false); // a list that once wrote in
    expect(svc.requesterIsPerson(personRow('a@example.com', { entraMissingAt: new Date() }))).toBe(false);
    expect(svc.requesterIsPerson(personRow('a@example.com', { unattended: true }))).toBe(false);
  });

  test('a requester row with no title goes to the directory: a shared mailbox there is left out', async () => {
    people = new Set();
    prismaMock.requester.findMany.mockResolvedValue([
      personRow('projects@example.com', { entraJobTitle: null }),
      personRow('lee.chen@example.com', { entraJobTitle: null, entraMissingAt: new Date() }),
    ]);
    directoryMock.resolveAddress.mockImplementation(async (address) => ({
      'projects@example.com': enabled({ accountEnabled: false, department: 'Projects' }), // a shared mailbox: disabled sign-in
      'lee.chen@example.com': enabled({ jobTitle: 'Geologist' }),
    })[address]);
    const delivery = await resolve({ toEmails: ['it@example.com', 'projects@example.com', 'lee.chen@example.com'] });
    expect(delivery.cc).toEqual(['lee.chen@example.com']);
    expect(directoryMock.resolveAddress).toHaveBeenCalledTimes(2);
  });

  test('the directory decides the rest: an enabled person with a title is kept; a list, a shared mailbox, a stranger or no answer is left out', async () => {
    people = new Set();
    directoryMock.resolveAddress.mockImplementation(async (address) => ({
      'lee.chen@example.com': enabled({ jobTitle: 'Geologist', department: null }),
      'ada.ruiz@example.com': enabled({ status: 'alias', jobTitle: null, department: 'Finance' }),
      'all-hands@example.com': enabled({ jobTitle: null, department: null }),
      'front.desk@example.com': enabled({ accountEnabled: false, jobTitle: 'Reception' }),
      'noflag@example.com': { status: 'found', jobTitle: 'Engineer' }, // accountEnabled missing: not proven a person
      'projects@example.com': { status: 'absent' },
      'sam.okafor@example.com': { status: 'unavailable' },
    })[address]);
    const delivery = await resolve({
      toEmails: ['it@example.com', 'lee.chen@example.com', 'ada.ruiz@example.com', 'all-hands@example.com', 'front.desk@example.com', 'noflag@example.com', 'projects@example.com', 'sam.okafor@example.com'],
    });
    expect(delivery.cc).toEqual(['lee.chen@example.com', 'ada.ruiz@example.com']);
  });

  test('the directory is asked with a 3-second limit per call', async () => {
    people = new Set();
    directoryMock.resolveAddress.mockResolvedValue(enabled({ jobTitle: 'Engineer' }));
    await resolve({ toEmails: ['it@example.com', 'lee.chen@example.com'] });
    expect(directoryMock.resolveAddress).toHaveBeenCalledWith('lee.chen@example.com', { timeoutMs: 3000 });
  });

  test('"unavailable" is remembered for ten minutes: no second call', async () => {
    people = new Set();
    directoryMock.resolveAddress.mockResolvedValue({ status: 'unavailable' });
    await resolve({ toEmails: ['it@example.com', 'lee.chen@example.com'] });
    jest.clearAllMocks();
    prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 703, ...data }));
    const again = await resolve({ toEmails: ['it@example.com', 'lee.chen@example.com'] });
    expect(directoryMock.resolveAddress).not.toHaveBeenCalled();
    expect(again.cc).toEqual([]);
  });

  test('the run\'s directory budget: when it runs out, unchecked addresses on our domains are left out', async () => {
    people = new Set();
    const lookup = jest.fn((address) => (address === 'slow@example.com'
      ? new Promise(() => {}) // never answers
      : Promise.resolve(enabled({ jobTitle: 'Engineer' }))));
    const started = Date.now();
    const result = await svc.resolveOriginalRecipients(
      eventContext({ toEmails: ['it@example.com', 'fast@example.com', 'slow@example.com', 'later@example.com'] }),
      { workspaceId: 1, resolveAddress: lookup, budgetMs: 50 },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.list).toEqual(['fast@example.com']);
    expect(result.leftOff.notAPerson).toBe(2);
    expect(lookup).not.toHaveBeenCalledWith('later@example.com');
  });

  test('directory answers are cached, and at most 10 lookups run per e-mail', async () => {
    people = new Set();
    directoryMock.resolveAddress.mockResolvedValue(enabled({ jobTitle: 'Engineer' }));
    const many = Array.from({ length: 12 }, (_, i) => `staff${i}@example.com`);
    await resolve({ ccEmails: many, toEmails: ['it@example.com'] });
    expect(directoryMock.resolveAddress).toHaveBeenCalledTimes(10);
    directoryMock.resolveAddress.mockClear();
    jest.clearAllMocks();
    prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 702, ...data }));
    const again = await resolve({ ccEmails: many.slice(0, 3), toEmails: ['it@example.com'] });
    expect(directoryMock.resolveAddress).not.toHaveBeenCalled();
    expect(again.cc).toEqual(many.slice(0, 3));
  });
});

describe('failed checks fail safe', () => {
  test('agent check fails: nobody from the original e-mail, and Preview says why', async () => {
    prismaMock.technician.findMany.mockRejectedValue(new Error('db down'));
    const delivery = await resolve({ toEmails: ['it@example.com', 'priya.nair@example.com'], ccEmails: ['manager@example.net'] });
    expect(delivery).toEqual({ to: [REQUESTER], cc: [], bcc: [] });
    const result = await executePreview({ workflow, definition: definition({}), eventContext: eventContext({ ccEmails: ['manager@example.net'] }) });
    expect(result.steps.find((s) => s.nodeId === 'recipients').output.originalRecipients).toMatchObject({ count: 0, unavailable: 'agents' });
  });

  test('"taken off the Cc" history fails (replies or "Also for" log): nobody from the original e-mail', async () => {
    prismaMock.ticketActivity.findMany.mockRejectedValue(new Error('db down'));
    expect((await resolve({ ccEmails: ['manager@example.net'] })).cc).toEqual([]);
    jest.clearAllMocks();
    prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 704, ...data }));
    prismaMock.ticketActivity.findMany.mockResolvedValue([]);
    prismaMock.ticketThreadEntry.findMany.mockRejectedValue(new Error('db down'));
    expect((await resolve({ ccEmails: ['manager@example.net'] })).cc).toEqual([]);
  });

  test('requester check fails: outside addresses are left out; people on our domains still go through the person check', async () => {
    prismaMock.requester.findMany.mockRejectedValue(new Error('db down'));
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'coord@example.com' }]);
    const result = await svc.resolveOriginalRecipients(
      eventContext({ toEmails: ['it@example.com', 'partner@example.net', 'coord@example.com'], ccEmails: ['manager@example.net'] }),
      { workspaceId: 1 },
    );
    expect(result.list).toEqual(['coord@example.com']);
    expect(result.leftOff.unchecked).toBe(2);
  });
});

describe('people an agent took off the Cc', () => {
  test('a reply that took someone off the Cc keeps them off later workflow mail', async () => {
    replies = [{ occurredAt: new Date('2026-11-24T11:00:00Z'), rawPayload: { to_emails: [REQUESTER], cc_emails: ['lead@example.net'], cc_removed: ['priya.nair@example.com'] } }];
    const delivery = await resolve({ ccEmails: ['priya.nair@example.com', 'lead@example.net'], toEmails: ['it@example.com', 'priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['lead@example.net']);
  });

  test('an "Also for" removal keeps them off even though they were on To', async () => {
    ccChanges = [{ performedAt: new Date('2026-11-24T11:00:00Z'), details: { from: ['priya.nair@example.com', 'lead@example.net'], to: ['lead@example.net'] } }];
    const delivery = await resolve({ ccEmails: ['lead@example.net'], toEmails: ['it@example.com', 'priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['lead@example.net']);
  });

  test('added back later by an agent, they are reached again', async () => {
    replies = [
      { occurredAt: new Date('2026-11-24T11:00:00Z'), rawPayload: { cc_removed: ['priya.nair@example.com'] } },
      { occurredAt: new Date('2026-11-24T12:00:00Z'), rawPayload: { cc_emails: ['priya.nair@example.com'] } },
    ];
    const delivery = await resolve({ toEmails: ['it@example.com', 'priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('history is read oldest first across replies and "Also for" edits', () => {
    const removed = svc.agentRemovedFromHistory(
      [{ occurredAt: '2026-11-24T13:00:00Z', rawPayload: { cc_removed: ['sam.okafor@example.com'] } }],
      [
        { performedAt: '2026-11-24T11:00:00Z', details: { from: ['lee.chen@example.com'], to: [] } },
        { performedAt: '2026-11-24T12:00:00Z', details: { from: [], to: ['lee.chen@example.com'] } },
      ],
    );
    expect([...removed]).toEqual(['sam.okafor@example.com']);
  });
});

describe('the 25-recipient cap', () => {
  const list = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.net`);

  test('a long Cc list is trimmed so the requester still gets the e-mail', async () => {
    const delivery = await resolve({ ccEmails: list(30, 'colleague') });
    expect(delivery.to).toEqual([REQUESTER]);
    expect(delivery.cc).toHaveLength(24);
    expect(delivery.cc[0]).toBe('colleague0@example.net');
  });

  test('typed addresses are never trimmed, even when also on the original e-mail', async () => {
    const delivery = await resolve({ ccEmails: list(30, 'colleague') }, { ccCustomEmails: ['audit@example.net', 'colleague29@example.net'] });
    expect(delivery.cc).toEqual(expect.arrayContaining(['audit@example.net', 'colleague29@example.net']));
    expect(delivery.to.length + delivery.cc.length + delivery.bcc.length).toBe(25);
  });

  test('trimOriginalToCap leaves out the last original people first, Cc before Bcc before To', () => {
    const out = svc.trimOriginalToCap({ to: ['r@example.net', 'o1@example.net'], cc: ['x@example.net', 'o2@example.net'], bcc: ['o3@example.net'] }, ['o1@example.net', 'o2@example.net', 'o3@example.net'], 3);
    expect(out).toEqual({ to: ['r@example.net', 'o1@example.net'], cc: ['x@example.net'], bcc: [], trimmed: 2 });
  });
});

describe('Preview and Shadow list the widened recipients', () => {
  const ticket = {
    toEmails: ['it@example.com', 'priya.nair@example.com', 'no-reply@example.net', REQUESTER],
    ccEmails: ['sam.okafor@example.com'],
  };

  test('Preview shows the widened list and why people were left out', async () => {
    const result = await executePreview({ workflow, definition: definition({}), eventContext: eventContext(ticket) });
    expect(result.state.recipients).toEqual({ to: [REQUESTER], cc: ['sam.okafor@example.com', 'priya.nair@example.com'], bcc: [] });
    const step = result.steps.find((s) => s.nodeId === 'recipients');
    expect(step.output.originalRecipients).toEqual({
      count: 2,
      leftOff: { ownMailbox: 1, agent: 0, requester: 1, automated: 1, unattended: 0, removedByAgent: 0, notAPerson: 0, unchecked: 0 },
    });
  });

  test('the count leaves out people the step reaches another way', async () => {
    const result = await executePreview({
      workflow, definition: definition({ ccCustomEmails: ['sam.okafor@example.com'] }), eventContext: eventContext(ticket),
    });
    expect(result.state.recipients.cc).toEqual(['sam.okafor@example.com', 'priya.nair@example.com']);
    const step = result.steps.find((s) => s.nodeId === 'recipients');
    expect(step.output.originalRecipients.count).toBe(1);
  });

  test('Preview says why the To line was not used', async () => {
    const result = await executePreview({ workflow, definition: definition({}), eventContext: eventContext({ toEmails: ['all-staff@example.com', 'priya.nair@example.com'] }) });
    const step = result.steps.find((s) => s.nodeId === 'recipients');
    expect(step.output.originalRecipients).toMatchObject({ count: 0, toLine: 'not_direct' });
  });

  test('a Shadow run records the widened list on its delivery row', async () => {
    const delivery = await resolve(ticket, {}, 'mock');
    expect(delivery).toEqual({ to: [REQUESTER], cc: ['sam.okafor@example.com', 'priya.nair@example.com'], bcc: [] });
    expect(prismaMock.notificationDelivery.create.mock.calls[0][0].data.status).toBe('mocked');
  });
});
