/**
 * QA 10-13 item 14 - "Record this e-mail in the ticket's conversation", the
 * option on a workflow's Send e-mail step.
 *
 *   off / absent  -> exactly as before: nothing is written to the thread;
 *   on, live      -> after a successful send the ticket gets ONE entry with the
 *                    subject, To/Cc and the body as sent: a public reply when
 *                    the requester is among the recipients, else an internal note;
 *   Shadow (mock) -> nothing recorded (nothing was sent), the run log says it would;
 *   never         -> a reply_sent / note_added event, a mirror job, or a failed
 *                    step because the record could not be written.
 * Harness from notificationWorkflowEnginePersistence.test.js.
 */
import { jest } from '@jest/globals';

const prismaMock = {
  notificationWorkflowRun: {
    create: jest.fn(),
    update: jest.fn(),
  },
  notificationWorkflowStepRun: {
    create: jest.fn(),
    update: jest.fn(),
  },
  notificationDelivery: {
    create: jest.fn(),
    findUnique: jest.fn(),
  },
  notificationLlmToolPolicy: {
    findUnique: jest.fn(),
  },
  aiProviderAttempt: {
    updateMany: jest.fn(),
  },
  ticket: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  ticketThreadEntry: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
  mirrorJob: { findFirst: jest.fn(), create: jest.fn() },
  notificationEmailBlock: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  notificationEmailSignature: {
    findUnique: jest.fn(),
  },
};

const processDeliveryMock = jest.fn();
const providerSendJsonMock = jest.fn();
const providerRunToolTurnMock = jest.fn();
const listEnabledForEventMock = jest.fn();
const recordSuppressionDecisionsMock = jest.fn().mockResolvedValue({ updated: 0 });
const publicStatusUrl = 'https://ticketpulse.example/ticket-status/sample-token';
const raiseUrgencyUrl = 'https://ticketpulse.example/ticket-urgency/sample-token';
const immediateSupportUrl = 'https://ticketpulse.example/ticket-escalation/sample-token';

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: processDeliveryMock,
}));

jest.unstable_mockModule('../src/services/notificationWorkflowRepository.js', () => ({
  default: {
    listEnabledForEvent: listEnabledForEventMock,
    recordSuppressionDecisions: recordSuppressionDecisionsMock,
  },
}));

jest.unstable_mockModule('../src/services/notificationWorkflowPolicyService.js', () => ({
  enrichEventContextWithNotificationPolicy: jest.fn(async (context) => context),
  selectWorkflowsForNotificationTiming: jest.fn((workflows) => ({
    selected: workflows,
    suppressed: [],
    mode: 'standard',
    reason: null,
  })),
}));

jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: {
    sendJson: providerSendJsonMock,
    runToolTurn: providerRunToolTurnMock,
  },
}));

jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  enrichEventContextWithPublicStatusUrl: jest.fn(async (context) => ({
    ...context,
    publicStatusUrl,
    raiseUrgencyUrl,
    selfEscalationUrl: immediateSupportUrl,
    afterHoursEscalationUrl: immediateSupportUrl,
    ticket: {
      ...(context.ticket || {}),
      publicStatusUrl,
      raiseUrgencyUrl,
      urgencyRaiseUrl: raiseUrgencyUrl,
      selfEscalationUrl: immediateSupportUrl,
      afterHoursEscalationUrl: immediateSupportUrl,
    },
    afterHoursSupport: {
      ...(context.afterHoursSupport || {}),
      selfEscalationUrl: immediateSupportUrl,
      immediateSupportUrl,
      activeContact: {
        name: 'Alex Agent',
        phone: '+16045551234',
        email: 'alex.agent@example.com',
        photoUrl: 'data:image/png;base64,avatar',
        rotationLabel: 'Manual after-hours contact',
        source: 'manual',
      },
    },
  })),
}));

// Re-entrancy proof (same as the add_note tests): the only path that turns a
// thread write into workflow triggers is emitTicketEvent, and the only path to
// FreshService is a mirror job. Recording a sent e-mail must touch neither.
const emitTicketEventMock = jest.fn();
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: emitTicketEventMock, emitTicketLifecycleNotifications: jest.fn() },
  emitTicketEvent: emitTicketEventMock,
}));
const mirrorMock = { enqueueThreadEntry: jest.fn(), enqueueFieldSync: jest.fn() };
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorMock }));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { executeDefinition } = await import('../src/services/notificationWorkflowEngine.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

const workflow = {
  id: 7,
  workspaceId: 1,
  triggerType: 'ticket.created',
  publishedVersion: 1,
  versions: [{ id: 70, version: 1 }],
};

const eventContext = {
  event: {
    type: 'ticket.created',
    source: 'test',
    occurredAt: '2026-05-29T19:00:00.000Z',
    dedupeStamp: '2026-05-29T19:00:00.000Z',
  },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: {
    id: 501,
    freshserviceTicketId: 225001,
    subject: 'VPN access problem',
    status: 'Open',
    priorityLabel: 'High',
    isNoise: false,
  },
  requester: { name: 'Requester', email: 'requester@example.com' },
  assignedAgent: null,
  previousAgent: null,
};

const { validateWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const { recordWorkflowEmailOnTicket } = await import('../src/services/notificationWorkflowActionNodes.js');

const namedWorkflow = { ...workflow, name: 'BST request processed' };
function definitionWith(sendData = {}) {
  const definition = buildDefaultWorkflowDefinition('ticket.created');
  const send = definition.nodes.find((node) => node.type === 'send_email');
  send.data = { ...send.data, ...sendData };
  return definition;
}
const runLive = (definition, extra = {}) => executeDefinition({ workflow: namedWorkflow, definition, eventContext, dryRun: false, triggerSource: 'test', ...extra });
const sendOutput = (result) => result.steps.find((step) => step.nodeType === 'send_email').output;
const recorded = () => prismaMock.ticketThreadEntry.create.mock.calls.map(([arg]) => arg.data);

describe('workflow e-mail recorded in the conversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    providerSendJsonMock.mockReset();
    providerRunToolTurnMock.mockReset();
    listEnabledForEventMock.mockReset();
    prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({
      id: 900,
      ...data,
    }));
    prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
    prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({
      id: Math.floor(Math.random() * 10000) + 1,
      ...data,
    }));
    prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
    prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({
      id: 1234,
      ...data,
    }));
    prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
    prismaMock.aiProviderAttempt.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.ticket.findFirst.mockResolvedValue({
      id: 501,
      workspaceId: 1,
      freshserviceTicketId: BigInt(225001),
      subject: 'VPN access problem',
      descriptionText: 'User cannot connect to VPN from home.',
      status: 'Open',
      priority: 3,
      assessedPriority: 'High',
      toEmails: ['helpdesk@example.com'],
      ccEmails: ['manager@example.com'],
      replyCcEmails: [],
      fwdEmails: [],
      category: 'Access',
      subCategory: 'VPN',
      ticketCategory: 'IT',
      tpSkill: 'Network',
      tpSubskill: 'VPN',
      isNoise: false,
      createdAt: new Date('2026-05-29T18:30:00.000Z'),
      assignedAt: null,
      resolvedAt: null,
      closedAt: null,
      freshserviceUpdatedAt: new Date('2026-05-29T19:00:00.000Z'),
      workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' },
      requester: { id: 40, name: 'Requester', email: 'requester@example.com', department: 'Operations', jobTitle: 'Lead' },
      assignedTech: null,
      internalCategory: { id: 5, name: 'Network' },
      internalSubcategory: { id: 6, name: 'VPN' },
    });
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    prismaMock.notificationEmailBlock.findFirst.mockResolvedValue(null);
    prismaMock.notificationEmailBlock.findMany.mockResolvedValue([]);
    prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
    processDeliveryMock.mockResolvedValue({ success: true, result: { provider: 'sendgrid' } });
    processDeliveryMock.mockResolvedValue({ id: 1234, success: true, result: { messageId: '<abc@mail.example>' } });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 501, workspaceId: 1, requester: { email: 'Requester@Example.com' } });
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 7001, ...data }));
  });

  test('the option is optional in a saved workflow, and must be on or off when present', () => {
    expect(validateWorkflowDefinition(definitionWith(), { triggerType: 'ticket.created' }).errors).toEqual([]);
    expect(validateWorkflowDefinition(definitionWith({ recordInConversation: true }), { triggerType: 'ticket.created' }).errors).toEqual([]);
    expect(validateWorkflowDefinition(definitionWith({ recordInConversation: false }), { triggerType: 'ticket.created' }).errors).toEqual([]);
    expect(validateWorkflowDefinition(definitionWith({ recordInConversation: 'yes' }), { triggerType: 'ticket.created' }).errors.join(' '))
      .toMatch(/must be on or off/);
  });

  test('a workflow saved before the option existed sends as before and writes nothing to the thread', async () => {
    const result = await runLive(definitionWith());
    expect(result.status).toBe('completed');
    expect(processDeliveryMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(sendOutput(result).conversationRecord).toBeUndefined();
    // explicitly off is the same
    await runLive(definitionWith({ recordInConversation: false }), { eventContext: { ...eventContext, event: { ...eventContext.event, dedupeStamp: 'second' } } });
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('on, and the mail went to the requester: one public reply entry "sent by workflow" with subject, recipients and the body as sent', async () => {
    const result = await runLive(definitionWith({ recordInConversation: true }));
    expect(result.status).toBe('completed');
    const out = sendOutput(result);
    expect(out.conversationRecord).toEqual({ recorded: true, entryId: 7001, as: 'public_reply' });
    expect(recorded()).toHaveLength(1);
    const [entry] = recorded();
    expect(entry).toMatchObject({
      ticketId: 501,
      workspaceId: 1,
      externalEntryId: 'wfmail-1234',
      source: 'ticketpulse_user',
      eventType: 'reply',
      authorType: 'system',
      actorName: 'Workflow: BST request processed',
      incoming: false,
      isPrivate: false,
      visibility: 'public',
      title: 'Sent by workflow BST request processed',
      mirrorState: null,
      emailMessageId: '<abc@mail.example>',
    });
    expect(entry.rawPayload).toMatchObject({
      kind: 'workflow_email', v: 1, workflowId: 7, workflowName: 'BST request processed', runId: 900, deliveryId: 1234,
      subject: out.subject, toRequester: true, to_emails: out.toRecipients, cc_emails: out.ccRecipients, attachments: [],
    });
    expect(entry.bodyText).toContain(`Subject: ${out.subject}`);
    expect(entry.bodyText).toContain('To: requester@example.com');
    expect(entry.bodyHtml).toContain('<strong>Sent by workflow BST request processed</strong>');
    // the body as sent follows the header
    expect(entry.bodyText).toContain(String(out.textBody).trim().slice(0, 40));
    // written only after the send succeeded
    expect(processDeliveryMock.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.ticketThreadEntry.create.mock.invocationCallOrder[0]);
  });

  test('it never starts another workflow and is never mirrored to FreshService', async () => {
    await runLive(definitionWith({ recordInConversation: true }));
    expect(recorded()).toHaveLength(1);
    expect(emitTicketEventMock).not.toHaveBeenCalled();
    expect(mirrorMock.enqueueThreadEntry).not.toHaveBeenCalled();
    expect(prismaMock.mirrorJob.create).not.toHaveBeenCalled();
  });

  test('Shadow: nothing was sent, so nothing is recorded - the run log says it would be', async () => {
    const result = await executeDefinition({
      workflow: namedWorkflow, definition: definitionWith({ recordInConversation: true }), eventContext, dryRun: true, executionMode: 'mock', triggerSource: 'test',
    });
    const out = sendOutput(result);
    expect(out).toMatchObject({ mocked: true, skipped: true, wouldRecordInConversation: true });
    expect(processDeliveryMock).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('the send failed: nothing is recorded', async () => {
    processDeliveryMock.mockResolvedValue({ id: 1234, success: false, error: 'SendGrid 403' });
    await expect(runLive(definitionWith({ recordInConversation: true }))).rejects.toThrow('SendGrid 403');
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('the record cannot be written: the step still succeeds (a retry would mail the customer twice)', async () => {
    prismaMock.ticketThreadEntry.create.mockRejectedValue(new Error('thread table down'));
    const result = await runLive(definitionWith({ recordInConversation: true }));
    expect(result.status).toBe('completed');
    expect(sendOutput(result).conversationRecord).toEqual({ recorded: false, reason: 'thread table down' });
    expect(sendOutput(result).deliveryId).toBe(1234);
  });
});

describe('recordWorkflowEmailOnTicket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 501, workspaceId: 5, requester: { email: 'pm@client.example' } });
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 7002, ...data }));
  });
  const base = {
    ticketId: 501, workflowId: 14758, workflowName: 'BST completion', runId: 31, nodeId: 'send', deliveryId: 88,
    subject: 'Project 1137860; 1137861 - Request Processed', htmlBody: '<p>Your BST request has been processed.</p>', textBody: 'Your BST request has been processed.',
  };

  test('the requester is not among the recipients: an internal note that names who it went to', async () => {
    const out = await recordWorkflowEmailOnTicket({ ...base, toRecipients: ['Susan.Xu@bgc.example', 'ap@bgc.example'], ccRecipients: ['lead@bgc.example'] });
    expect(out).toEqual({ recorded: true, entryId: 7002, as: 'internal_note' });
    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data).toMatchObject({
      eventType: 'note', isPrivate: true, visibility: 'private', authorType: 'system', mirrorState: null, workspaceId: 5,
      title: 'E-mail sent to susan.xu@bgc.example, ap@bgc.example, lead@bgc.example by workflow BST completion',
    });
    expect(data.bodyText).toContain('Subject: Project 1137860; 1137861 - Request Processed');
    expect(data.bodyText).toContain('To: susan.xu@bgc.example, ap@bgc.example');
    expect(data.bodyText).toContain('Cc: lead@bgc.example');
    expect(data.bodyText).toContain('Your BST request has been processed.');
    expect(data.bodyHtml).toContain('<p>Your BST request has been processed.</p>');
    expect(data.rawPayload).toMatchObject({ toRequester: false, cc_emails: ['lead@bgc.example'] });
  });

  test('the requester in Cc counts as "went to the requester": a public reply', async () => {
    const out = await recordWorkflowEmailOnTicket({ ...base, toRecipients: ['ap@bgc.example'], ccRecipients: ['PM@Client.example'] });
    expect(out.as).toBe('public_reply');
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data).toMatchObject({ eventType: 'reply', visibility: 'public', isPrivate: false });
  });

  test('hidden recipients stay hidden in a public entry and are listed in an internal note; attachments are listed by name', async () => {
    await recordWorkflowEmailOnTicket({ ...base, toRecipients: ['pm@client.example'], bccRecipients: ['audit@bgc.example'], attachmentNames: ['BST form.pdf', ''] });
    let { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.bodyText).toContain('Bcc: 1 hidden');
    expect(data.bodyText).not.toContain('audit@bgc.example');
    expect(data.bodyText).toContain('Attachments: BST form.pdf');
    expect(data.rawPayload).toMatchObject({ bcc_count: 1, attachments: ['BST form.pdf'] });
    await recordWorkflowEmailOnTicket({ ...base, toRecipients: ['ap@bgc.example'], bccRecipients: ['audit@bgc.example'] });
    ({ data } = prismaMock.ticketThreadEntry.create.mock.calls[1][0]);
    expect(data.bodyText).toContain('Bcc: audit@bgc.example');
  });

  test('anything typed in the subject or the workflow name is escaped in the header', async () => {
    await recordWorkflowEmailOnTicket({ ...base, subject: '<script>x</script>', workflowName: 'A <b>bold</b> one', toRecipients: ['ap@bgc.example'] });
    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.bodyHtml).toContain('Subject: &lt;script&gt;x&lt;/script&gt;');
    expect(data.bodyHtml).not.toContain('<script>');
    expect(data.bodyHtml).toContain('workflow A &lt;b&gt;bold&lt;/b&gt; one');
  });

  test('the same delivery is recorded once: a retried step does not double it', async () => {
    prismaMock.ticketThreadEntry.create.mockRejectedValue({ code: 'P2002' });
    expect(await recordWorkflowEmailOnTicket({ ...base, toRecipients: ['ap@bgc.example'] })).toEqual({ recorded: false, duplicate: true, reason: 'Already recorded' });
  });

  test('no ticket, or a ticket that is gone: nothing written, a reason given', async () => {
    expect(await recordWorkflowEmailOnTicket({ ...base, ticketId: null })).toMatchObject({ recorded: false });
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    expect(await recordWorkflowEmailOnTicket({ ...base, toRecipients: ['ap@bgc.example'] })).toEqual({ recorded: false, reason: 'Ticket not found' });
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });
});
