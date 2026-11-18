import {
  OUTCOMES, applyPatch, decide, formatGap, normalizeSettings, sentenceFor,
} from '../src/services/assignmentTimezoneFit/rules.js';
import { levelNum } from '../src/services/assignmentLevelMatch/rules.js';

// QA 11-17 item 1. Invented names; the shape is a real November ticket.
const NOW = new Date('2026-11-17T13:14:00Z'); // 5:14 AM PT
const SANTIAGO = { timezone: 'America/Santiago', source: 'entra_city', confidence: 'high', place: 'Santiago' };

const person = (techId, techName, timezone, level, score, rank, extra = {}) => ({
  techId, techName, timezone, rank, score,
  skill: level ? { level, num: levelNum(level), priority: 2 } : null,
  onLeave: false, onShift: false, rejectedThisTicket: false, routingNote: null, assignableOnly: false,
  ...extra,
});
// The shape of the ticket: everyone off shift at 5:14 AM PT / 8:14 AM ET.
const ELI = person(10, 'Eli Park', 'America/Vancouver', 'advanced', 0.8, 1);
const PRIYA = person(11, 'Priya Nair', 'America/Edmonton', 'advanced', 0.78, 2);
const SAM = person(12, 'Sam Okafor', 'America/Vancouver', 'advanced', 0.72, 3);
const LEE = person(13, 'Lee Moss', 'America/Vancouver', 'advanced', 0.68, 4);
const DANA = person(14, 'Dana Fox', 'America/Toronto', 'intermediate', 0.66, 5);
const LIST = [ELI, PRIYA, SAM, LEE, DANA];

const run = (over = {}) => decide({ requester: SANTIAGO, siteBound: false, aiPickId: 10, candidates: LIST, now: NOW, ...over });

describe('decide', () => {
  test('the ticket that started it: Santiago requester, Vancouver pick → the Toronto person goes first', () => {
    const out = run();
    expect(out).toMatchObject({ outcome: OUTCOMES.MOVED, techId: 14, techName: 'Dana Fox', from: { techId: 10 } });
    expect(sentenceFor(out, { applied: true })).toBe(
      'Time zone: the requester is in Santiago (UTC−3); Dana Fox in Toronto is 2 h away, Eli Park in Vancouver 5 h, so Dana was put first.',
    );
    expect(sentenceFor(out, { applied: false })).toMatch(/so Dana would be put first\.$/);
  });

  test('Edmonton is only 1 h closer than Vancouver: not enough on its own', () => {
    const out = run({ candidates: [ELI, PRIYA, SAM, LEE] });
    expect(out.outcome).toBe(OUTCOMES.KEPT);
    expect(out.techId).toBe(10);
    expect(sentenceFor(out)).toBe('Time zone: the requester is in Santiago (UTC−3) and Eli Park in Vancouver is 5 h away; nobody with close enough skill is 2 h closer.');
  });

  test('a pick under 3 h away stays', () => {
    expect(run({ aiPickId: 14 }).outcome).toBe(OUTCOMES.CLOSE);
    const halifax = { timezone: 'America/Halifax', confidence: 'high', place: 'Halifax' };
    expect(run({ requester: halifax, candidates: [{ ...ELI, timezone: 'America/Toronto' }, DANA] }).outcome).toBe(OUTCOMES.CLOSE);
  });

  test('the FreshService Pacific default, or no zone: nothing to do', () => {
    expect(run({ requester: { timezone: 'America/Vancouver', confidence: 'low' } }).outcome).toBe(OUTCOMES.NO_TIMEZONE);
    expect(run({ requester: null }).outcome).toBe(OUTCOMES.NO_TIMEZONE);
  });

  test('site work (the AI used a preferred location): time zone stays out', () => {
    expect(run({ siteBound: true }).outcome).toBe(OUTCOMES.SITE_BOUND);
  });

  test('skill must be close: two levels below the pick, below the needed level, or only the parent skill never qualify', () => {
    expect(run({ candidates: [ELI, { ...DANA, skill: { level: 'basic', num: 1, priority: 2 } }] }).outcome).toBe(OUTCOMES.KEPT);
    expect(run({ requiredLevel: 'advanced' }).outcome).toBe(OUTCOMES.KEPT);
    expect(run({ requiredLevel: 'intermediate' }).outcome).toBe(OUTCOMES.MOVED);
    expect(run({ candidates: [ELI, { ...DANA, skill: { level: 'expert', num: 4, priority: 1, broad: true } }] }).outcome).toBe(OUTCOMES.KEPT);
    expect(run({ candidates: [ELI, { ...DANA, skill: null }] }).outcome).toBe(OUTCOMES.KEPT);
  });

  test('score must be within 0.15 of the pick', () => {
    expect(run({ candidates: [ELI, { ...DANA, score: 0.64 }] }).outcome).toBe(OUTCOMES.KEPT);
  });

  test('the never-pick list', () => {
    for (const flag of [{ onLeave: true }, { rejectedThisTicket: true }, { assignableOnly: true }, { routingNote: 'Only payroll' }]) {
      expect(run({ candidates: [ELI, { ...DANA, ...flag }] }).outcome).toBe(OUTCOMES.KEPT);
    }
  });

  test('never someone off shift while the pick is at work', () => {
    expect(run({ candidates: [{ ...ELI, onShift: true }, DANA] }).outcome).toBe(OUTCOMES.KEPT);
    expect(run({ candidates: [{ ...ELI, onShift: true }, { ...DANA, onShift: true }] }).outcome).toBe(OUTCOMES.MOVED);
  });

  test('closest wins; a tie goes to the higher score', () => {
    const halifaxLow = person(15, 'Ana Ruiz', 'America/Halifax', 'advanced', 0.7, 6);
    expect(run({ candidates: [...LIST, halifaxLow] }).techId).toBe(15);
    const torontoHigh = person(16, 'Kim Lau', 'America/Toronto', 'advanced', 0.75, 7);
    expect(run({ candidates: [...LIST, torontoHigh] }).techId).toBe(16);
  });

  test('distance wraps around the day: a Brisbane requester (UTC+10)', () => {
    const brisbane = { timezone: 'Australia/Brisbane', confidence: 'high', place: 'Brisbane' };
    // Vancouver (UTC−8) is 6 h from Brisbane, Toronto (UTC−5) 9 h: never move to the farther person.
    const out = run({ requester: brisbane, candidates: [ELI, DANA] });
    expect(out.outcome).toBe(OUTCOMES.KEPT);
    expect(out.techId).toBe(10);
    expect(sentenceFor(out)).toMatch(/Eli Park in Vancouver is 6 h away/);
    // Someone in Brisbane is 0 h away and goes first.
    const local = person(20, 'Ana Ruiz', 'Australia/Brisbane', 'advanced', 0.75, 6);
    const moved = run({ requester: brisbane, candidates: [ELI, DANA, local] });
    expect(moved).toMatchObject({ outcome: OUTCOMES.MOVED, techId: 20 });
    expect(sentenceFor(moved, { applied: true })).toMatch(/Ana Ruiz in Brisbane is 0 h away, Eli Park in Vancouver 6 h/);
  });

  test('distance wraps around the day: an Auckland requester (UTC+13 in November)', () => {
    const auckland = { timezone: 'Pacific/Auckland', confidence: 'high', place: 'Auckland' };
    // Vancouver is 3 h away across the date line (21 h the long way); Toronto 6 h, farther: kept.
    const kept = run({ requester: auckland, candidates: [ELI, DANA] });
    expect(kept).toMatchObject({ outcome: OUTCOMES.KEPT, techId: 10 });
    expect(sentenceFor(kept)).toMatch(/Eli Park in Vancouver is 3 h away/);
    // A Toronto pick is 6 h away; Vancouver, 3 h closer, goes first.
    const out = run({ requester: auckland, aiPickId: 14, candidates: [{ ...DANA, score: 0.8, skill: ELI.skill }, { ...ELI, score: 0.75 }] });
    expect(out).toMatchObject({ outcome: OUTCOMES.MOVED, techId: 10 });
    expect(sentenceFor(out, { applied: true })).toMatch(/Eli Park in Vancouver is 3 h away, Dana Fox in Toronto 6 h/);
  });

  test('a pick missing from the list or without a zone: nothing to do', () => {
    expect(run({ aiPickId: 99 }).outcome).toBe(OUTCOMES.NO_PICK);
    expect(run({ candidates: [{ ...ELI, timezone: null }, DANA] }).outcome).toBe(OUTCOMES.NO_PICK);
  });
});

describe('settings', () => {
  test('every workspace starts off; bad values fall back', () => {
    expect(normalizeSettings(null).mode).toBe('off');
    expect(normalizeSettings('{"mode":"shadow"}').mode).toBe('shadow');
    expect(normalizeSettings('{"mode":"loud"}').mode).toBe('off');
    expect(normalizeSettings('not json').mode).toBe('off');
  });

  test('patch keeps a history line', () => {
    const { next, errors } = applyPatch(normalizeSettings(null), { mode: 'shadow' }, { by: 'Dana Fox', now: NOW });
    expect(errors).toEqual([]);
    expect(next.history[0]).toMatchObject({ by: 'Dana Fox', changes: [{ field: 'mode', from: 'off', to: 'shadow' }] });
  });

  test('gap words', () => {
    expect(formatGap(300)).toBe('5 h');
    expect(formatGap(150)).toBe('2.5 h');
  });
});
