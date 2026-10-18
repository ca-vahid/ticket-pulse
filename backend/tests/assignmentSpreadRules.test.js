/**
 * Assignment spread — the rules (QA 10-13 item 17). Pure: no database.
 *
 * Vahid's decision: A + B at 3 tickets in 10 minutes; D only for a new hire's
 * Workstation + Laptop/Desktop; F; and every number a setting.
 */
const {
  RULES, LIMITS, NEW_HIRE_SET_KEYS,
  defaultSettings, normalizeSettings, applyPatch, toStored, isNewHireSetKey, unitKeyFor, recentByTech, decide, recordFor,
  orderForRelease, releaseAllowance, dayIn, largestBurst, releaseOfDay, summarize,
} = await import('../src/services/assignmentSpread/rules.js');

const NOW = new Date('2026-10-14T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);
const on = (extra = {}) => ({ ...normalizeSettings({ enabled: true }, 5), ...extra });
const given = (techId, minutes, extra = {}) => ({ techId, at: minutesAgo(minutes), ticketId: extra.ticketId ?? Math.round(minutes * 1000) + techId, ...extra });

describe('settings', () => {
  test('IT starts on with 3 in 10 minutes; every other workspace starts off', () => {
    expect(defaultSettings(1)).toMatchObject({
      enabled: true, countRecent: true, recentWindowMinutes: 10, capEnabled: true, capCount: 3, capWindowMinutes: 10,
      keepNewHireSet: true, staggerEnabled: true, staggerCount: 2, staggerMinutes: 2,
    });
    expect(defaultSettings(2).enabled).toBe(false);
    expect(defaultSettings(5).enabled).toBe(false);
    expect(normalizeSettings(null, 1)).toMatchObject({ enabled: true, persisted: false, history: [] });
    expect(normalizeSettings(undefined, 2)).toMatchObject({ enabled: false, persisted: false });
  });

  test('a stored row wins over the default, also to turn IT off', () => {
    expect(normalizeSettings(JSON.stringify({ enabled: false }), 1).enabled).toBe(false);
    expect(normalizeSettings({ enabled: true, capCount: 5 }, 2)).toMatchObject({ enabled: true, capCount: 5, persisted: true });
  });

  test('rubbish in the store never breaks a decision: defaults, numbers pulled into range', () => {
    expect(normalizeSettings('not json', 2)).toMatchObject({ enabled: false, capCount: 3 });
    expect(normalizeSettings([1, 2], 2).capCount).toBe(3);
    expect(normalizeSettings({ capCount: 'abc', capWindowMinutes: 9999, staggerCount: 0, enabled: 'yes' }, 2)).toMatchObject({
      capCount: 3, capWindowMinutes: LIMITS.capWindowMinutes.max, staggerCount: LIMITS.staggerCount.min, enabled: false,
    });
  });

  test('a save keeps who, when and what changed; a bad number is refused, not quietly clamped', () => {
    const current = normalizeSettings(null, 1);
    const bad = applyPatch(current, { capCount: 0, staggerMinutes: 1.5, enabled: 'on' }, { by: 'Vahid', now: NOW });
    expect(bad.errors).toHaveLength(3);
    expect(bad.next).toBe(current);

    const ok = applyPatch(current, { capCount: 4, capWindowMinutes: 15, somethingElse: 1 }, { by: 'Vahid', now: NOW });
    expect(ok.errors).toEqual([]);
    expect(ok.changes).toEqual([{ field: 'capCount', from: 3, to: 4 }, { field: 'capWindowMinutes', from: 10, to: 15 }]);
    expect(ok.next).toMatchObject({ capCount: 4, capWindowMinutes: 15, updatedBy: 'Vahid', updatedAt: NOW.toISOString(), enabledSince: NOW.toISOString() });
    expect(ok.next.history[0]).toEqual({ at: NOW.toISOString(), by: 'Vahid', changes: ok.changes });
    expect(ok.next.somethingElse).toBeUndefined();
  });

  test('turning the rules off and on again restarts "on since"; a save with no change adds no history', () => {
    const start = applyPatch(normalizeSettings(null, 2), { enabled: true }, { by: 'A', now: minutesAgo(60) }).next;
    expect(start.enabledSince).toBe(minutesAgo(60).toISOString());
    const same = applyPatch(start, { enabled: true }, { by: 'A', now: NOW });
    expect(same.changes).toEqual([]);
    expect(same.next.history).toHaveLength(1);
    expect(same.next.enabledSince).toBe(minutesAgo(60).toISOString());
    const off = applyPatch(start, { enabled: false }, { by: 'A', now: NOW }).next;
    expect(off.enabledSince).toBeNull();
  });

  test('what is stored has no derived fields and comes back the same', () => {
    const saved = applyPatch(normalizeSettings(null, 2), { enabled: true, capCount: 2 }, { by: 'A', now: NOW }).next;
    const stored = toStored(saved);
    expect(stored.persisted).toBeUndefined();
    expect(normalizeSettings(JSON.stringify(stored), 2)).toMatchObject({ enabled: true, capCount: 2, updatedBy: 'A', persisted: true });
  });
});

describe('D. a new hire\'s set is one unit — and nothing else is', () => {
  test('only Workstation and Laptop/Desktop children are a set', () => {
    for (const key of ['laptop', 'workstation', 'desktop', 'nh_laptop', 'NH_Workstation']) expect(isNewHireSetKey(key)).toBe(true);
    for (const key of ['accounts', 'badge', 'phone', 'software', '', null, undefined]) expect(isNewHireSetKey(key)).toBe(false);
    expect(NEW_HIRE_SET_KEYS).not.toContain('accounts');
  });

  test('both tickets of one new hire share a unit; with the rule off each ticket is its own', () => {
    expect(unitKeyFor(11, { familyId: 7 })).toBe('set:7');
    expect(unitKeyFor(12, { familyId: 7 })).toBe('set:7');
    expect(unitKeyFor(11, { familyId: 7, keepNewHireSet: false })).toBe('ticket:11');
    expect(unitKeyFor(13)).toBe('ticket:13');
  });
});

describe('A. what was just assigned', () => {
  test('counts only inside the window, per person, and a set once', () => {
    const recent = recentByTech([
      given(5, 1), given(5, 4), given(5, 11),
      given(6, 2, { unitKey: 'set:7', ticketId: 100 }), given(6, 3, { unitKey: 'set:7', ticketId: 101 }), given(6, 5),
    ], { now: NOW, windowMinutes: 10 });
    expect(recent.get(5).count).toBe(2);
    expect(recent.get(6).count).toBe(2);
    expect(recent.get(6).units.has('set:7')).toBe(true);
    expect(recent.get(9)).toBeUndefined();
  });

  test('the ones still being saved are counted and told apart', () => {
    const recent = recentByTech([given(5, 1, { saved: false }), given(5, 2, { saved: true }), given(5, 3)], { now: NOW, windowMinutes: 10 });
    expect(recent.get(5)).toMatchObject({ count: 3, notSaved: 1 });
  });

  test('the ticket being decided never counts against itself; bad rows are ignored', () => {
    const recent = recentByTech([given(5, 1, { ticketId: 42 }), given(5, 2, { ticketId: 43 }), { techId: null, at: NOW }, { techId: 5, at: 'never' }], { now: NOW, excludeTicketId: 42 });
    expect(recent.get(5).count).toBe(1);
  });
});

describe('B. the cap', () => {
  const dana = { techId: 5, name: 'Dana' };
  const eli = { techId: 6, name: 'Eli', eligible: true };
  const three = (techId = 5) => recentByTech([given(techId, 1), given(techId, 4), given(techId, 8)], { now: NOW });

  test('under the cap: the AI\'s pick stands', () => {
    const recent = recentByTech([given(5, 1), given(5, 4)], { now: NOW });
    expect(decide({ settings: on(), pick: dana, unitKey: 'ticket:1', recent, candidates: [eli] })).toMatchObject({ rule: RULES.NONE, techId: 5, moved: false, sentence: null, recentCount: 2 });
  });

  test('the fourth in ten minutes goes to the next-best candidate of the same run, and says why', () => {
    const out = decide({ settings: on(), pick: dana, unitKey: 'ticket:1', recent: three(), candidates: [eli, { techId: 7, name: 'Fay', eligible: true }] });
    expect(out).toMatchObject({ rule: RULES.CAP, techId: 6, moved: true, from: { techId: 5, name: 'Dana' }, to: { techId: 6, name: 'Eli' }, recentCount: 3 });
    expect(out.sentence).toBe('Given to Eli instead of Dana: Dana already got 3 tickets from automation in the last 10 minutes (the cap is 3).');
  });

  test('a candidate who is away, or also at the cap, is passed over for the one after', () => {
    const recent = recentByTech([given(5, 1), given(5, 2), given(5, 3), given(7, 1), given(7, 2), given(7, 3)], { now: NOW });
    const out = decide({
      settings: on(), pick: dana, unitKey: 'ticket:1', recent,
      candidates: [{ techId: 6, name: 'Eli', eligible: false, whyNot: 'not at work' }, { techId: 7, name: 'Fay', eligible: true }, { techId: 8, name: 'Gus', eligible: true }],
    });
    expect(out).toMatchObject({ rule: RULES.CAP, techId: 8 });
    expect(out.considered).toEqual([
      { techId: 6, name: 'Eli', whyNot: 'not at work', source: 'run' },
      { techId: 7, name: 'Fay', whyNot: 'also at the cap', source: 'run' },
      { techId: 8, name: 'Gus', whyNot: null, source: 'run' },
    ]);
  });

  test('nobody else qualified is at work: the cap gives way and the run says so', () => {
    const out = decide({ settings: on(), pick: dana, unitKey: 'ticket:1', recent: three(), candidates: [{ techId: 6, name: 'Eli', eligible: false, whyNot: 'not at work' }] });
    expect(out).toMatchObject({ rule: RULES.CAP_GAVE_WAY, techId: 5, moved: false, from: { techId: 5 }, to: { techId: 5 } });
    expect(out.sentence).toContain('nobody else qualified is at work, so the cap gave way');
    expect(decide({ settings: on(), pick: dana, unitKey: 'ticket:1', recent: three(), candidates: [] }).rule).toBe(RULES.CAP_GAVE_WAY);
  });

  test('the numbers are the settings, not constants', () => {
    const two = recentByTech([given(5, 1), given(5, 4)], { now: NOW });
    expect(decide({ settings: on({ capCount: 2 }), pick: dana, unitKey: 'ticket:1', recent: two, candidates: [eli] }).rule).toBe(RULES.CAP);
    expect(decide({ settings: on({ capCount: 5 }), pick: dana, unitKey: 'ticket:1', recent: three(), candidates: [eli] }).rule).toBe(RULES.NONE);
    const out = decide({ settings: on({ capCount: 1, capWindowMinutes: 1 }), pick: dana, unitKey: 'ticket:1', recent: recentByTech([given(5, 0.5)], { now: NOW, windowMinutes: 1 }), candidates: [eli] });
    expect(out.sentence).toContain('already got 1 ticket from automation in the last 1 minute (the cap is 1)');
  });

  test('master switch off, or the cap switched off: nothing moves', () => {
    expect(decide({ settings: on({ enabled: false }), pick: dana, unitKey: 'ticket:1', recent: three(), candidates: [eli] }).rule).toBe(RULES.NONE);
    expect(decide({ settings: on({ capEnabled: false }), pick: dana, unitKey: 'ticket:1', recent: three(), candidates: [eli] }).rule).toBe(RULES.NONE);
  });

  test('a person another rule already chose (urgent response) is counted but never moved', () => {
    expect(decide({ settings: on(), pick: dana, unitKey: 'ticket:1', recent: three(), candidates: [eli], locked: true })).toMatchObject({ rule: RULES.NONE, techId: 5, recentCount: 3 });
  });

  test('the pick is never offered as its own replacement', () => {
    const out = decide({ settings: on(), pick: dana, unitKey: 'ticket:1', recent: three(), candidates: [{ techId: 5, name: 'Dana', eligible: true }] });
    expect(out.rule).toBe(RULES.CAP_GAVE_WAY);
  });
});

describe('D with the cap', () => {
  const dana = { techId: 5, name: 'Dana' };

  test('the second ticket of the set follows the first, whoever the AI picked', () => {
    const out = decide({ settings: on(), pick: dana, unitKey: 'set:7', recent: new Map(), setOwner: { techId: 6, name: 'Eli' } });
    expect(out).toMatchObject({ rule: RULES.NEW_HIRE_SET, techId: 6, moved: true, from: { techId: 5 }, to: { techId: 6, name: 'Eli' } });
    expect(out.sentence).toContain('Kept with Eli');
  });

  test('already with the same person: nothing to do', () => {
    expect(decide({ settings: on(), pick: dana, unitKey: 'set:7', recent: new Map(), setOwner: { techId: 5, name: 'Dana' } }).rule).toBe(RULES.NONE);
  });

  test('the set stays together even when its owner is at the cap, and the second ticket is not a fourth', () => {
    const recent = recentByTech([given(6, 1, { unitKey: 'set:7', ticketId: 100 }), given(6, 2), given(6, 3)], { now: NOW });
    expect(decide({ settings: on(), pick: dana, unitKey: 'set:7', recent, setOwner: { techId: 6, name: 'Eli' } })).toMatchObject({ rule: RULES.NEW_HIRE_SET, techId: 6 });
    // the pick already holds the other half: same unit, no cap
    const mine = recentByTech([given(5, 1, { unitKey: 'set:7', ticketId: 100 }), given(5, 2), given(5, 3)], { now: NOW });
    expect(decide({ settings: on(), pick: dana, unitKey: 'set:7', recent: mine, candidates: [{ techId: 6, name: 'Eli', eligible: true }] }).rule).toBe(RULES.NONE);
  });

  test('eight new hires at once are eight units, so the cap still spreads them (Oct 8: 15 tickets to one person)', () => {
    const recent = recentByTech([
      given(5, 1, { unitKey: 'set:1', ticketId: 1 }), given(5, 1, { unitKey: 'set:1', ticketId: 2 }),
      given(5, 1, { unitKey: 'set:2', ticketId: 3 }), given(5, 1, { unitKey: 'set:2', ticketId: 4 }),
      given(5, 1, { unitKey: 'set:3', ticketId: 5 }), given(5, 1, { unitKey: 'set:3', ticketId: 6 }),
    ], { now: NOW });
    expect(recent.get(5).count).toBe(3);
    expect(decide({ settings: on(), pick: dana, unitKey: 'set:4', recent, candidates: [{ techId: 6, name: 'Eli', eligible: true }] })).toMatchObject({ rule: RULES.CAP, techId: 6 });
  });

  test('with "keep the set together" off, the owner of the other half is ignored', () => {
    expect(decide({ settings: on({ keepNewHireSet: false }), pick: dana, unitKey: 'ticket:9', recent: new Map(), setOwner: { techId: 6, name: 'Eli' } }).rule).toBe(RULES.NONE);
  });
});

describe('the record kept on the run', () => {
  test('small, and enough to show "would have gone to / went to / why"', () => {
    const settings = on();
    const result = decide({
      settings, pick: { techId: 5, name: 'Dana' }, unitKey: 'ticket:1',
      recent: recentByTech([given(5, 1), given(5, 2), given(5, 3)], { now: NOW }), candidates: [{ techId: 6, name: 'Eli', eligible: true }],
    });
    expect(recordFor(result, { unitKey: 'ticket:1', settings, now: NOW })).toEqual({
      v: 1, at: NOW.toISOString(), rule: 'cap', unit: 'ticket:1', recent: 3, cap: { count: 3, minutes: 10 },
      from: { techId: 5, name: 'Dana' }, to: { techId: 6, name: 'Eli' }, why: result.sentence,
      considered: [{ techId: 6, name: 'Eli', whyNot: null, source: 'run' }],
    });
    expect(recordFor({ rule: RULES.NONE, recentCount: 1 }, { unitKey: 'ticket:2', settings, now: NOW })).toMatchObject({ rule: 'none', recent: 1, from: null, to: null, why: null });
  });
});

describe('F. the release of the queue', () => {
  const run = (id, priority, minutes, assessed = null) => ({ id, queuedAt: minutesAgo(minutes), ticket: { priority, assessedPriorityId: assessed } });

  test('most urgent first, then the one that waited longest', () => {
    const order = orderForRelease([run(1, 2, 300), run(2, 4, 10), run(3, 2, 500), run(4, 1, 600, 4), run(5, null, 700)]).map((r) => r.id);
    expect(order).toEqual([4, 2, 3, 1, 5]);
  });

  test('does not change the list it was given', () => {
    const list = [run(1, 1, 5), run(2, 4, 5)];
    orderForRelease(list);
    expect(list.map((r) => r.id)).toEqual([1, 2]);
  });

  test('N every M minutes: what was released inside the interval is used up', () => {
    const settings = on({ staggerCount: 2, staggerMinutes: 2 });
    expect(releaseAllowance(settings, [], NOW)).toBe(2);
    expect(releaseAllowance(settings, [minutesAgo(1).getTime()], NOW)).toBe(1);
    expect(releaseAllowance(settings, [minutesAgo(1).getTime(), minutesAgo(0.5).getTime()], NOW)).toBe(0);
    // the worker ticks every two minutes: a release exactly one interval ago is free again
    expect(releaseAllowance(settings, [minutesAgo(2).getTime(), minutesAgo(2).getTime()], NOW)).toBe(2);
    expect(releaseAllowance(on({ staggerCount: 5, staggerMinutes: 10 }), [minutesAgo(9).getTime(), minutesAgo(3).getTime()], NOW)).toBe(3);
  });
});

describe('how the rules have worked', () => {
  const at = (iso) => new Date(iso);

  test('the day is the workspace\'s day, not UTC', () => {
    expect(dayIn(at('2026-10-09T03:00:00Z'), 'America/Vancouver')).toBe('2026-10-08');
    expect(dayIn(at('2026-10-09T12:00:00Z'), 'America/Vancouver')).toBe('2026-10-09');
  });

  test('largest burst = the most one person got inside any ten minutes', () => {
    const base = at('2026-10-08T23:16:00Z').getTime();
    const list = [
      ...[0, 1, 2, 3, 9].map((m, i) => ({ techId: 5, at: new Date(base + m * 60000), ticketId: i + 1 })),
      { techId: 5, at: new Date(base + 30 * 60000), ticketId: 50 },
      { techId: 6, at: new Date(base), ticketId: 60 },
    ];
    expect(largestBurst(list, 10)).toBe(5);
    expect(largestBurst(list, 2)).toBe(3);
    expect(largestBurst([], 10)).toBe(0);
  });

  test('a new hire\'s set counts once in a burst too', () => {
    const base = at('2026-10-08T23:16:00Z').getTime();
    expect(largestBurst([
      { techId: 5, at: new Date(base), ticketId: 1, unitKey: 'set:1' },
      { techId: 5, at: new Date(base + 1000), ticketId: 2, unitKey: 'set:1' },
      { techId: 5, at: new Date(base + 2000), ticketId: 3 },
    ], 10)).toBe(2);
  });

  test('the first release of the day: how many, and how long it took', () => {
    const base = at('2026-10-01T12:00:00Z').getTime();
    const runs = [0, 2, 4, 6, 400].map((m) => ({ queuedAt: new Date(base - 3600000), claimedAt: new Date(base + m * 60000) }));
    expect(releaseOfDay(runs)).toMatchObject({ released: 4, minutes: 6, startedAt: new Date(base).toISOString() });
    expect(releaseOfDay([])).toMatchObject({ released: 0, minutes: 0, startedAt: null });
  });

  test('per day and before / after the rules, with no person named anywhere in the summary', () => {
    const now = at('2026-10-15T20:00:00Z');
    const d8 = at('2026-10-08T23:16:00Z').getTime();
    const d14 = at('2026-10-14T16:00:00Z').getTime();
    const before = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, ticketId: i + 1, techId: 5, at: new Date(d8 + i * 5000), spread: null }));
    const after = [
      { id: 20, ticketId: 20, techId: 5, at: new Date(d14), spread: { rule: 'none', unit: 'ticket:20' } },
      { id: 21, ticketId: 21, techId: 5, at: new Date(d14 + 1000), spread: { rule: 'none', unit: 'ticket:21' } },
      { id: 22, ticketId: 22, techId: 5, at: new Date(d14 + 2000), spread: { rule: 'none', unit: 'ticket:22' } },
      { id: 23, ticketId: 23, techId: 6, at: new Date(d14 + 3000), spread: { rule: 'cap', unit: 'ticket:23', from: { techId: 5, name: 'Dana' }, to: { techId: 6, name: 'Eli' } } },
      { id: 24, ticketId: 24, techId: 6, at: new Date(d14 + 4000), spread: { rule: 'new_hire_set', unit: 'set:3' } },
      { id: 25, ticketId: 25, techId: 5, at: new Date(d14 + 5000), spread: { rule: 'cap_gave_way', unit: 'ticket:25' } },
    ];
    const queued = [0, 2, 4].map((m) => ({ queuedAt: new Date(d14 - 3 * 3600000), claimedAt: new Date(d14 - 3600000 + m * 60000) }));
    const out = summarize([...before, ...after], queued, { settings: normalizeSettings({ enabled: true }, 1), timeZone: 'America/Vancouver', days: 14, now });

    expect(out.perDay).toHaveLength(14);
    expect(out.totals).toEqual({ assignments: 12, moved: 1, keptTogether: 1, gaveWay: 1, guarded: 6 });
    const day8 = out.perDay.find((d) => d.day === '2026-10-08');
    const day14 = out.perDay.find((d) => d.day === '2026-10-14');
    expect(day8).toMatchObject({ assignments: 6, largestBurst: 6, rulesOn: false, moved: 0 });
    expect(day14).toMatchObject({ assignments: 6, largestBurst: 4, rulesOn: true, moved: 1, keptTogether: 1, gaveWay: 1, released: 3, releaseMinutes: 4 });
    expect(out.before).toMatchObject({ days: 1, assignments: 6, largestBurst: 6, daysOverCap: 1 });
    expect(out.after).toMatchObject({ days: 1, assignments: 6, largestBurst: 4, release: { days: 1, tickets: 3, averageMinutes: 4, longestMinutes: 4 } });
    expect(out.rulesFirstSeen).toBe('2026-10-14');
    // Team balance, never a ranking: the summary carries no person at all.
    expect(JSON.stringify({ ...out, perDay: out.perDay })).not.toMatch(/Dana|Eli|techId/);
  });
});
