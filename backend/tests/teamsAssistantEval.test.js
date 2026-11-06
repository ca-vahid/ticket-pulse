import { jest } from '@jest/globals';
import { setupAssistant, toolTurn, message, ALEX, JORDAN, CASEY } from './helpers/teamsAssistantHarness.js';
import { EVAL_CASES, PILOT_PASS_MARK, scoreCase } from './fixtures/teamsAssistantEval.js';

/**
 * The 30-case eval set (plans/TEAMS_BOT_COMMANDS_PLAN.md) run end to end with
 * MOCKED model responses: the "model" replays each case's expected tool calls
 * and submit_answer. No real model is called. What this proves is the server
 * side: the tools run as the asker, the plan checks hold, confirm ids come
 * from earlier results, refusals and Autofill offers render, nothing writes.
 * P3 replaces the replay with recorded real-model answers and keeps the scorer.
 */

const h = await setupAssistant();
const { svc, state, gateway, approvals, settings } = h;
const PEOPLE = { alex: ALEX, jordan: JORDAN, casey: CASEY };

function replay(c) {
  const turns = [];
  if (c.expected.length) turns.push(toolTurn(c.expected.map((e) => ({ name: e.tool, input: e.input }))));
  turns.push(toolTurn([{ name: 'submit_answer', input: c.submit }]));
  gateway.runToolTurn.mockReset();
  for (const t of turns) gateway.runToolTurn.mockResolvedValueOnce(t);
}

async function ask(c, conversation) {
  replay(c);
  const before = state.turns.length;
  const out = await svc.answer({ text: c.message, email: PEOPLE[c.who], conversationId: conversation, activity: message(c.message, { conversation }) });
  const row = state.turns.slice(before).at(-1);
  return { out, row };
}

beforeAll(() => {
  // Every workspace On for the eval: live answers for everyone.
  for (const ws of [1, 2]) state.settings.set(ws, { workspaceId: ws, mode: 'on', pilotEmails: [], monthlyCapUsd: 25, sensitive: false });
});

const scores = [];

describe('the 30-case eval set (mocked model responses)', () => {
  beforeEach(() => {
    settings.cache.clear();
    settings.spend.clear();
    svc.hits.clear();
  });

  test.each(EVAL_CASES.map((c) => [c.n, c.message, c]))('#%i %s', async (_n, _m, c) => {
    const conversation = `eval-${c.n}`;
    let seenIds = [];
    if (c.after) {
      const prior = EVAL_CASES.find((x) => x.n === c.after);
      const first = await ask(prior, conversation);
      seenIds = first.row.shownIds || [];
    }
    const { out, row } = await ask(c, conversation);
    const cardJson = JSON.stringify(out.card);
    const modelCalls = (row.toolCalls || []).filter((x) => x.by === 'model');
    const wrongPerson = /Someone else's ticket|Purchase order for Riley/.test(cardJson)
      || (c.who !== 'casey' && /Alex Rivera — Vacation/.test(cardJson));
    const wrote = approvals.decideInApp.mock.calls.length > 0;
    const confirmId = c.submit.confirm?.id || null;
    const score = scoreCase(c, { modelCalls, kind: row.answerKind, cardJson, wrongPerson, wrote, confirmId, seenIds: [...seenIds, ...(row.shownIds || [])] });
    scores.push({ n: c.n, ...score });
    if (c.expect.approvalCard) {
      // The existing approval card, with its own two-step confirm.
      expect(cardJson).toContain('approval.prepare');
    }
    if (c.expect.firstRow) {
      const rows = (out.card.body.find((b) => b.id === 's0')?.items || []).filter((i) => i.type === 'ColumnSet');
      expect(JSON.stringify(rows[0])).toContain(c.expect.firstRow);
    }
    expect(score).toMatchObject({ toolsOk: true, kindOk: true, cardOk: true, confirmOk: true, wrongPerson: false, wrote: false });
    expect(row.mode).toBe('live');
    expect(row.delivered).toBe('ai');
  });

  test('pass mark: at least 27 of 30, no wrong-person rows, no write', () => {
    expect(scores).toHaveLength(30);
    expect(scores.filter((s) => s.pass).length).toBeGreaterThanOrEqual(PILOT_PASS_MARK);
    expect(scores.some((s) => s.wrongPerson || s.wrote)).toBe(false);
  });

  test('a model that names an id it never saw gets no approval card', async () => {
    const c = { n: 99, who: 'alex', message: 'approve the first one', expected: [], submit: { lead: 'Here.', confirm: { kind: 'approval', id: 'approval:20' } }, expect: {} };
    const { out, row } = await ask(c, 'eval-forged');
    expect(JSON.stringify(out.card)).not.toContain('approval.prepare');
    expect(row.answerKind).not.toBe('confirm');
  });

  test('no model call is ever made outside the mock', () => {
    expect(jest.isMockFunction(gateway.runToolTurn)).toBe(true);
  });
});
