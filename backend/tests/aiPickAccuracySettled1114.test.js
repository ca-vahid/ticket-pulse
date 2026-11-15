import { jest } from '@jest/globals';
import {
  computePickAccuracy, fetchPickInputs, SUGGEST_DECISIONS, reviewAnswerOf,
} from '../src/services/aiPickAccuracy.js';

/**
 * MEGA 11-14 Part B: "How often the AI's pick stands" after the review queue
 * started settling itself. A suggestion settled because someone took the
 * ticket ('settled_elsewhere') is the same case as one left pending: the AI
 * suggested, nobody answered, someone else did the ticket. It stays in the
 * panel, under "not answered" — leaving it out would drop exactly the
 * suggest-mode tickets a person took by hand.
 */
const START = new Date('2026-10-14T07:00:00Z');
const END = new Date('2026-11-14T07:59:59Z');
const NOW = new Date('2026-11-14T20:00:00Z');
const NAMES = new Map([[1, 'Alex Rivera'], [2, 'Sam Ortiz'], [3, 'Jordan Lee']]);
const at = (iso) => new Date(iso);

let id = 500;
const suggestion = (ticketId, decision) => ({
  id: id++, ticketId, decision, triggerSource: 'webhook', isRebound: false, assignedTechId: null,
  createdAt: at('2026-10-20T16:00:00Z'), pickIds: [1, 2],
});
const ticket = (tid, owner) => ({
  id: tid, displayRef: `TP-${tid}`, subject: `Ticket ${tid}`, status: 'Closed', isNoise: false,
  assignedTechId: owner, assignedAt: at('2026-10-20T16:30:00Z'), category: 'Invoices',
});
const episode = (tid, techId) => ({
  ticketId: tid, technicianId: techId, startedAt: at('2026-10-20T16:30:00Z'), endedAt: at('2026-10-21T16:00:00Z'),
  startMethod: 'self_picked', startAssignedByName: null, endMethod: 'closed', endActorName: null,
});
const compute = (inputs) => computePickAccuracy({
  techNames: NAMES, terminalStatuses: ['Resolved', 'Closed'], serviceAccountNames: ['Ticket Pulse'],
  start: START, end: END, now: NOW, ...inputs,
});

test('settled is a suggestion: counted, and read as "not answered"', () => {
  expect(SUGGEST_DECISIONS).toContain('settled_elsewhere');
  expect(reviewAnswerOf('settled_elsewhere')).toBe('pending_review');
  expect(reviewAnswerOf('approved')).toBe('approved');
});

test('settling changes no number: pending and settled give the same panel', () => {
  const tickets = [ticket(1, 1), ticket(2, 3)];
  const episodes = [episode(1, 1), episode(2, 3)];
  id = 500;
  const before = compute({ runs: [suggestion(1, 'pending_review'), suggestion(2, 'pending_review')], tickets, episodes });
  id = 500;
  const after = compute({ runs: [suggestion(1, 'settled_elsewhere'), suggestion(2, 'settled_elsewhere')], tickets, episodes });
  expect(after.suggest.tickets).toBe(2);
  expect(after.suggest.firstChoice.n).toBe(1);
  expect(after.suggest.inList.n).toBe(1);
  expect(after.suggest.review).toEqual({ of: 2, approvedAsIs: 0, changedInReview: 0, rejected: 0, notAnswered: 2 });
  expect(after.suggest).toEqual(before.suggest);
});

test('the read asks for settled runs too', async () => {
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    ticket: { findMany: jest.fn() },
  };
  await fetchPickInputs(db, { workspaceId: 2, start: START, end: END });
  const sql = db.$queryRaw.mock.calls[0][0].join(' ');
  expect(sql).toMatch(/c\.decision IN \('auto_assigned', 'pending_review', 'settled_elsewhere', 'approved', 'modified', 'rejected'\)/);
});
