import {
  UNIT, applyPatch, buildLedger, categoryMatches, decide, normalizeSettings, onLeaveAt, periodOf, pickNext,
  previewSequence, promoteSuggestion, splitCredit, summarizeReport, toStored, validateDraft,
} from '../src/services/assignmentShares/rules.js';

/**
 * Ticket shares, the pure rules (QA 10-16 item 4). Invented people:
 * Alex (50%), Sam (20%), Jo (20%), Kit (10%) — ids 1..4.
 */
const TZ = 'America/Los_Angeles';
const A = 1; const S = 2; const J = 3; const K = 4;
const MEMBERS = [{ techId: A, pct: 50 }, { techId: S, pct: 20 }, { techId: J, pct: 20 }, { techId: K, pct: 10 }];
const NAMES = new Map([[A, 'Alex Doe'], [S, 'Sam Lee'], [J, 'Jo Park'], [K, 'Kit Moss']]);

/** Hands out tickets one at a time at the given instants, the way the service does: ledger from the tickets so far, then the pick. */
function simulate({ members = MEMBERS, instants, leavesByTech = new Map(), tickets = [] }) {
  const last = new Map();
  const picks = [];
  for (const at of instants) {
    const ledger = buildLedger({ members, tickets, leavesByTech, timeZone: TZ });
    const out = new Map(members.filter((m) => onLeaveAt(leavesByTech.get(m.techId) || [], at, TZ)).map((m) => [m.techId, 'on leave']));
    const { techId } = pickNext({ members, ledger, out, lastAssignedAt: last });
    picks.push(techId);
    if (techId) {
      tickets.push({ holderId: techId, at });
      last.set(techId, at.getTime());
    }
  }
  return picks;
}
const countOf = (picks) => picks.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map());
/** n instants, one every 20 minutes from 08:00 local on a date. */
const day = (dateStr, n = 10) => Array.from({ length: n }, (_, i) => new Date(new Date(`${dateStr}T15:00:00Z`).getTime() + i * 20 * 60 * 1000));
const vacation = (dateStr) => ({ leaveDate: new Date(`${dateStr}T00:00:00Z`), category: 'VACATION', status: 'APPROVED', isFullDay: true });

describe('shares are respected over a sequence (nobody away)', () => {
  test('QA example: 10 tickets go A S J A A K A S J A — 5/2/2/1', () => {
    const picks = previewSequence({ members: MEMBERS, ledger: new Map(), count: 10 });
    expect(picks).toEqual([A, S, J, A, A, K, A, S, J, A]);
  });

  test('100 tickets land exactly on the shares, and nobody is ever more than about one ticket off', () => {
    const instants = Array.from({ length: 100 }, (_, i) => new Date(Date.UTC(2026, 9, 13, 15, 0) + i * 60 * 1000));
    const picks = simulate({ instants });
    const counts = countOf(picks);
    expect([counts.get(A), counts.get(S), counts.get(J), counts.get(K)]).toEqual([50, 20, 20, 10]);
    const running = new Map();
    picks.forEach((id, i) => {
      running.set(id, (running.get(id) || 0) + 1);
      for (const m of MEMBERS) {
        expect(Math.abs((running.get(m.techId) || 0) - (m.pct / 100) * (i + 1))).toBeLessThanOrEqual(1);
      }
    });
  });

  test('every ticket credit adds up to exactly one ticket, the remainder to the largest share', () => {
    const credit = splitCredit([{ techId: 7, pct: 33 }, { techId: 8, pct: 33 }, { techId: 9, pct: 34 }]);
    expect([...credit.values()].reduce((a, b) => a + b, 0)).toBe(UNIT);
    expect(credit.get(9)).toBeGreaterThan(credit.get(7));
  });
});

describe('someone away', () => {
  test('Alex away Mon–Wed: the others split her half 40/40/20, and on Thursday she gets her normal 5 of 10, not a catch-up run', () => {
    const leavesByTech = new Map([[A, [vacation('2026-10-12'), vacation('2026-10-13'), vacation('2026-10-14')]]]);
    const tickets = [];
    const away = simulate({ instants: [...day('2026-10-12'), ...day('2026-10-13'), ...day('2026-10-14')], leavesByTech, tickets });
    const c1 = countOf(away);
    expect(c1.get(A)).toBeUndefined();
    expect([c1.get(S), c1.get(J), c1.get(K)]).toEqual([12, 12, 6]);

    const back = simulate({ instants: day('2026-10-15'), leavesByTech, tickets });
    const c2 = countOf(back);
    expect([c2.get(A), c2.get(S), c2.get(J), c2.get(K)]).toEqual([5, 2, 2, 1]);
    // Never a long run for the person who came back.
    let run = 0; let longest = 0;
    for (const id of back) { run = id === A ? run + 1 : 0; longest = Math.max(longest, run); }
    expect(longest).toBeLessThanOrEqual(2);
  });

  test('a part-day leave only counts during its hours; WFH is not leave', () => {
    const pm = [{ leaveDate: new Date('2026-10-13T00:00:00Z'), category: 'VACATION', status: 'APPROVED', isFullDay: false, halfDayPart: 'PM' }];
    expect(onLeaveAt(pm, new Date('2026-10-13T17:00:00Z'), TZ)).toBe(false); // 10:00 local
    expect(onLeaveAt(pm, new Date('2026-10-13T21:00:00Z'), TZ)).toBe(true); // 14:00 local
    expect(onLeaveAt([{ ...vacation('2026-10-13'), category: 'WFH' }], new Date('2026-10-13T17:00:00Z'), TZ)).toBe(false);
  });

  test('everyone away: no pick, and the AI’s pick stands', () => {
    const out = new Map(MEMBERS.map((m) => [m.techId, 'on leave']));
    const result = decide({ settings: { members: MEMBERS, period: 'week' }, ledger: new Map(), out, names: NAMES, aiPick: { techId: S } });
    expect(result.techId).toBeNull();
    expect(result.sentence).toBe('Nobody on the share list is in, so the AI’s pick stands.');
  });
});

describe('ties are deterministic', () => {
  const pair = [{ techId: 5, pct: 50 }, { techId: 6, pct: 50 }];
  test('equal shares, equal counts, never assigned: the lower id', () => {
    expect(pickNext({ members: pair, ledger: new Map() }).techId).toBe(5);
  });
  test('equal shares and counts: whoever was assigned least recently, whatever the id', () => {
    const lastAssignedAt = new Map([[5, Date.UTC(2026, 9, 14)], [6, Date.UTC(2026, 9, 10)]]);
    expect(pickNext({ members: pair, ledger: new Map(), lastAssignedAt }).techId).toBe(6);
  });
  test('equal balance: the larger share first', () => {
    // After 4 tickets A3 S1 J1 K0 (QA step 5): Alex and Kit are both half a ticket behind.
    const ledger = buildLedger({ members: MEMBERS, tickets: [A, S, J, A].map((holderId, i) => ({ holderId, at: new Date(Date.UTC(2026, 9, 13, 16, i)) })), timeZone: TZ });
    expect(pickNext({ members: MEMBERS, ledger }).techId).toBe(A);
  });
});

describe('categories', () => {
  test('a top category covers its subcategories; anything else is untouched', () => {
    expect(categoryMatches([10], { categoryId: 10, subcategoryId: 101 })).toBe(true);
    expect(categoryMatches([101], { categoryId: 10, subcategoryId: 101 })).toBe(true);
    expect(categoryMatches([101], { categoryId: 10, subcategoryId: 102 })).toBe(false);
    expect(categoryMatches([10], { categoryId: 11, subcategoryId: null })).toBe(false);
    expect(categoryMatches([], { categoryId: 10 })).toBe(false);
  });
});

describe('periods (workspace time zone, week starts Monday)', () => {
  test('Sunday 23:30 local is still last week; Monday 00:10 starts a new one', () => {
    expect(periodOf(new Date('2026-10-19T06:30:00Z'), 'week', TZ).startDate).toBe('2026-10-12');
    expect(periodOf(new Date('2026-10-19T07:10:00Z'), 'week', TZ).startDate).toBe('2026-10-19');
  });
  test('the clock change on 1 Nov 2026: each week starts at local midnight', () => {
    expect(periodOf(new Date('2026-10-28T12:00:00Z'), 'week', TZ).start.toISOString()).toBe('2026-10-26T07:00:00.000Z');
    expect(periodOf(new Date('2026-11-03T12:00:00Z'), 'week', TZ).start.toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });
  test('a month starts on the 1st', () => {
    const p = periodOf(new Date('2026-10-16T18:00:00Z'), 'month', TZ);
    expect(p.key).toBe('2026-10');
    expect(p.start.toISOString()).toBe('2026-10-01T07:00:00.000Z');
  });
});

describe('settings', () => {
  test('nothing stored: off, weekly, nobody, no categories', () => {
    expect(normalizeSettings(null)).toMatchObject({ mode: 'off', period: 'week', members: [], categoryIds: [] });
    expect(normalizeSettings('not json')).toMatchObject({ mode: 'off' });
  });

  test('cannot save unless the shares total 100', () => {
    const errors = validateDraft({ mode: 'shadow', period: 'week', categoryIds: [10], members: [{ techId: 1, pct: 50 }, { techId: 2, pct: 40 }] });
    expect(errors).toContain('The shares must total 100% (now 90%)');
  });

  test('switching it on needs people and a category', () => {
    expect(validateDraft({ mode: 'live', period: 'week', categoryIds: [], members: MEMBERS })).toContain('Pick at least one category before switching it on');
    expect(validateDraft({ mode: 'shadow', period: 'week', categoryIds: [10], members: [] })).toContain('Add the people who share the tickets before switching it on');
    expect(validateDraft({ mode: 'off', period: 'week', categoryIds: [], members: [] })).toEqual([]);
  });

  test('people and categories must belong to the workspace', () => {
    const errors = validateDraft(
      { mode: 'shadow', period: 'week', categoryIds: [99], members: MEMBERS },
      { validTechIds: new Set([1, 2, 3]), validCategoryIds: new Set([10]) },
    );
    expect(errors).toEqual(expect.arrayContaining([
      'Someone on the list is not an active member of this workspace',
      'A category is not one of this workspace’s categories',
    ]));
  });

  test('a save keeps one history line and stamps when Shadow began', () => {
    const now = new Date('2026-10-16T18:00:00Z');
    const { next, changes, errors } = applyPatch(normalizeSettings(null), { mode: 'shadow', categoryIds: [10], members: MEMBERS }, { by: 'Alex Doe', now });
    expect(errors).toEqual([]);
    expect(changes.map((c) => c.field)).toEqual(['mode', 'categoryIds', 'members']);
    expect(next).toMatchObject({ mode: 'shadow', enabledSince: now.toISOString(), updatedBy: 'Alex Doe' });
    expect(next.history).toHaveLength(1);
    expect(toStored(next)).toMatchObject({ v: 1, mode: 'shadow', categoryIds: [10] });
  });
});

describe('Live in a suggest-only workspace', () => {
  test('the rule’s pick is first, the AI’s own first choice second, ranks renumbered', () => {
    const ai = [
      { rank: 1, techId: S, techName: 'Sam Lee', score: 0.9, reasoning: 'Did the last three.' },
      { rank: 2, techId: J, techName: 'Jo Park', score: 0.7, reasoning: 'Knows the client.' },
    ];
    const list = promoteSuggestion(ai, { techId: J, techName: 'Jo Park', reason: 'furthest below their share this week (1 against about 1.6)', aiPick: { techId: S, techName: 'Sam Lee' } });
    expect(list.map((r) => [r.rank, r.techId])).toEqual([[1, J], [2, S]]);
    expect(list[0]).toMatchObject({ source: 'share_rule', score: 0.7 });
    expect(list[0].reasoning).toMatch(/^Share rule: furthest below their share this week .* The AI’s own first choice was Sam Lee\. Knows the client\.$/);
  });

  test('the sentence agents can see never lists everyone’s counts', () => {
    const ledger = buildLedger({ members: MEMBERS, tickets: [], timeZone: TZ });
    const result = decide({ settings: { members: MEMBERS, period: 'week' }, ledger, names: NAMES });
    expect(result.techId).toBe(A);
    expect(result.reason).toBe('furthest below their share this week (0 against about 0.5)');
    expect(result.people).toHaveLength(4);
  });
});

describe('the Shadow report', () => {
  test('rows by share (never by count), what each got, and how often the rule matched', () => {
    const tickets = [
      { id: 1, holderId: S }, { id: 2, holderId: S }, { id: 3, holderId: S }, { id: 4, holderId: A },
      { id: 5, holderId: 99 }, { id: 6, holderId: null },
    ];
    const runs = [
      { ticketId: 1, holderId: S, share: { pick: { techId: S }, aiPick: { techId: A } } },
      { ticketId: 2, holderId: S, share: { pick: { techId: A }, aiPick: { techId: S } } },
      { ticketId: 4, holderId: A, share: { pick: { techId: A }, aiPick: { techId: A } } },
      { ticketId: 6, holderId: null, share: { pick: { techId: J } } },
    ];
    const { rows, totals } = summarizeReport({ members: MEMBERS, tickets, runs, names: NAMES });
    expect(rows.map((r) => r.name)).toEqual(['Alex Doe', 'Jo Park', 'Sam Lee', 'Kit Moss']);
    expect(rows.find((r) => r.techId === S)).toMatchObject({ pct: 20, got: 3, gotPct: 75, rulePicked: 1, ruleMatched: 1 });
    expect(rows.find((r) => r.techId === A)).toMatchObject({ got: 1, gotPct: 25, rulePicked: 2, ruleMatched: 1 });
    expect(totals).toMatchObject({ tickets: 6, toMembers: 4, outside: 1, unassigned: 1, compared: 3, agreed: 2, aiCompared: 3, aiAgreed: 2 });
  });
});
