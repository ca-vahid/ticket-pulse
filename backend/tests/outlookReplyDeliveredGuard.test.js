import { jest } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * QA 11-05b #3 — an agent's Outlook reply fires "Agent replied to requester"
 * marked `alreadyDelivered`. Guards here:
 *  (b) a workflow e-mail step that would send the requester that same reply
 *      text again is skipped; anything else (a check-in nudge, a mail to the
 *      team) still sends;
 *  (c) only the in-app reply path and the mailbox ingest fire the event — the
 *      FreshService sync never does, so an FS-born ticket cannot get it twice.
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
  ticketActivity: { create: jest.fn() },
  mirrorJob: { findFirst: jest.fn(), create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn().mockResolvedValue({ success: true, status: 'sent' }),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: { create: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueFieldSync: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { executeDefinition, repeatsDeliveredReply, DELIVERED_REPLY_SKIP_REASON } = await import('../src/services/notificationWorkflowEngine.js');

const REPLY = 'Hi Rita, I have reset your VPN token. Please try again and let me know.';
const eventContext = (extra = {}, over = {}) => ({
  event: { type: 'ticket.public_reply_added', source: 'email_inbound', occurredAt: '2026-11-05T22:00:00.000Z', dedupeStamp: `reply:${Math.floor(Math.random() * 1e6)}`, extra },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, subject: 'VPN access problem', status: 'Open', isNoise: false, ccEmails: [] },
  requester: { name: 'Rita', email: 'rita@example.com' },
  assignedAgent: { name: 'Terry', email: 'terry@example.com' },
  previousAgent: null,
  ...over,
});
const outlookExtra = { entryId: 9001, byEmail: 'terry@example.com', bodyText: REPLY, via: 'outlook', alreadyDelivered: true };

function definition({ to = ['requester'], html, text }) {
  return {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.public_reply_added' } },
      { id: 'recipients', type: 'recipient_resolver', data: { to, cc: [], bcc: [] } },
      { id: 'template', type: 'template_render', data: { contentSource: 'template_only', subject: 'Re: {{ ticket.subject }}', html, text } },
      { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'recipients' },
      { id: 'e2', source: 'recipients', target: 'template' },
      { id: 'e3', source: 'template', target: 'send' },
    ],
  };
}
const workflow = { id: 88, workspaceId: 1, triggerType: 'ticket.public_reply_added', publishedVersion: 1, versions: [] };
const sendStep = (result) => result.steps.find((s) => s.nodeId === 'send');

beforeEach(() => {
  jest.clearAllMocks();
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
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 700, ...create }));
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 700, ...data }));
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
});

describe('(b) a step that would mail the requester the Outlook reply again is skipped', () => {
  test('the engine skips a requester mail carrying {{ event.extra.bodyText }} when alreadyDelivered is set', async () => {
    const def = definition({ html: '<p>{{ event.extra.bodyText }}</p>', text: '{{ event.extra.bodyText }}' });
    const result = await executeDefinition({ workflow, definition: def, eventContext: eventContext(outlookExtra), executionMode: 'live' });
    expect(sendStep(result).output).toMatchObject({ skipped: true, alreadyDelivered: true, reason: DELIVERED_REPLY_SKIP_REASON });
    expect(JSON.stringify(sendStep(result))).toContain('already delivered');
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
  });

  test('the same workflow for an in-app reply (no flag) still sends', async () => {
    const def = definition({ html: '<p>{{ event.extra.bodyText }}</p>', text: '{{ event.extra.bodyText }}' });
    const result = await executeDefinition({ workflow, definition: def, eventContext: eventContext({ ...outlookExtra, alreadyDelivered: undefined, via: undefined }), executionMode: 'live' });
    expect(sendStep(result).output?.skipped).toBeFalsy();
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalled();
  });

  test('a check-in nudge (no reply text) still goes out after an Outlook reply', async () => {
    const def = definition({ html: '<p>Just checking in on {{ ticket.subject }}.</p>', text: 'Just checking in on {{ ticket.subject }}.' });
    const result = await executeDefinition({ workflow, definition: def, eventContext: eventContext(outlookExtra), executionMode: 'live' });
    expect(sendStep(result).output?.skipped).toBeFalsy();
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalled();
  });

  test('repeatsDeliveredReply: needs the flag, the requester as a recipient, and the reply text in the body', () => {
    const ctx = eventContext(outlookExtra);
    const email = { html: `<p>${REPLY.replace('I have', 'I&nbsp;have')}</p>`, text: '' };
    expect(repeatsDeliveredReply(ctx, email, ['rita@example.com'])).toBe(true);
    expect(repeatsDeliveredReply(ctx, email, [], ['RITA@example.com'])).toBe(true); // Cc counts, any case
    expect(repeatsDeliveredReply(ctx, email, ['terry@example.com'])).toBe(false); // to the team, not the requester
    expect(repeatsDeliveredReply(eventContext({ ...outlookExtra, alreadyDelivered: false }), email, ['rita@example.com'])).toBe(false);
    expect(repeatsDeliveredReply(ctx, { html: '<p>Thanks for your patience.</p>' }, ['rita@example.com'])).toBe(false);
    expect(repeatsDeliveredReply(eventContext({ ...outlookExtra, bodyText: 'Ok' }), { text: 'Ok' }, ['rita@example.com'])).toBe(false); // too short to judge
    expect(DELIVERED_REPLY_SKIP_REASON).toMatch(/already delivered/);
  });
});

describe('(c) only the in-app reply and the mailbox ingest fire ticket.public_reply_added', () => {
  test('no FreshService sync / webhook / mirror path emits it', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/services');
    const emitters = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(path.join(dir, file), 'utf8');
      // An emit is the event name as an argument (not a registry / label entry).
      if (/emitTicketEvent[\s\S]{0,200}'ticket\.public_reply_added'/.test(src) || /'ticket\.note_added' : 'ticket\.public_reply_added'/.test(src)) emitters.push(file);
    }
    expect(emitters.sort()).toEqual(['mailboxIngestService.js', 'ticketService.js']);
  });
});
