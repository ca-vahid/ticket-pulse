import { describe, expect, test } from '@jest/globals';
import {
  OUTCOMES, mergeNote, normalizeSettings, priorityId, raisedPriority, routingSentence, sameProblem, subjectSimilarity, ticketRef,
} from '../src/services/assignmentFollowUp/rules.js';

describe('settings (followup_routing_ws<N>)', () => {
  test('off by default everywhere; Level match JSON or a bare mode string both work', () => {
    expect(normalizeSettings(null).mode).toBe('off');
    expect(normalizeSettings('rubbish').mode).toBe('off');
    expect(normalizeSettings('shadow').mode).toBe('shadow');
    expect(normalizeSettings('"live"').mode).toBe('live');
    expect(normalizeSettings('{"mode":"shadow","updatedBy":"Dana Fox"}')).toMatchObject({ mode: 'shadow', updatedBy: 'Dana Fox', persisted: true });
    expect(normalizeSettings({ mode: 'on' }).mode).toBe('off');
  });
});

describe('same problem', () => {
  const teams = { internalCategoryId: 10, internalSubcategoryId: 101 };
  test('same subcategory: TP-1042 "can\'t sign into Teams" and "Lost access to Teams again"', () => {
    expect(sameProblem({ ...teams, subject: 'Lost access to Teams again' }, { ...teams, subject: "can't sign into Teams" }))
      .toEqual({ matchedOn: 'subcategory' });
  });

  test('same category counts only when one side has no subcategory', () => {
    expect(sameProblem({ internalCategoryId: 10, internalSubcategoryId: null }, teams)).toEqual({ matchedOn: 'category' });
    expect(sameProblem({ internalCategoryId: 10, internalSubcategoryId: 102, subject: 'New laptop' }, { ...teams, subject: 'Teams sign-in' })).toBeNull();
  });

  test('a close subject matches when the categories do not', () => {
    const m = sameProblem({ subject: 'Outlook password reset not working' }, { subject: 'RE: Outlook password reset' });
    expect(m).toMatchObject({ matchedOn: 'subject' });
    expect(sameProblem({ subject: 'Printer jam on 3rd floor' }, { subject: 'VPN keeps dropping' })).toBeNull();
  });

  test('embedding similarity is the last resort', () => {
    expect(sameProblem({ subject: 'a' }, { subject: 'b' }, { textSimilarity: 0.9 })).toEqual({ matchedOn: 'text', similarity: 0.9 });
    expect(sameProblem({ subject: 'a' }, { subject: 'b' }, { textSimilarity: 0.5 })).toBeNull();
  });

  test('subject similarity ignores filler words and casing', () => {
    expect(subjectSimilarity('Please help: VPN not connecting', 'vpn NOT connecting again')).toBe(1);
    expect(subjectSimilarity('', 'anything')).toBe(0);
  });
});

describe('priority raise', () => {
  test('one level up, Urgent at most, never down', () => {
    expect(raisedPriority('Low')).toBe('Medium');
    expect(raisedPriority('medium')).toBe('High');
    expect(raisedPriority('High')).toBe('Urgent');
    expect(raisedPriority('Urgent')).toBe('Urgent');
    expect(raisedPriority(null)).toBeNull();
    expect(priorityId('High')).toBe(3);
  });
});

describe('words', () => {
  test('refs and sentences', () => {
    expect(ticketRef({ id: 5, origin: 'ticketpulse', nativeNumber: 1042 })).toBe('TP-1042');
    expect(ticketRef({ id: 5, origin: 'freshservice', freshserviceTicketId: BigInt(123456) })).toBe('#123456');
    expect(routingSentence({ outcome: OUTCOMES.WOULD_ROUTE, ownerName: 'Eli Park', ref: 'TP-1042' }))
      .toBe('Would send to Eli Park: same problem as TP-1042 reported today.');
    expect(routingSentence({ outcome: OUTCOMES.ROUTED, ownerName: 'Eli Park', ref: 'TP-1042' }))
      .toBe('Sent to Eli Park: same problem as TP-1042 reported today.');
    expect(routingSentence({ outcome: OUTCOMES.OWNER_UNAVAILABLE, ownerName: 'Eli Park', ref: 'TP-1042', reason: 'away today' }))
      .toMatch(/not sent to Eli Park \(away today\)/);
    expect(mergeNote({ ref: 'TP-1042', subject: "can't sign into Teams", ownerName: 'Eli Park' }))
      .toMatch(/Consider merging this ticket into TP-1042\.$/);
  });
});
