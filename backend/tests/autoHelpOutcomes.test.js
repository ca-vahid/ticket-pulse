/**
 * Auto-help P1 pure maths (plans/AUTO_HELP_P1_PLAN.md §1–3): edit distance,
 * the reply classifier's keyword fast path (both ways), the readiness gate
 * criterion by criterion, and the per-playbook metrics (always with N).
 */
import {
  classifyReplyFast, editDistance, evaluateReadiness, median, ownWords, playbookMetrics, READINESS, monthStartUtc, isAutoReplyEntry,
} from '../src/services/autoHelpOutcomes.js';

describe('editDistance (normalized, word level)', () => {
  test('same words = 0, whitespace / case / punctuation ignored', () => {
    expect(editDistance('Open Company Portal.', 'open   company portal')).toBe(0);
    expect(editDistance('', '')).toBe(0);
  });
  test('one word changed out of four = 0.25; nothing kept = 1', () => {
    expect(editDistance('open the company portal', 'open the software portal')).toBe(0.25);
    expect(editDistance('a b c', '')).toBe(1);
    expect(editDistance('install it', 'call the service desk')).toBe(1);
  });
  test('an added sentence moves it proportionally', () => {
    const d = editDistance('Open Company Portal and choose Install.', 'Open Company Portal and choose Install. Restart after.');
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.4);
  });
});

describe('reply classifier — keyword fast path', () => {
  test.each([
    'Thanks, that worked!',
    'All sorted now, thank you',
    'All sorted now, cheers',
    'Fixed, thanks a lot',
    'Fixed, thank you',
    'Works now, thanks!',
    'That worked, thanks',
  ])('confirmed (allow-listed whole reply): %s', (text) => {
    expect(classifyReplyFast(text)).toBe('confirmed');
  });

  // The audit's list: every one of these used to read as "confirmed" and
  // close the ticket. The fast path must never confirm them — it defers
  // (null) and the model / a person decides.
  test.each([
    'Not yet fixed',
    'Never fixed',
    'Hasn\'t resolved it',
    'I don\'t think it\'s fixed',
    'Sorry, not really sorted',
    'It worked yesterday, now broken again',
    'It works for my colleague, not me',
    'Still not working, same error',
    'I tried that but it didn\'t work',
    'It crashes when I open it',
    'No luck — Company Portal doesn\'t show the app',
    'Not fixed yet',
    'Fixed? No.',
    'Resolved the error message but the app still fails',
    'It works now, thanks. Unfortunately the printer has an issue too',
    'That worked but only on my laptop',
    'Thanks that worked!!! ... nope, it failed again',
    'perfect, problem solved',
    'Sorted — could you help with Outlook as well',
    // Round 2 re-audit: each of these used to confirm.
    'Please close the other ticket, this one isnt fixed',
    'it worked on my laptop, phone wont connect',
    'It worked for 5 minutes then stopped',
    'That fixed it for Outlook. Teams crashes',
    'Installed it. Crashes on launch',
    'Fixed! Actually it came back',
    'It works now; wait, it just froze',
    // Positive but not a bare confirmation: the model decides.
    'It works now. You can close this.',
    'Installed it, up and running',
    'That worked on the second try',
  ])('never confirmed by keywords (defers to the model): %s', (text) => {
    expect(classifyReplyFast(text)).toBeNull();
  });

  test('a long reply never takes the fast path, even when positive', () => {
    expect(classifyReplyFast(`That worked. ${'I followed every step in the article and it installed without any trouble at all. '.repeat(3)}`)).toBeNull();
  });

  test.each([
    'Thanks, I\'ll try that tomorrow',
    'Thank you',
    'It works, but how do I activate the licence?',
    'Where do I find Company Portal?',
  ])('unclear → the model decides: %s', (text) => {
    expect(classifyReplyFast(text)).toBeNull();
  });

  test('quoted history is not the requester\'s words', () => {
    const reply = 'Thanks, that worked!\n\nOn Tue, 29 Sep 2026 at 10:00, IT <it@x.ca> wrote:\n> still not working? reply and a person will help';
    expect(ownWords(reply)).toBe('Thanks, that worked!');
    expect(classifyReplyFast(reply)).toBe('confirmed');
  });

  test('Gmail\'s wrapped "On … wrote:" line is cut (the quoted answer\'s "not"/"help" do not count)', () => {
    const reply = 'All sorted now, cheers\n\nOn Fri, 9 Oct 2026 at 10:00, Ticket Pulse (IT) <\nit-support@example.com> wrote:\n\nDid this sort it out? Just reply if you still need a hand — not fixed? a person will help.';
    expect(ownWords(reply)).toBe('All sorted now, cheers');
    expect(classifyReplyFast(reply)).toBe('confirmed');
  });

  test('Outlook header block is cut; a negative ABOVE the quote still defers', () => {
    const quoted = '\n\nFrom: IT Support <it@example.com>\nSent: Friday, October 9, 2026 10:00 AM\nTo: Pat <pat@example.com>\nSubject: RE: Install Bluebeam\n\nIf it is still not working, reply.';
    expect(ownWords(`Thanks, that worked!${quoted}`)).toBe('Thanks, that worked!');
    expect(classifyReplyFast(`Thanks, that worked!${quoted}`)).toBe('confirmed');
    expect(classifyReplyFast(`Not yet fixed${quoted}`)).toBeNull();
    // A "From:" line that is not a header block is the requester's own words.
    expect(ownWords('From: my home laptop it is still broken\nthanks')).toContain('still broken');
  });

  test('"-----Original Message-----" and "Sent from my iPhone" are cut too', () => {
    expect(ownWords('Fixed, thanks\nSent from my iPhone')).toBe('Fixed, thanks');
    expect(ownWords('Fixed, thanks\n-----Original Message-----\nnot working')).toBe('Fixed, thanks');
  });
});

describe('readiness gate', () => {
  const at = (i) => new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString();
  const reviews = (good, other = [], offset = 0) => [
    ...Array.from({ length: good }, (_, i) => ({ verdict: 'good', reviewedAt: at(i + offset) })),
    ...other.map((v, i) => ({ verdict: v, reviewedAt: at(good + i + offset) })),
  ];
  const approve = { sends: 20, unchanged: 14, reopened: 1 };

  test('all met: 30 reviewed ≥85 % good, no recent wrong; 20 sends ≥70 % unchanged, reopen ≤5 %; not sensitive', () => {
    const r = evaluateReadiness({ reviews: reviews(30), approve, sensitive: false });
    expect(r.met).toBe(true);
    expect(r.criteria.every((c) => c.met)).toBe(true);
    expect(r.criteria.find((c) => c.key === 'unchanged')).toMatchObject({ value: 70, n: 20 });
    expect(r.criteria.find((c) => c.key === 'reopen')).toMatchObject({ value: 5, n: 20 });
  });

  test('29 reviewed is not enough', () => {
    const r = evaluateReadiness({ reviews: reviews(29), approve });
    expect(r.met).toBe(false);
    expect(r.criteria.find((c) => c.key === 'reviewed')).toMatchObject({ met: false, value: 29, target: 30 });
  });

  test('84 % good fails; exactly 85 % passes', () => {
    // 21 good + 4 partial = 84 %
    const low = evaluateReadiness({ reviews: reviews(21, ['partial', 'partial', 'partial', 'partial']).concat(reviews(0)), approve });
    expect(low.criteria.find((c) => c.key === 'good').met).toBe(false);
    // 34 good + 6 partial = 85 %
    const ok = evaluateReadiness({ reviews: reviews(34, Array(6).fill('partial')), approve });
    expect(ok.criteria.find((c) => c.key === 'good')).toMatchObject({ met: true, value: 85 });
  });

  test('one "wrong" in the newest 30 fails; the same wrong older than that does not', () => {
    const recentWrong = evaluateReadiness({ reviews: reviews(40, ['wrong']), approve });
    expect(recentWrong.criteria.find((c) => c.key === 'no_recent_wrong')).toMatchObject({ met: false, value: 1 });
    // wrong first (oldest), then 40 good after it
    const oldWrong = [{ verdict: 'wrong', reviewedAt: at(0) }, ...reviews(40, [], 1)];
    const r = evaluateReadiness({ reviews: oldWrong, approve });
    expect(r.criteria.find((c) => c.key === 'no_recent_wrong').met).toBe(true);
    expect(r.met).toBe(true);
  });

  test('approve evidence: 19 sends, 65 % unchanged, 10 % reopen each fail on their own', () => {
    expect(evaluateReadiness({ reviews: reviews(30), approve: { sends: 19, unchanged: 19, reopened: 0 } }).criteria.find((c) => c.key === 'approve_sends').met).toBe(false);
    expect(evaluateReadiness({ reviews: reviews(30), approve: { sends: 20, unchanged: 13, reopened: 0 } }).criteria.find((c) => c.key === 'unchanged').met).toBe(false);
    expect(evaluateReadiness({ reviews: reviews(30), approve: { sends: 20, unchanged: 20, reopened: 2 } }).criteria.find((c) => c.key === 'reopen').met).toBe(false);
  });

  test('sensitive blocks auto whatever the evidence', () => {
    const r = evaluateReadiness({ reviews: reviews(50), approve: { sends: 50, unchanged: 50, reopened: 0 }, sensitive: true });
    expect(r.met).toBe(false);
    expect(r.criteria.find((c) => c.key === 'not_sensitive').met).toBe(false);
  });

  test('no evidence at all is not met (no division by zero)', () => {
    const r = evaluateReadiness({});
    expect(r.met).toBe(false);
    expect(r.criteria.find((c) => c.key === 'good').value).toBeNull();
  });

  test('the bar is the plan\'s', () => {
    expect(READINESS).toMatchObject({ minReviewed: 30, minGoodPct: 85, minApproveSends: 20, minUnchangedPct: 70, maxReopenPct: 5 });
  });
});

describe('playbookMetrics', () => {
  const row = (over) => ({ ticketId: 1, createdAt: new Date('2026-09-20T00:00:00Z'), gateDecision: 'staged_for_agent', ...over });
  test('sent, outcomes with %, approve decisions with median edit distance, CSAT with N, cost', () => {
    const rows = [
      row({ ticketId: 1, decision: 'agent_sent', outcome: 'resolved_silence', costUsd: 0.01, inputTokens: 1000, outputTokens: 200 }),
      row({ ticketId: 2, decision: 'agent_sent', outcome: 'resolved_confirmed', costUsd: 0.03 }),
      row({ ticketId: 3, decision: 'agent_edited_sent', editDistance: 0.1, outcome: 'help_requested', costUsd: 0.02 }),
      row({ ticketId: 4, decision: 'agent_edited_sent', editDistance: 0.3, outcome: 'reopened' }),
      row({ ticketId: 5, decision: 'agent_dismissed', dismissReason: 'wrong_answer' }),
      row({ ticketId: 6, decision: 'agent_sent', outcome: null }),
      row({ ticketId: 7, gateDecision: 'shadow_recorded', reviewVerdict: 'good', reviewedAt: new Date() }),
    ];
    const csat = new Map([[1, { score: 4, total: 4 }], [2, { score: 3, total: 4 }], [3, { score: 1, total: 4 }]]);
    const m = playbookMetrics(rows, { csatByTicket: csat, monthStart: new Date('2026-09-01T00:00:00Z') });
    expect(m.sent).toBe(5);
    expect(m.waiting).toBe(1);
    expect(m.outcomes.resolved_silence).toEqual({ n: 1, pct: 20 });
    expect(m.outcomes.reopened).toEqual({ n: 1, pct: 20 });
    expect(m.approve.decided).toBe(6);
    expect(m.approve.unchanged).toEqual({ n: 3, pct: 50 });
    expect(m.approve.edited.medianEditDistance).toBe(0.2);
    expect(m.approve.dismissed.reasons.wrong_answer).toBe(1);
    // CSAT only on tickets Auto-help resolved: tickets 1 and 2 (ticket 3 asked for help).
    expect(m.csat).toEqual({ n: 2, avg: 3.5, outOf: 4, satisfied: 2 });
    expect(m.cost).toMatchObject({ runsWithCost: 3, totalUsd: 0.06, perRunUsd: 0.02, monthUsd: 0.06, inputTokens: 1000, outputTokens: 200 });
    expect(m.readiness.met).toBe(false);
  });

  test('median of nothing is null; month start is UTC', () => {
    expect(median([])).toBeNull();
    expect(monthStartUtc(new Date('2026-09-26T05:00:00Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('Auto-help actor kind', () => {
  test('Auto-help rows are their own visible kind, not "human"', async () => {
    const { actorKindOf, deriveActorKind, isMachineActorKind } = await import('../src/utils/actorKind.js');
    expect(actorKindOf({ name: 'Ticket Pulse (Auto-help)', email: null, role: 'automation' })).toBe('auto_help');
    expect(deriveActorKind({ performedBy: 'Ticket Pulse (Auto-help)', activityType: 'auto_help_nudged', details: {} })).toBe('auto_help');
    expect(isMachineActorKind('auto_help')).toBe(false);
  });
});

describe('isAutoReplyEntry (out-of-office never counts as an answer)', () => {
  test.each([
    [{ title: 'Automatic reply: Install Bluebeam', bodyText: '' }],
    [{ title: 'Out of Office: RE: Install', bodyText: 'Out of Office: back on the 20th' }],
    [{ bodyText: 'Thank you for your email. I am currently out of the office until 21 October 2026 with limited access to email. For urgent matters please contact the IT desk. Kind regards, Pat Doe' }],
    [{ bodyText: 'I am out of the office until 12 October with limited access to e-mail.' }],
    [{ bodyText: 'On leave until Monday 19 Oct. For urgent matters contact Sam.' }],
    [{ rawPayload: { headers: { 'Auto-Submitted': 'auto-replied' } }, bodyText: 'x' }],
    [{ rawPayload: { 'X-Autoreply': 'yes' }, bodyText: 'x' }],
    [{ rawPayload: { precedence: 'auto_reply' }, bodyText: 'x' }],
  ])('auto-reply: %j', (entry) => { expect(isAutoReplyEntry(entry)).toBe(true); });

  test.each([
    [{ bodyText: 'Thanks, that worked!' }],
    [{ bodyText: 'I am away until Monday but it is still not working' }],
    [{ bodyText: 'I am on leave until Monday. It is still broken.' }],
    [{ title: 'RE: Install Bluebeam', bodyText: 'out of office? no, I am here and it is broken' }],
    [{ rawPayload: { headers: { 'Auto-Submitted': 'no' } }, bodyText: 'Not yet fixed' }],
    // Round 4 probes: real replies that open with out-of-office wording.
    [{ bodyText: 'I am on leave until Friday, can someone else test it' }],
    [{ bodyText: "I'm away until Monday so I'll try it then" }],
    [{ bodyText: "I'm out of the office until Monday. The printer works now, thanks." }],
    [{ title: 'Re: Absence calendar sync', bodyText: 'Still broken' }],
    // A subject alone never suffices when the body has content.
    [{ title: 'Automatic reply: Install Bluebeam', bodyText: 'Thanks, that worked!' }],
  ])('a person: %j', (entry) => { expect(isAutoReplyEntry(entry)).toBe(false); });
});
