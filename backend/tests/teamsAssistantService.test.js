import { jest } from '@jest/globals';
import {
  setupAssistant, toolTurn, message, cardText, ALEX, SAM, JORDAN, CASEY, OTHER,
} from './helpers/teamsAssistantHarness.js';

/**
 * Teams assistant (plans/TEAMS_BOT_COMMANDS_PLAN.md, P0–P2): permissions per
 * role, Shadow sends nothing AI-written, the monthly cap stops the AI and
 * e-mails once, the per-person switch, the number check, the tool loop.
 */

const h = await setupAssistant();
const { svc, tools, accessModule, settings, notifications, prismaMock, botMock, gateway, mail, approvals, availability, state } = h;
const { executeAssistantTool } = tools;
const { buildAccessContext } = accessModule;
const { checkSubmission, leadNumbersOk, numbersIn, NO_AI_NOTE } = h.svcModule;

const ctxFor = async (email) => ({ access: await buildAccessContext(email), baseUrl: 'https://tp.example.com', now: new Date(), sensitiveWorkspaces: new Set() });
const sentCards = () => botMock.replyToActivity.mock.calls.map((c) => c[1]?.card).filter(Boolean);
const setMode = (ws, mode, extra = {}) => state.settings.set(ws, { workspaceId: ws, mode, pilotEmails: [], monthlyCapUsd: 25, sensitive: false, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  state.settings.clear();
  state.people.clear();
  state.turns = [];
  state.spend = [];
  state.teamsOn = new Set([1, 2]);
  settings.cache.clear();
  settings.people.clear();
  settings.spend.clear();
  settings.alerted.clear();
  svc.hits.clear();
  svc.seen.clear();
  gateway.runToolTurn.mockReset();
  prismaMock.teamsConversation.findFirst.mockImplementation(async ({ where }) => ({ email: { 'aad-alex': ALEX, 'aad-jordan': JORDAN, 'aad-casey': CASEY, 'aad-sam': SAM }[where.aadObjectId] }));
});

// ---------------------------------------------------------------- the access context

describe('who is asking: the access context per role', () => {
  test('an agent: their own workspace and technician rows only', async () => {
    const a = await buildAccessContext(ALEX);
    expect(a.superAdmin).toBe(false);
    expect(a.workspaces.map((w) => [w.id, w.kind])).toEqual([[1, 'agent']]);
    expect(a.techs.map((t) => t.id)).toEqual([7]);
  });
  test('a workspace member: the access row, no agent profile', async () => {
    const a = await buildAccessContext(SAM);
    expect(a.workspaces.map((w) => [w.id, w.kind])).toEqual([[2, 'member']]);
    expect(a.techs).toEqual([]);
  });
  test('an approver-only manager: no workspaces at all', async () => {
    const a = await buildAccessContext(JORDAN);
    expect(a.workspaces).toEqual([]);
    expect(a.techs).toEqual([]);
  });
  test('a super admin: every workspace, as admin', async () => {
    const a = await buildAccessContext(CASEY);
    expect(a.superAdmin).toBe(true);
    expect(a.workspaces.map((w) => w.id)).toEqual([1, 2, 4, 5]);
    expect(a.user.role).toBe('admin');
  });
});

// ---------------------------------------------------------------- permissions per tool

describe('permissions: the tools never show more than the app does', () => {
  test('my_tickets: an agent sees only tickets assigned to their own technician row', async () => {
    const r = await executeAssistantTool('my_tickets', { filter: 'open' }, await ctxFor(ALEX));
    expect(r.rows.map((x) => x.ticketId).sort()).toEqual([101, 102, 103]);
    expect(r.counts.open).toBe(3);
    const where = prismaMock.ticket.count.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"in":[7]');
    expect(JSON.stringify(where)).not.toContain('99');
  });
  test('my_tickets: a member and an approver-only manager have no tickets (no queries run)', async () => {
    for (const who of [SAM, JORDAN]) {
      prismaMock.ticket.findMany.mockClear();
      const r = await executeAssistantTool('my_tickets', {}, await ctxFor(who));
      expect(r.notAnAgent).toBe(true);
      expect(r.rows).toEqual([]);
      expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
    }
  });
  test('ticket_status: only in workspaces the person can open tickets in', async () => {
    let r = await executeAssistantTool('ticket_status', { ref: 'TP-10422' }, await ctxFor(ALEX));
    expect(r.rows.map((x) => x.ticketId)).toEqual([101]);
    expect(h.resolveTicketRef.mock.calls.map((c) => c[1])).toEqual([1]);

    h.resolveTicketRef.mockClear();
    r = await executeAssistantTool('ticket_status', { ref: 'TP-10422' }, await ctxFor(SAM));
    expect(r.rows.map((x) => x.ticketId)).toEqual([201]);
    expect(h.resolveTicketRef.mock.calls.map((c) => c[1])).toEqual([2]);

    h.resolveTicketRef.mockClear();
    r = await executeAssistantTool('ticket_status', { ref: 'TP-10422' }, await ctxFor(JORDAN));
    expect(r.rows).toEqual([]);
    expect(r.noTicketAccess).toBe(true);
    expect(h.resolveTicketRef).not.toHaveBeenCalled();

    h.resolveTicketRef.mockClear();
    r = await executeAssistantTool('ticket_status', { ref: 'TP-10422' }, await ctxFor(CASEY));
    expect(h.resolveTicketRef.mock.calls.map((c) => c[1])).toEqual([1, 2, 4, 5]);
    expect(r.rows.map((x) => x.workspaceName)).toEqual(['IT', 'Accounting']); // one number, two workspaces: both shown
  });
  test('ticket_status never returns a description or the thread', async () => {
    const r = await executeAssistantTool('ticket_status', { ref: '#231164' }, await ctxFor(ALEX));
    const select = prismaMock.ticket.findFirst.mock.calls.at(-1)[0].select;
    expect(select.description).toBeUndefined();
    expect(select.descriptionText).toBeUndefined();
    expect(Object.keys(r.rows[0])).not.toContain('description');
  });
  test('my_pending_approvals: an approver-only manager gets their own approvals, by e-mail', async () => {
    const r = await executeAssistantTool('my_pending_approvals', {}, await ctxFor(JORDAN));
    expect(r.rows.map((x) => x.approvalId)).toEqual([12]);
    expect(prismaMock.ticketApproval.groupBy.mock.calls[0][0].where.approverEmail).toBe(JORDAN);
    expect(approvals.inboxFor).toHaveBeenCalledWith(2, { email: JORDAN });
  });
  test('my_pending_approvals: rows addressed to someone else are dropped even if a service returned them', async () => {
    approvals.inboxFor.mockResolvedValueOnce([{ id: 20, ticketId: 201, status: 'pending', approverEmail: OTHER, displayRef: 'TP-10422', subject: 'x' }, { id: 12, ticketId: 201, status: 'pending', approverEmail: JORDAN, displayRef: 'TP-10422', subject: 'y' }]);
    const r = await executeAssistantTool('my_pending_approvals', {}, await ctxFor(JORDAN));
    expect(r.rows.map((x) => x.approvalId)).toEqual([12]);
  });
  test('my_pending_approvals i_asked: approvals the person asked for, nobody else\'s', async () => {
    const r = await executeAssistantTool('my_pending_approvals', { side: 'i_asked' }, await ctxFor(ALEX));
    expect(r.rows.map((x) => x.approvalId).sort()).toEqual([12, 16]);
  });
  test('my_pending_approvals: a workspace the person does not have is an error, not a wider search', async () => {
    const r = await executeAssistantTool('my_pending_approvals', { workspace: 'Field Equipment' }, await ctxFor(JORDAN));
    expect(r.errorKind).toBe('unknown_workspace');
  });
  test('time_away_waiting_for_me: a super admin\'s step-in list only when asked', async () => {
    const ctx = await ctxFor(CASEY);
    expect((await executeAssistantTool('time_away_waiting_for_me', {}, ctx)).rows.map((r) => r.requestId)).toEqual([31]);
    expect((await executeAssistantTool('time_away_waiting_for_me', { include_others: true }, ctx)).rows.map((r) => r.requestId)).toEqual([31, 32]);
  });
  test('time_away_waiting_for_me: include_others does nothing for anyone else; leave notes never come back', async () => {
    const r = await executeAssistantTool('time_away_waiting_for_me', { include_others: true }, await ctxFor(JORDAN));
    expect(r.rows.map((x) => x.requestId)).toEqual([31]);
    expect(JSON.stringify(r)).not.toContain('PRIVATE LEAVE NOTE');
    expect(availability.listPendingFor).toHaveBeenCalledWith(expect.objectContaining({ email: JORDAN }));
  });
  test('who_is_away runs the calendar as the asker (its own visibility rules)', async () => {
    const r = await executeAssistantTool('who_is_away', { date: 'today' }, await ctxFor(ALEX));
    expect(availability.calendar).toHaveBeenCalledWith(expect.objectContaining({ email: ALEX, role: 'agent' }), expect.objectContaining({ workspaceId: 1 }));
    expect(r.rows.map((x) => x.name)).toEqual(['Alex Rivera', 'Sam Ortiz']);
  });
  test('my_time_away: own requests and balances; no person row = nothing (and nothing created)', async () => {
    const mine = await executeAssistantTool('my_time_away', { scope: 'this_year' }, await ctxFor(ALEX));
    expect(mine.rows).toHaveLength(1);
    expect(mine.balances[0].remaining).toBe(3);
    expect(JSON.stringify(mine)).not.toContain('PRIVATE LEAVE NOTE');
    availability.listMine.mockClear();
    const none = await executeAssistantTool('my_time_away', {}, await ctxFor(SAM));
    expect(none.rows).toEqual([]);
    expect(availability.listMine).not.toHaveBeenCalled();
  });
  test('the model view drops e-mails and cuts subjects; a sensitive workspace sends no subject', async () => {
    const ctx = await ctxFor(ALEX);
    const r = await executeAssistantTool('my_tickets', {}, ctx);
    const view = tools.modelView(r, ctx);
    expect(JSON.stringify(view)).not.toMatch(/@example\.com/);
    expect(JSON.stringify(view)).not.toContain('https://');
    expect(view.rows[0].subject).toBeTruthy();
    const hidden = tools.modelView(r, { ...ctx, sensitiveWorkspaces: new Set([1]) });
    expect(hidden.rows.every((x) => x.subject === null)).toBe(true);
  });
});

// ---------------------------------------------------------------- the number check and the plan checks

describe('submit_answer checks', () => {
  const results = [{ result: { tool: 'my_pending_approvals', rows: [{ id: 'approval:12' }], counts: { total: 1 } }, view: { tool: 'my_pending_approvals', counts: { total: 1 }, rows: [{ id: 'approval:12', ref: 'TP-10422' }] } }];
  test('numbers in the lead must come from the tool results', () => {
    expect(numbersIn('3 approvals, 2.5 days, TP-10422')).toEqual(['3', '2.5', '10422']);
    expect(leadNumbersOk('1 approval waits on TP-10422.', [results[0].view])).toBe(true);
    expect(leadNumbersOk('You have 7 approvals waiting.', [results[0].view])).toBe(false);
  });
  test('a lead with an invented number is replaced by the template line', () => {
    const c = checkSubmission({ lead: 'You have 7 approvals waiting.' }, { results });
    expect(c.lead).toBeNull();
    expect(c.leadReplaced).toBe(true);
  });
  test('confirm / focus ids the turn never saw are ignored', () => {
    const c = checkSubmission({ lead: 'One.', confirm: { kind: 'approval', id: 'approval:999' }, focus_ids: ['approval:12', 'ticket:5'] }, { results });
    expect(c.confirm).toBeNull();
    expect(c.kind).toBe('list');
    expect(c.focusIds).toEqual(['approval:12']);
    expect(c.droppedIds).toEqual(['ticket:5', 'approval:999']);
  });
  test('confirm with an id from memory is kept', () => {
    const c = checkSubmission({ lead: 'OK.', confirm: { kind: 'approval', id: 'approval:15' } }, { results: [], memoryIds: ['approval:15'] });
    expect(c.kind).toBe('confirm');
  });
  test('links and addresses never survive into the lead', () => {
    const c = checkSubmission({ lead: 'Mail riley.chen@example.com or see https://evil.example.com now' }, { results });
    expect(c.lead).not.toMatch(/@|https?:/);
  });
});

// ---------------------------------------------------------------- the bot endpoint end to end

describe('end to end through the bot endpoint', () => {
  test('mode Off (the default outside IT): the keyword card, no model call', async () => {
    state.teamsOn = new Set([2]);
    await notifications.handleActivity(message('show me all the approvals pending for me', { from: 'aad-jordan' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(gateway.runToolTurn).not.toHaveBeenCalled();
    const card = sentCards().at(-1);
    expect(cardText(card)).toMatch(/approvals waiting for you/i);
    expect(cardText(card)).toContain('TP-10422');
    expect(state.turns.at(-1)).toMatchObject({ mode: 'off', delivered: 'keyword', answerKind: 'list', outcome: 'answered' });
  });

  test('Shadow sends nothing AI-written: the person gets the keyword card, the log gets the would-be answer', async () => {
    setMode(1, 'shadow');
    gateway.runToolTurn
      .mockResolvedValueOnce(toolTurn([{ name: 'my_pending_approvals', input: { side: 'to_decide' } }]))
      .mockResolvedValueOnce(toolTurn([{ name: 'submit_answer', input: { lead: 'ZEBRA-LEAD you have 1 approval waiting.' } }]));
    await svc.handleMessage(message('show me all the approvals pending for me'), ALEX, { route: 'assistant' });
    expect(gateway.runToolTurn).toHaveBeenCalledTimes(2);
    const sent = botMock.replyToActivity.mock.calls.map((c) => JSON.stringify(c[1]));
    expect(sent.join(' ')).not.toContain('ZEBRA');
    expect(sent.some((s) => /approvals waiting for you/i.test(s))).toBe(true);
    const row = state.turns.at(-1);
    expect(row).toMatchObject({ mode: 'shadow', delivered: 'keyword', outcome: 'answered', answerKind: 'list', model: 'claude-haiku-5-5' });
    expect(row.lead).toContain('ZEBRA');
    expect(row.replySummary).not.toContain('ZEBRA');
    expect(row.toolCalls.map((c) => `${c.by}:${c.name}`)).toEqual(['keyword:my_pending_approvals', 'keyword:time_away_waiting_for_me', 'model:my_pending_approvals']);
    // The person's own history shows what they were shown, never the would-be answer.
    const mine = await settings.myTurns(ALEX);
    expect(JSON.stringify(mine)).not.toContain('ZEBRA');
  });

  test('Shadow: a failing model still leaves the person with the keyword answer', async () => {
    setMode(1, 'shadow');
    gateway.runToolTurn.mockRejectedValue(new Error('provider down'));
    await svc.handleMessage(message('my overdue stuff'), ALEX, { route: 'assistant' });
    expect(cardText(sentCards().at(-1))).toMatch(/overdue/i);
    expect(state.turns.at(-1)).toMatchObject({ mode: 'shadow', outcome: 'error', delivered: 'keyword' });
  });

  test('Pilot: listed people get live answers, everyone else is in Shadow', async () => {
    setMode(1, 'pilot', { pilotEmails: [CASEY] });
    const access = await buildAccessContext(ALEX);
    expect((await svc.modeFor(access)).mode).toBe('shadow');
    const boss = await buildAccessContext(CASEY);
    expect((await svc.modeFor(boss)).mode).toBe('live');
  });

  test('Live: the model picks the tool, the card is built from the rows, the lead passes the number check', async () => {
    setMode(1, 'on');
    gateway.runToolTurn
      .mockResolvedValueOnce(toolTurn([{ name: 'my_tickets', input: { filter: 'overdue' } }]))
      .mockResolvedValueOnce(toolTurn([{ name: 'submit_answer', input: { lead: 'You have 1 overdue ticket, TP-10422.', show: ['my_tickets'] } }]));
    await svc.handleMessage(message('my overdue stuff'), ALEX, { route: 'assistant' });
    const card = cardText(sentCards().at(-1));
    expect(card).toContain('You have 1 overdue ticket, TP-10422.');
    expect(card).toContain('VPN drops every hour');
    expect(card).toContain('https://tp.example.com/tickets/101');
    expect(card).toContain('assist.feedback');
    const call = gateway.runToolTurn.mock.calls[0][0];
    expect(call.operation).toBe('teams_assistant');
    expect(call.workspaceId).toBe(1);
    expect(call.maxTokens).toBe(600);
    expect(call.messages[0].content).toContain('<question>');
    expect(state.turns.at(-1)).toMatchObject({ mode: 'live', delivered: 'ai', outcome: 'answered', answerKind: 'list' });
    expect(state.turns.at(-1).costUsd).toBeGreaterThan(0);
  });

  test('Live: an invented number in the lead is replaced by the template line', async () => {
    setMode(1, 'on');
    gateway.runToolTurn
      .mockResolvedValueOnce(toolTurn([{ name: 'my_tickets', input: { filter: 'open' } }]))
      .mockResolvedValueOnce(toolTurn([{ name: 'submit_answer', input: { lead: 'You have 42 open tickets.' } }]));
    await svc.handleMessage(message('how many tickets do I have open'), ALEX, { route: 'assistant' });
    const card = cardText(sentCards().at(-1));
    expect(card).not.toContain('You have 42');
    expect(card).toContain('You have 3 open tickets: 1 overdue');
  });

  test('Live: the AI failing falls back to the keyword card with one line saying so', async () => {
    setMode(1, 'on');
    gateway.runToolTurn.mockRejectedValue(new Error('rate limited by provider'));
    await svc.handleMessage(message('my overdue stuff'), ALEX, { route: 'assistant' });
    const card = cardText(sentCards().at(-1));
    expect(card).toContain(NO_AI_NOTE);
    expect(card).toMatch(/overdue/i);
    expect(state.turns.at(-1)).toMatchObject({ mode: 'live', outcome: 'fallback', delivered: 'keyword' });
  });

  test('Live: tool output is fenced as data and the model gets no write tools', async () => {
    setMode(1, 'on');
    gateway.runToolTurn
      .mockResolvedValueOnce(toolTurn([{ name: 'my_tickets', input: {} }]))
      .mockResolvedValueOnce(toolTurn([{ name: 'submit_answer', input: { lead: 'Here they are.' } }]));
    await svc.handleMessage(message('my tickets please'), ALEX, { route: 'assistant' });
    const second = gateway.runToolTurn.mock.calls[1][0];
    const toolResult = second.messages.at(-1).content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.content).toMatch(/^<tool_output tool="my_tickets">/);
    const names = second.tools.map((t) => t.name);
    expect(names).toEqual(['my_pending_approvals', 'time_away_waiting_for_me', 'my_tickets', 'ticket_status', 'who_is_away', 'my_time_away', 'submit_answer']);
  });

  test('Live: a model that never submits within the budget falls back', async () => {
    setMode(1, 'on');
    gateway.runToolTurn.mockResolvedValue(toolTurn([{ name: 'my_tickets', input: {} }]));
    await svc.handleMessage(message('my tickets please'), ALEX, { route: 'assistant' });
    expect(gateway.runToolTurn).toHaveBeenCalledTimes(3);
    expect(cardText(sentCards().at(-1))).toContain(NO_AI_NOTE);
  });
});

// ---------------------------------------------------------------- the monthly cap

describe('the monthly cap', () => {
  test('at the cap the AI stops (keyword card) and the super admins are e-mailed once', async () => {
    setMode(1, 'on', { monthlyCapUsd: 25 });
    state.spend = [{ provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 250_000_000, outputTokens: 0 }]; // $25
    await svc.handleMessage(message('my overdue stuff', { id: 'a1' }), ALEX, { route: 'assistant' });
    await svc.handleMessage(message('my tickets please', { id: 'a2' }), ALEX, { route: 'assistant' });
    await new Promise((r) => setTimeout(r, 20));
    expect(gateway.runToolTurn).not.toHaveBeenCalled();
    expect(mail.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    const sent = mail.sendTransactionalEmail.mock.calls[0][0];
    expect(sent.to).toEqual([CASEY]);
    expect(sent.label).toBe('teams-assistant-cap');
    expect(sent.subject).toContain('IT');
    expect(state.settings.get(1).capAlertedMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(state.turns.map((t) => t.outcome)).toEqual(['capped', 'capped']);
    expect(cardText(sentCards().at(-1))).toMatch(/your open tickets/i);
  });

  test('the e-mail is not sent again in the same month, even after a restart', async () => {
    const { pacificMonth } = h.settingsModule;
    setMode(1, 'on', { capAlertedMonth: pacificMonth() });
    state.spend = [{ provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 300_000_000, outputTokens: 0 }];
    await svc.handleMessage(message('my overdue stuff'), ALEX, { route: 'assistant' });
    expect(mail.sendTransactionalEmail).not.toHaveBeenCalled();
    expect(gateway.runToolTurn).not.toHaveBeenCalled();
  });

  test('spend that cannot be read counts as capped (fails closed)', async () => {
    setMode(1, 'on');
    prismaMock.aiProviderAttempt.findMany.mockRejectedValueOnce(new Error('db down'));
    await svc.handleMessage(message('my overdue stuff'), ALEX, { route: 'assistant' });
    expect(gateway.runToolTurn).not.toHaveBeenCalled();
  });

  test('a raised limit is saved and clears the month\'s e-mail mark', async () => {
    setMode(1, 'on', { capAlertedMonth: '2026-11' });
    const saved = await settings.save(1, { monthlyCapUsd: 40 }, CASEY);
    expect(saved.monthlyCapUsd).toBe(40);
    expect(state.settings.get(1).capAlertedMonth).toBeNull();
    await expect(settings.save(1, { monthlyCapUsd: 0 })).rejects.toThrow(/between/);
    await expect(settings.save(1, { mode: 'everyone' })).rejects.toThrow(/Off, Shadow, Pilot or On/);
  });
});

// ---------------------------------------------------------------- the per-person switch

describe('the per-person switch "Ask Ticket Pulse in Teams (advanced)"', () => {
  const longQuestion = 'can you show me every time-off request still waiting for me to approve';

  test('on by default: the question is answered, not offered as a ticket', async () => {
    const autofill = jest.spyOn(h.intake.default, 'handleMessage').mockResolvedValue();
    await notifications.handleActivity(message(longQuestion, { from: 'aad-jordan' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(autofill).not.toHaveBeenCalled();
    expect(cardText(sentCards().at(-1))).toMatch(/time away waiting for you/i);
    autofill.mockRestore();
  });

  test('switched off: the bot behaves exactly as before (60+ characters go to Autofill)', async () => {
    await settings.setPersonEnabled(JORDAN, false);
    const autofill = jest.spyOn(h.intake.default, 'handleMessage').mockResolvedValue();
    const assistant = jest.spyOn(svc, 'handleMessage');
    await notifications.handleActivity(message(longQuestion, { from: 'aad-jordan' }));
    expect(autofill).toHaveBeenCalledTimes(1);
    expect(assistant).not.toHaveBeenCalled();
    expect(prismaMock.teamsAssistantTurn.create).not.toHaveBeenCalled();
    autofill.mockRestore();
    assistant.mockRestore();
  });

  test('switched off: a short question gets today\'s help card, nothing logged', async () => {
    await settings.setPersonEnabled(ALEX, false);
    await notifications.handleActivity(message('show me all the approvals pending for me'));
    expect(cardText(sentCards().at(-1))).toContain('Ticket Pulse is connected');
    expect(prismaMock.teamsAssistantTurn.create).not.toHaveBeenCalled();
  });

  test('the switch only changes the person\'s own row', async () => {
    expect(await settings.setPersonEnabled(ALEX, false)).toBe(false);
    expect(prismaMock.teamsAssistantPerson.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { email: ALEX } }));
    expect(await settings.personEnabled(SAM)).toBe(true);
  });

  test('"My Teams questions": only the person\'s own turns, question, answer and when', async () => {
    state.turns.push({ id: 90, email: ALEX, question: 'my tickets', replySummary: 'Your tickets — 3 open', createdAt: new Date() });
    state.turns.push({ id: 91, email: SAM, question: 'other', replySummary: 'x', createdAt: new Date() });
    const mine = await settings.myTurns(ALEX);
    expect(mine).toEqual([{ id: 90, question: 'my tickets', answer: 'Your tickets — 3 open', at: expect.any(Date) }]);
    expect(prismaMock.teamsAssistantTurn.findMany.mock.calls.at(-1)[0].where.email).toBe(ALEX);
  });
});

// ---------------------------------------------------------------- unsure, rate limit, feedback, defaults

describe('the rest of the flow', () => {
  test('unsure: the two-button card; "a request" hands the same text to Autofill', async () => {
    await notifications.handleActivity(message('the quarterly thing from last week with the vendor and the spreadsheet'));
    await new Promise((r) => setTimeout(r, 30));
    const card = sentCards().at(-1);
    expect(cardText(card)).toContain('Is this a request for IT, or a question for me?');
    const request = card.actions.find((a) => a.data?.choice === 'request');
    const autofill = jest.spyOn(h.intake.default, 'handleMessage').mockResolvedValue();
    const res = await notifications.handleActivity({ type: 'invoke', name: 'adaptiveCard/action', id: 'inv-1', serviceUrl: 'https://smba.example.com/', conversation: { id: 'conv-1' }, from: { aadObjectId: 'aad-alex' }, value: { action: { verb: request.verb, data: request.data } } });
    expect(res.type).toBe('application/vnd.microsoft.card.adaptive');
    expect(autofill).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', text: 'the quarterly thing from last week with the vendor and the spreadsheet' }), ALEX);
    autofill.mockRestore();
  });

  test('rate limit: 8 a minute, then "one moment"', async () => {
    for (let i = 0; i < 9; i += 1) await svc.handleMessage(message('my tickets please', { id: `r${i}` }), ALEX, { route: 'assistant' });
    expect(cardText(sentCards().at(-1))).toContain('One moment');
    expect(state.turns.at(-1).outcome).toBe('rate_limited');
  });

  test('feedback is stored on the person\'s own row only', async () => {
    state.turns.push({ id: 77, email: ALEX, question: 'q', createdAt: new Date() });
    await svc.handleAction('assist.feedback', { turnId: 77, value: 'not_right' }, SAM, {});
    expect(state.turns.find((t) => t.id === 77).feedback).toBeUndefined();
    await svc.handleAction('assist.feedback', { turnId: 77, value: 'not_right' }, ALEX, {});
    expect(state.turns.find((t) => t.id === 77).feedback).toBe('not_right');
  });

  test('defaults: IT in Shadow, every other workspace Off; a missing table reads as the defaults', async () => {
    expect((await settings.get(1)).mode).toBe('shadow');
    expect((await settings.get(2)).mode).toBe('off');
    expect((await settings.get(5)).mode).toBe('off');
    prismaMock.teamsAssistantSetting.findUnique.mockRejectedValueOnce(new Error('relation "teams_assistant_settings" does not exist'));
    settings.cache.clear();
    expect((await settings.get(1)).mode).toBe('shadow');
  });

  test('a duplicate Teams retry is answered once', async () => {
    const m = message('my tickets please', { id: 'dup-1' });
    await svc.handleMessage(m, ALEX, { route: 'assistant' });
    await svc.handleMessage(m, ALEX, { route: 'assistant' });
    expect(state.turns).toHaveLength(1);
  });

  test('team-safe: "who closed the most tickets" is never a ranking, with or without the AI', async () => {
    // Keyword path (Off / Shadow / capped): the fixed line, no list.
    await svc.handleMessage(message('who closed the most tickets this week', { id: 'rank-1' }), ALEX, { route: 'assistant' });
    let card = cardText(sentCards().at(-1));
    expect(card).toContain('I do not rank or compare people');
    expect(card).toContain('/analytics');
    expect(state.turns.at(-1).answerKind).toBe('refused');
    // Live: even if the model writes its own words (or a list), the fixed line wins.
    setMode(1, 'on');
    gateway.runToolTurn.mockResolvedValueOnce(toolTurn([{ name: 'submit_answer', input: { lead: 'Riley closed the most.', refuse: true } }]));
    await svc.handleMessage(message('who closed the most tickets this week', { id: 'rank-2' }), ALEX, { route: 'assistant' });
    card = cardText(sentCards().at(-1));
    expect(card).toContain('I do not rank or compare people');
    expect(card).not.toContain('Riley closed the most');
  });

  test('overdue dates are plain words in the attention colour, no emoji', async () => {
    await svc.handleMessage(message('my tickets please', { id: 'od-1' }), ALEX, { route: 'assistant' });
    const card = cardText(sentCards().at(-1));
    expect(card).toMatch(/"text":"Overdue since [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} [AP]M","wrap":false,"size":"Small","spacing":"None","color":"Attention"/);
    expect(card).not.toContain('🔥');
    expect(card).toContain('#246762');
  });

  test('the 180-day prune removes only old rows', async () => {
    state.turns.push({ id: 1, email: ALEX, question: 'old', createdAt: new Date(Date.now() - 181 * 86400_000) });
    state.turns.push({ id: 2, email: ALEX, question: 'new', createdAt: new Date() });
    expect(await settings.prune()).toBe(1);
    expect(state.turns.map((t) => t.question)).toEqual(['new']);
  });
});
