import { jest } from '@jest/globals';
import jsonLogic from 'json-logic-js';
import { createFakePrisma } from './helpers/fakePrismaStore.js';

/**
 * Auto-help integration W3 (plans/AUTO_HELP_INTEGRATION_PLAN.md D):
 *  - ticket.autoHelp { state, expected, playbook, mode, sentAt, outcome } and
 *    the pipeline view, from the runs / jobs on an in-memory database;
 *  - condition fields + variables for the picker;
 *  - seeded-template guards (Follow-up nudge, Resolution summary, reopen on
 *    reply) evaluate the way the engine evaluates them;
 *  - the retired AI first-reply template is out of the gallery but still loads;
 *  - the one-off guard transforms are idempotent;
 *  - the reply read after an Auto-help close (classifyPostCloseReply).
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
const gatewayMock = { runToolTurn: jest.fn(), sendJson: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { addReply: jest.fn(), addPrivateNote: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ emitTicketEvent: jest.fn(), default: { emitTicketEvent: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false,
  embedQueryTexts: jest.fn(async () => null),
  cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
}));

const ctx = await import('../src/services/autoHelpContextService.js');
const { default: playbookService } = await import('../src/services/autoHelpPlaybookService.js');
const { compileConditionGroup, validateConditionGroup, CONDITION_FIELDS, registerCustomFieldConditionOps } = await import('../src/services/notificationConditionModel.js');
const def = await import('../src/services/notificationWorkflowDefinition.js');
const guards = await import('../src/services/autoHelpWorkflowGuards.js');
const { default: followUp } = await import('../src/services/autoHelpFollowUpService.js');

registerCustomFieldConditionOps(jsonLogic);

function seed(extra = {}) {
  db = createFakePrisma({
    autoHelpSettings: [{ workspaceId: 1, enabled: true, approveModeEnabled: true }],
    autoHelpPlaybook: [{ id: 3, workspaceId: 1, name: 'Software installs', enabled: true, mode: 'approve', sensitive: false }],
    ticket: [{ id: 55, workspaceId: 1, subject: 'Install Bluebeam' }],
    ...extra,
  });
}
const rows = (n) => db._rows(n);

beforeEach(() => { jest.clearAllMocks(); seed(); });
afterEach(() => jest.restoreAllMocks());

describe('ticket.autoHelp context', () => {
  test('off when the workspace switch is off', async () => {
    rows('autoHelpSettings')[0].enabled = false;
    expect(await ctx.contextFor(55, 1)).toEqual({ state: 'off', expected: false, playbook: null, mode: null, sentAt: null, outcome: null });
  });

  test('pending while the settle job waits; staged / sent / withdrawn from the latest real run', async () => {
    rows('autoHelpJob').push({ id: 1, ticketId: 55, status: 'pending' });
    expect((await ctx.contextFor(55, 1)).state).toBe('pending');
    rows('autoHelpJob')[0].status = 'done';
    rows('autoHelpRun').push({ id: 9, ticketId: 55, workspaceId: 1, trigger: 'categorized', status: 'skipped', gateDecision: 'noise_decision', createdAt: new Date('2026-09-26T01:00:00Z') });
    expect((await ctx.contextFor(55, 1)).state).toBe('skipped');
    rows('autoHelpRun').push({ id: 10, ticketId: 55, workspaceId: 1, trigger: 'categorized', status: 'staged', mode: 'approve', playbookId: 3, decision: null, outcome: null, createdAt: new Date('2026-09-26T02:00:00Z') });
    expect(await ctx.contextFor(55, 1)).toEqual({ state: 'staged', expected: false, playbook: 'Software installs', mode: 'approve', sentAt: null, outcome: null });
    Object.assign(rows('autoHelpRun')[1], { status: 'sent', decision: 'agent_sent', decidedAt: new Date('2026-09-26T16:05:00Z'), outcome: 'resolved_confirmed' });
    expect(await ctx.contextFor(55, 1)).toMatchObject({ state: 'sent', sentAt: '2026-09-26T16:05:00.000Z', outcome: 'resolved_confirmed' });
    Object.assign(rows('autoHelpRun')[1], { status: 'staged', decision: null, outcome: 'withdrawn' });
    expect((await ctx.contextFor(55, 1)).state).toBe('withdrawn');
  });

  test('expected (Auto-help will SEND by itself) is false in this build — approve mode never holds an ack', async () => {
    rows('autoHelpPlaybook')[0].mode = 'auto';
    expect(await ctx.expectedFor(55, 1)).toBe(false);
    jest.spyOn(playbookService, 'autoModeAllowed').mockReturnValue(true);
    expect(await ctx.expectedFor(55, 1)).toBe(true);
    rows('autoHelpPlaybook')[0].mode = 'approve';
    expect(await ctx.expectedFor(55, 1)).toBe(false);
    rows('autoHelpPlaybook')[0].mode = 'auto';
    rows('autoHelpRun').push({ id: 10, ticketId: 55, trigger: 'categorized', status: 'sent', decision: 'auto_sent' });
    expect(await ctx.expectedFor(55, 1)).toBe(false); // already answered
  });

  test('pipeline view: sent answer, and a requester reply after it', async () => {
    expect(await ctx.pipelineContextFor(55)).toBeNull();
    rows('autoHelpRun').push({
      id: 10, ticketId: 55, trigger: 'categorized', status: 'sent', mode: 'approve', decision: 'agent_sent', decidedAt: new Date('2026-09-26T16:00:00Z'),
      transcript: { body: { text: '1. Open Company Portal.\n2. Install.' } }, draftSubject: 'Installing Bluebeam', createdAt: new Date('2026-09-26T15:59:00Z'),
    });
    expect(await ctx.pipelineContextFor(55)).toMatchObject({ state: 'sent', sent: true, requesterReplied: false, answerSummary: '1. Open Company Portal. 2. Install.' });
    rows('ticketThreadEntry').push({ id: 1, ticketId: 55, eventType: 'reply', authorType: 'requester', isPrivate: false, occurredAt: new Date('2026-09-26T17:00:00Z') });
    expect((await ctx.pipelineContextFor(55)).requesterReplied).toBe(true);
  });

  test('definitionReadsAutoHelp: only workflows that name it pay for the lookup', () => {
    expect(ctx.definitionReadsAutoHelp({ nodes: [{ data: { conditionGroup: { conditions: [{ field: 'ticket.autoHelp.state' }] } } }] })).toBe(true);
    expect(ctx.definitionReadsAutoHelp(def.buildDefaultWorkflowDefinition('ticket.created'))).toBe(false);
  });
});

describe('condition fields + variables', () => {
  test('the new fields validate and compile', () => {
    for (const field of ['ticket.autoHelp.state', 'ticket.autoHelp.mode', 'ticket.autoHelp.outcome', 'ticket.resolvedByKind', 'event.intakeDecision', 'event.intakeSource', 'event.autoHelpReplyVerdict']) {
      expect(CONDITION_FIELDS[field]).toBeDefined();
      const group = { logic: 'all', conditions: [{ field, operator: 'is', value: 'x' }] };
      expect(validateConditionGroup(group)).toEqual([]);
    }
    const g = { logic: 'all', conditions: [{ field: 'ticket.autoHelp.expected', operator: 'is_true' }, { field: 'event.intakeProvisional', operator: 'is_false' }] };
    expect(jsonLogic.apply(compileConditionGroup(g), { ticket: { autoHelp: { expected: true } }, event: { extra: { provisional: false } } })).toBe(true);
    expect(CONDITION_FIELDS['ticket.parkKind'].options).toContain('auto_help');
  });

  test('variable picker lists ticket.autoHelp.* and ticket.parkKind; the preview sample carries them', () => {
    const paths = def.notificationVariableCatalog().map((v) => v.path);
    expect(paths).toEqual(expect.arrayContaining([
      'ticket.parkKind', 'ticket.resolvedByKind', 'ticket.autoHelp.state', 'ticket.autoHelp.expected', 'ticket.autoHelp.playbook',
      'ticket.autoHelp.mode', 'ticket.autoHelp.sentAt', 'ticket.autoHelp.outcome',
    ]));
    expect(def.sampleEventContext('ticket.created').ticket.autoHelp).toMatchObject({ state: 'staged', expected: false });
  });
});

describe('seeded-template guards', () => {
  const template = (key) => def.WORKFLOW_TEMPLATES.find((t) => t.key === key);

  test('Follow-up nudge: never nudges while Auto-help waits on the requester (parkKind auto_help)', () => {
    const built = template('follow_up_nudge').build();
    expect(def.validateWorkflowDefinition(built, { triggerType: 'ticket.public_reply_added' }).errors).toEqual([]);
    const rule = compileConditionGroup(built.nodes.find((n) => n.id === 'still-open').data.conditionGroup);
    expect(jsonLogic.apply(rule, { ticket: { status: 'Pending', parkKind: 'auto_help' } })).toBe(false);
    expect(jsonLogic.apply(rule, { ticket: { status: 'Pending', parkKind: null } })).toBe(true);
    expect(jsonLogic.apply(rule, { ticket: { status: 'Pending', parkKind: 'waiting_on' } })).toBe(true);
    // …and never after Auto-help closed the ticket (e.g. the requester said thanks within the 24 h).
    expect(jsonLogic.apply(rule, { ticket: { status: 'Open', parkKind: null, resolvedByKind: 'auto_help' } })).toBe(false);
  });

  test('Resolution summary: skips tickets Auto-help closed', () => {
    const built = template('resolution_summary_autosend').build();
    expect(def.validateWorkflowDefinition(built, { triggerType: 'ticket.resolved_closed' }).errors).toEqual([]);
    const guard = built.nodes.find((n) => n.id === 'not-auto-help-close');
    const rule = compileConditionGroup(guard.data.conditionGroup);
    expect(jsonLogic.apply(rule, { ticket: { resolvedByKind: 'auto_help' } })).toBe(false);
    expect(jsonLogic.apply(rule, { ticket: { resolvedByKind: 'agent' } })).toBe(true);
    expect(built.edges.find((e) => e.source === 'trigger').target).toBe('not-auto-help-close');
  });

  test('Reopen on reply: thanks / an out-of-office after an Auto-help close does not reopen; anything else does', () => {
    const built = def.buildDefaultWorkflowDefinition('ticket.reply_received');
    const rule = built.nodes.find((n) => n.id === 'is-resolved').data.rule;
    const scope = (verdict, status = 'Resolved') => ({ ticket: { status }, event: { extra: verdict ? { autoHelpReplyVerdict: verdict } : {} } });
    expect(jsonLogic.apply(rule, scope('confirmed'))).toBe(false);
    expect(jsonLogic.apply(rule, scope('auto_reply'))).toBe(false);
    expect(jsonLogic.apply(rule, scope('help'))).toBe(true);
    expect(jsonLogic.apply(rule, scope(null))).toBe(true);
    expect(jsonLogic.apply(rule, scope(null, 'Open'))).toBe(false);
  });

  test('the retired AI first-reply template is out of the gallery but its definition still loads', () => {
    const keys = def.installableWorkflowTemplates().map((t) => t.key);
    expect(keys).not.toContain('ai_first_reply_draft');
    expect(keys).toEqual(expect.arrayContaining(['follow_up_nudge', 'resolution_summary_autosend']));
    const retired = template('ai_first_reply_draft');
    expect(retired.deprecated).toBe(true);
    expect(retired.deprecatedNote).toMatch(/Knowledge → Playbooks/);
    expect(def.validateWorkflowDefinition(retired.build(), { triggerType: 'ticket.created' }).errors).toEqual([]);
  });
});

describe('one-off guard transforms (installed copies)', () => {
  const legacyNudge = () => {
    const d = def.WORKFLOW_TEMPLATES.find((t) => t.key === 'follow_up_nudge').build();
    const node = d.nodes.find((n) => n.id === 'still-open');
    node.data.conditionGroup.conditions = node.data.conditionGroup.conditions.slice(0, 1); // as installed before W3
    return d;
  };
  const legacySummary = () => {
    const d = def.WORKFLOW_TEMPLATES.find((t) => t.key === 'resolution_summary_autosend').build();
    d.nodes = d.nodes.filter((n) => !['not-auto-help-close', 'skip-auto-help'].includes(n.id));
    d.edges = [{ id: 'e1', source: 'trigger', target: 'recipients' }, ...d.edges.filter((e) => !['e1', 'e1b', 'e1c'].includes(e.id))];
    return d;
  };
  const legacyReopen = () => {
    const d = def.buildDefaultWorkflowDefinition('ticket.reply_received');
    d.nodes.find((n) => n.id === 'is-resolved').data.rule = { in: [{ var: 'ticket.status' }, ['Resolved', 'Closed']] };
    return d;
  };

  test('each guard is added once, validates, and a second pass changes nothing', () => {
    const cases = [
      ['follow_up_nudge', legacyNudge(), 'ticket.public_reply_added', { name: 'Follow-up nudge (24h after agent reply)', triggerType: 'ticket.public_reply_added' }],
      ['resolution_summary', legacySummary(), 'ticket.resolved_closed', { name: 'Resolution summary (auto-send at high confidence)', triggerType: 'ticket.resolved_closed' }],
      ['reopen_on_reply', legacyReopen(), 'ticket.reply_received', { key: 'ticket_reply_received_reopen', name: 'Reopen on requester reply', triggerType: 'ticket.reply_received' }],
    ];
    for (const [kind, legacy, triggerType, wf] of cases) {
      expect(guards.guardKindFor(wf, legacy)).toBe(kind);
      const first = guards.applyGuard(kind, legacy);
      expect(first.changed).toBe(true);
      expect(def.validateWorkflowDefinition(first.definition, { triggerType }).errors).toEqual([]);
      const second = guards.applyGuard(kind, first.definition);
      expect(second.changed).toBe(false);
      expect(second.why).toBe('already guarded');
    }
    // The transformed summary routes Auto-help closes to a stop.
    const summary = guards.applyGuard('resolution_summary', legacySummary()).definition;
    expect(summary.edges.find((e) => e.source === 'trigger').target).toBe('not-auto-help-close');
    expect(summary.edges.find((e) => e.source === 'not-auto-help-close' && e.sourceHandle === 'true').target).toBe('recipients');
  });

  test('an unrelated or hand-edited workflow is left for a person', () => {
    expect(guards.guardKindFor({ name: 'Custom', triggerType: 'ticket.created' }, def.buildDefaultWorkflowDefinition('ticket.created'))).toBeNull();
    const d = legacyNudge();
    d.nodes.find((n) => n.id === 'still-open').data.conditionGroup.logic = 'any';
    expect(guards.addNudgeGuard(d)).toMatchObject({ changed: false });
  });
});

describe('the reply after an Auto-help close (classifyPostCloseReply)', () => {
  const closedRun = (over = {}) => ({
    id: 901, workspaceId: 1, ticketId: 55, playbookId: 3, trigger: 'categorized', status: 'sent', decision: 'agent_sent',
    outcome: 'resolved_silence', outcomeAt: new Date(Date.now() - 2 * 86400e3), outcomeDetail: { history: [] }, ...over,
  });

  test('"thanks, that worked" within 7 days → confirmed (stays closed), history + activity recorded', async () => {
    rows('autoHelpRun').push(closedRun());
    rows('ticketThreadEntry').push({ id: 77, ticketId: 55, eventType: 'reply', authorType: 'requester', bodyText: 'Thanks, that worked!', occurredAt: new Date() });
    const read = await followUp.classifyPostCloseReply({ id: 55, workspaceId: 1, subject: 'Install Bluebeam' }, { entryId: 77 });
    expect(read).toEqual({ verdict: 'confirmed', via: 'keywords', runId: 901 });
    expect(rows('autoHelpRun')[0].outcomeDetail.history.map((h) => h.step)).toContain('post_close_reply');
    expect(rows('ticketActivity').map((a) => a.activityType)).toContain('auto_help_post_close_reply');
    expect(rows('autoHelpRun')[0].outcome).toBe('resolved_silence'); // not 'reopened'
  });

  test('"still broken" → help (reopen as usual); an unsure model → help', async () => {
    rows('autoHelpRun').push(closedRun());
    rows('ticketThreadEntry').push({ id: 78, ticketId: 55, eventType: 'reply', authorType: 'requester', bodyText: 'It is still not working, the installer fails.', occurredAt: new Date() });
    gatewayMock.sendJson.mockResolvedValue({ parsed: { verdict: 'needs_help' } });
    expect((await followUp.classifyPostCloseReply({ id: 55, workspaceId: 1 }, { entryId: 78 })).verdict).toBe('help');
    gatewayMock.sendJson.mockRejectedValue(new Error('timeout'));
    expect((await followUp.classifyPostCloseReply({ id: 55, workspaceId: 1 }, { entryId: 78 })).verdict).toBe('help');
  });

  test('an out-of-office after the close → auto_reply (stays closed)', async () => {
    rows('autoHelpRun').push(closedRun());
    rows('ticketThreadEntry').push({ id: 79, ticketId: 55, eventType: 'reply', authorType: 'requester', title: 'Automatic reply: Install Bluebeam', bodyText: 'I am out of the office until Monday.', occurredAt: new Date() });
    expect((await followUp.classifyPostCloseReply({ id: 55, workspaceId: 1 }, { entryId: 79 })).verdict).toBe('auto_reply');
  });

  test('older than 7 days, or closed by a person: not read (null)', async () => {
    rows('autoHelpRun').push(closedRun({ outcomeAt: new Date(Date.now() - 8 * 86400e3) }));
    expect(await followUp.classifyPostCloseReply({ id: 55, workspaceId: 1 }, { entryId: 1 })).toBeNull();
    rows('autoHelpRun')[0].outcome = 'help_requested';
    rows('autoHelpRun')[0].outcomeAt = new Date();
    expect(await followUp.classifyPostCloseReply({ id: 55, workspaceId: 1 }, { entryId: 1 })).toBeNull();
  });
});
