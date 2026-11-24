import { describe, expect, test } from '@jest/globals';
import {
  OPEN_LOAD_GAP, OUTCOMES, TODAY_GAP_OVERRIDE, decide, levelNum,
} from '../src/services/assignmentLevelMatch/rules.js';

/**
 * QA 11-23 items 1 and 2 (TP-1042 shape): the AI ranked Dana Fox first (0.80,
 * 13 open, 4 today) and Eli Park fourth (0.68, 22 open, 3 today). Both are
 * advanced in Teams; the request needed basic; Eli was inside the 0.15 floor.
 * Level match moved it to Eli for one ticket fewer today — onto a queue nine
 * tickets heavier — and said "extra skill is not needed" though both have the
 * same level.
 */
const person = (techId, techName, level, { rank = 1, today = 0, open = 0, score = null, name = 'Teams', priority = 2 } = {}) => ({
  techId, techName, rank, today, open, score,
  skill: { level, num: levelNum(level), priority, ...(name ? { name } : {}) },
  onLeave: false, onShift: true, rejectedThisTicket: false, routingNote: null,
});
const DANA = 11;
const ELI = 12;
const PRIYA = 13;

const shape = ({ eliToday = 3, eliOpen = 22, danaToday = 4, danaOpen = 13 } = {}) => decide({
  requiredLevel: 'basic',
  aiPickId: DANA,
  candidates: [
    person(DANA, 'Dana Fox', 'advanced', { rank: 1, today: danaToday, open: danaOpen, score: 0.8 }),
    person(ELI, 'Eli Park', 'advanced', { rank: 4, today: eliToday, open: eliOpen, score: 0.68 }),
  ],
});

describe('open load (item 1)', () => {
  test('the constants are 5 open and 2 today', () => {
    expect(OPEN_LOAD_GAP).toBe(5);
    expect(TODAY_GAP_OVERRIDE).toBe(2);
  });

  test('TP-1042 shape: 9 more open and only 1 fewer today — kept with the AI pick', () => {
    const r = shape();
    expect(r).toMatchObject({ outcome: OUTCOMES.KEPT, techId: DANA });
    expect(r.skipReason).toBe('kept: Eli Park has 9 more open tickets and only 1 fewer today');
    expect(r.skipped).toEqual([expect.objectContaining({ techId: ELI, openMore: 9, todayFewer: 1 })]);
    expect(r.sentence).toBe('Needs basic; kept with Dana Fox: Eli Park has 9 more open tickets and only 1 fewer today.');
  });

  test('a today gap of 2 still moves the ticket, whatever the open load', () => {
    const r = shape({ eliToday: 2 });
    expect(r).toMatchObject({ outcome: OUTCOMES.MOVED, techId: ELI, skipped: [], skipReason: null });
  });

  test('an open-load difference under 5 still moves on the lighter day', () => {
    const r = shape({ eliOpen: 17 }); // 4 more open
    expect(r).toMatchObject({ outcome: OUTCOMES.MOVED, techId: ELI });
  });

  test('exactly 5 more open with 1 fewer today is kept', () => {
    expect(shape({ eliOpen: 18 })).toMatchObject({ outcome: OUTCOMES.KEPT, techId: DANA });
  });

  test('a passed-over person does not stop a lighter person further down the list', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: DANA,
      candidates: [
        person(DANA, 'Dana Fox', 'advanced', { rank: 1, today: 4, open: 13 }),
        person(ELI, 'Eli Park', 'advanced', { rank: 2, today: 2, open: 30 }), // 2 fewer today: allowed
        person(PRIYA, 'Priya Nair', 'advanced', { rank: 3, today: 1, open: 25 }), // 3 fewer: allowed, and lightest
      ],
    });
    expect(r).toMatchObject({ outcome: OUTCOMES.MOVED, techId: PRIYA });
    const s = decide({
      requiredLevel: 'basic',
      aiPickId: DANA,
      candidates: [
        person(DANA, 'Dana Fox', 'advanced', { rank: 1, today: 4, open: 13 }),
        person(ELI, 'Eli Park', 'advanced', { rank: 2, today: 3, open: 30 }), // skipped
        person(PRIYA, 'Priya Nair', 'advanced', { rank: 3, today: 4, open: 12 }), // same day, 1 fewer open: allowed
      ],
    });
    expect(s).toMatchObject({ outcome: OUTCOMES.MOVED, techId: PRIYA, moveReason: 'fewer_open' });
    expect(s.skipped.map((x) => x.techId)).toEqual([ELI]);
  });

  test('a pick who does not meet the level is moved for skill, open load or not', () => {
    const r = decide({
      requiredLevel: 'advanced',
      aiPickId: DANA,
      candidates: [
        person(DANA, 'Dana Fox', 'basic', { rank: 1, today: 4, open: 2 }),
        person(ELI, 'Eli Park', 'advanced', { rank: 2, today: 3, open: 22 }),
      ],
    });
    expect(r).toMatchObject({ outcome: OUTCOMES.MOVED, techId: ELI, moveReason: 'pick_below_level' });
    expect(r.sentence).not.toMatch(/extra skill/);
  });
});

describe('the move sentence gives the real reason (item 2)', () => {
  test('same level, lighter day', () => {
    const r = shape({ eliOpen: 15, eliToday: 3 });
    expect(r.moveReason).toBe('lighter_day');
    expect(r.sentence).toBe('Lighter day: Eli Park (3 today) instead of Dana Fox (4 today). Both advanced in Teams; Eli Park has 15 open, Dana Fox 13.');
    expect(r.sentence).not.toMatch(/extra skill/);
  });

  test('the TP-1042 numbers with a 2-ticket day gap read as a lighter day', () => {
    const r = shape({ eliToday: 2 });
    expect(r.sentence).toBe('Lighter day: Eli Park (2 today) instead of Dana Fox (4 today). Both advanced in Teams; Eli Park has 22 open, Dana Fox 13.');
  });

  test('"extra skill is not needed" only when the new person really is less skilled', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: DANA,
      candidates: [
        person(DANA, 'Dana Fox', 'expert', { rank: 1, today: 6, open: 20 }),
        person(ELI, 'Eli Park', 'intermediate', { rank: 2, today: 1, open: 15 }),
      ],
    });
    expect(r.moveReason).toBe('less_skill_needed');
    expect(r.sentence).toBe('Needs basic: Eli Park (intermediate, 1 today, 15 open) instead of Dana Fox (expert, 6 today, 20 open) — extra skill is not needed for this request.');
  });

  test('a more skilled person with a lighter day says so', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: DANA,
      candidates: [
        person(DANA, 'Dana Fox', 'intermediate', { rank: 1, today: 4, open: 10 }),
        person(ELI, 'Eli Park', 'expert', { rank: 2, today: 2, open: 9 }),
      ],
    });
    expect(r.moveReason).toBe('lighter_day');
    expect(r.sentence).toMatch(/Eli Park is expert, Dana Fox intermediate in Teams/);
  });

  test('same day, fewer open tickets', () => {
    const r = shape({ eliToday: 4, eliOpen: 9 });
    expect(r.moveReason).toBe('fewer_open');
    expect(r.sentence).toBe('Fewer open tickets: Eli Park (9 open) instead of Dana Fox (13 open). Both advanced in Teams; both have 4 today.');
  });

  test('without a skill name the sentence still reads', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: DANA,
      candidates: [
        person(DANA, 'Dana Fox', 'advanced', { today: 4, open: 13, name: null }),
        person(ELI, 'Eli Park', 'advanced', { rank: 2, today: 3, open: 14, name: null }),
      ],
    });
    expect(r.sentence).toBe('Lighter day: Eli Park (3 today) instead of Dana Fox (4 today). Both advanced; Eli Park has 14 open, Dana Fox 13.');
  });
});
