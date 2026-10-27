import { describe, expect, test } from '@jest/globals';
import {
  OUTCOMES, applyPatch, decide, defaultSettings, levelNum, normalizeLevel, normalizeSettings, onShiftAt, skillFor,
} from '../src/services/assignmentLevelMatch/rules.js';

/**
 * Level match (26 Oct 2026): Monday, Alexey (expert) got 12 tickets and
 * Soheil (advanced) 1, mostly licence requests anyone trained can do.
 */
const person = (techId, techName, level, { rank = 1, today = 0, open = 0, priority = 2, ...rest } = {}) => ({
  techId, techName, rank, today, open,
  skill: level ? { level, num: levelNum(level), priority } : null,
  onLeave: false, onShift: true, rejectedThisTicket: false, routingNote: null,
  ...rest,
});
const ALEXEY = 4;
const SOHEIL = 56;

describe('decide', () => {
  test('a basic request goes to the qualified person with the lighter day, not the expert', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: ALEXEY,
      candidates: [person(ALEXEY, 'Alexey', 'expert', { rank: 1, today: 6, open: 20 }), person(SOHEIL, 'Soheil', 'advanced', { rank: 2, today: 1, open: 15 })],
    });
    expect(r.outcome).toBe(OUTCOMES.MOVED);
    expect(r.techId).toBe(SOHEIL);
    expect(r.sentence).toMatch(/Needs basic: Soheil \(advanced, 1 today, 15 open\) instead of Alexey/);
  });

  test('an expert request still goes only to experts', () => {
    const r = decide({
      requiredLevel: 'expert',
      aiPickId: ALEXEY,
      candidates: [person(ALEXEY, 'Alexey', 'expert', { today: 6 }), person(SOHEIL, 'Soheil', 'advanced', { rank: 2, today: 0 })],
    });
    expect(r.outcome).toBe(OUTCOMES.KEPT);
    expect(r.techId).toBe(ALEXEY);
  });

  test('when the AI picked someone below the level, a qualified person gets it', () => {
    const r = decide({
      requiredLevel: 'advanced',
      aiPickId: SOHEIL,
      candidates: [person(SOHEIL, 'Soheil', 'intermediate', { today: 0 }), person(ALEXEY, 'Alexey', 'expert', { rank: 2, today: 5 })],
    });
    expect(r).toMatchObject({ outcome: OUTCOMES.MOVED, techId: ALEXEY });
  });

  test('ties keep the AI pick; then open tickets, then the AI order decide', () => {
    const tie = decide({ requiredLevel: 'basic', aiPickId: ALEXEY, candidates: [person(ALEXEY, 'A', 'expert', { today: 2, open: 9 }), person(SOHEIL, 'S', 'basic', { rank: 2, today: 2, open: 9 })] });
    expect(tie).toMatchObject({ outcome: OUTCOMES.KEPT, techId: ALEXEY });
    const byOpen = decide({ requiredLevel: 'basic', aiPickId: ALEXEY, candidates: [person(ALEXEY, 'A', 'expert', { today: 2, open: 9 }), person(SOHEIL, 'S', 'basic', { rank: 2, today: 2, open: 3 })] });
    expect(byOpen.techId).toBe(SOHEIL);
  });

  test('a broad parent-category skill never earns a move when the ticket has a subcategory (#65201)', () => {
    const d = decide({
      requiredLevel: 'intermediate',
      aiPickId: 7,
      candidates: [
        person(7, 'Anton', 'basic', { open: 21 }),
        { ...person(6, 'Andrii', 'expert', { rank: 2, open: 9, priority: 1 }), skill: { level: 'expert', num: 4, priority: 1, broad: true } },
      ],
    });
    expect(d.outcome).toBe('no_skill');
    expect(d.techId).toBe(7);
  });

  test('exact subcategory skill beats parent-category skill', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: ALEXEY,
      candidates: [person(ALEXEY, 'A', 'expert', { today: 5 }), person(7, 'Parent only', 'expert', { rank: 2, today: 0, priority: 1 })],
    });
    expect(r).toMatchObject({ outcome: OUTCOMES.KEPT, techId: ALEXEY });
  });

  test('leave, a rejection of this ticket or a routing note never promote a person', () => {
    for (const extra of [{ onLeave: true }, { rejectedThisTicket: true }, { routingNote: 'reduced capacity this month' }]) {
      const r = decide({ requiredLevel: 'basic', aiPickId: ALEXEY, candidates: [person(ALEXEY, 'A', 'expert', { today: 6 }), person(SOHEIL, 'S', 'advanced', { rank: 2, today: 0, ...extra })] });
      expect(r.techId).toBe(ALEXEY);
    }
  });

  test('off-shift people only when nobody qualified is at work', () => {
    const r = decide({ requiredLevel: 'basic', aiPickId: ALEXEY, candidates: [person(ALEXEY, 'A', 'expert', { today: 6 }), person(SOHEIL, 'S', 'advanced', { rank: 2, today: 0, onShift: false })] });
    expect(r.techId).toBe(ALEXEY);
    const night = decide({ requiredLevel: 'basic', aiPickId: ALEXEY, candidates: [person(ALEXEY, 'A', 'expert', { today: 6, onShift: false }), person(SOHEIL, 'S', 'advanced', { rank: 2, today: 0, onShift: false })] });
    expect(night.techId).toBe(SOHEIL);
  });

  test('no level judged, or nobody listed holds the skill: nothing changes', () => {
    expect(decide({ requiredLevel: null, aiPickId: ALEXEY, candidates: [person(ALEXEY, 'A', 'expert')] })).toMatchObject({ outcome: OUTCOMES.NO_LEVEL, techId: ALEXEY });
    expect(decide({ requiredLevel: 'basic', aiPickId: ALEXEY, candidates: [person(ALEXEY, 'A', null)] })).toMatchObject({ outcome: OUTCOMES.NO_SKILL, techId: ALEXEY });
  });
});

describe('fitness floor (AI score) and assignable-only', () => {
  test('someone the AI scored far below its first choice is never promoted', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: ALEXEY,
      candidates: [person(ALEXEY, 'Alexey', 'expert', { today: 6, score: 0.88 }), person(99, 'Manager', 'advanced', { rank: 2, today: 0, score: 0.6 })],
    });
    expect(r).toMatchObject({ outcome: OUTCOMES.KEPT, techId: ALEXEY });
  });

  test('close scores compete on load', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: ALEXEY,
      candidates: [person(ALEXEY, 'Alexey', 'expert', { today: 6, score: 0.85 }), person(SOHEIL, 'Soheil', 'advanced', { rank: 2, today: 1, score: 0.8 })],
    });
    expect(r.techId).toBe(SOHEIL);
  });

  test('people from another team (assignable only) are never promoted', () => {
    const r = decide({
      requiredLevel: 'basic',
      aiPickId: ALEXEY,
      candidates: [person(ALEXEY, 'Alexey', 'expert', { today: 6 }), person(SOHEIL, 'Other team', 'advanced', { rank: 2, today: 0, assignableOnly: true })],
    });
    expect(r.techId).toBe(ALEXEY);
  });
});

describe('helpers', () => {
  test('levels', () => {
    expect(normalizeLevel(' Advanced ')).toBe('advanced');
    expect(normalizeLevel('guru')).toBeNull();
    expect(levelNum('expert')).toBe(4);
  });

  test('skillFor prefers the exact subcategory', () => {
    const skills = [{ categoryId: 136, level: 'expert' }, { categoryId: 140, level: 'basic' }];
    expect(skillFor(skills, { categoryId: 136, subcategoryId: 140 })).toEqual({ level: 'basic', num: 1, priority: 2 });
    expect(skillFor(skills, { categoryId: 136, subcategoryId: 999 })).toEqual({ level: 'expert', num: 4, priority: 1, broad: true });
    expect(skillFor(skills, { categoryId: 136, subcategoryId: null })).toEqual({ level: 'expert', num: 4, priority: 1 });
    expect(skillFor([], { categoryId: 136 })).toBeNull();
  });

  test('onShiftAt reads the person’s own hours in their time zone', () => {
    const p = { timezone: 'America/Vancouver', workStartTime: '08:00', workEndTime: '16:30' };
    expect(onShiftAt(p, new Date('2026-10-26T17:00:00Z'))).toBe(true); // 10:00 PDT
    expect(onShiftAt(p, new Date('2026-10-27T03:00:00Z'))).toBe(false); // 20:00 PDT
    expect(onShiftAt({ timezone: 'Nowhere/Bad' }, new Date())).toBe(true);
  });

  test('settings: IT starts in Shadow, others off; modes validated; history kept', () => {
    expect(defaultSettings(1).mode).toBe('shadow');
    expect(defaultSettings(2).mode).toBe('off');
    expect(normalizeSettings('{"mode":"live"}', 2).mode).toBe('live');
    expect(normalizeSettings('rubbish', 1).mode).toBe('shadow');
    const cur = normalizeSettings(null, 1);
    expect(applyPatch(cur, { mode: 'on' }).errors[0]).toMatch(/mode must be one of/);
    const { next, changes } = applyPatch(cur, { mode: 'live' }, { by: 'Vahid', now: new Date('2026-10-27T17:00:00Z') });
    expect(changes).toEqual([{ field: 'mode', from: 'shadow', to: 'live' }]);
    expect(next.history[0]).toMatchObject({ by: 'Vahid' });
  });
});
