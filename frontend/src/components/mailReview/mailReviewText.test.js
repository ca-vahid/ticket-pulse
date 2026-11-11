import { describe, expect, test } from 'vitest';
import {
  agreementSentence, closedNote, defaultRequester, describeSuggestion, fmtRef, isAcceptable, isSureBulk,
  resultSentence, suggestionEffects, suggestionSentence,
} from './mailReviewText';

const closed = { id: 1, ref: '249132', subject: 'Monitor arm', status: 'Closed', statusBase: 'closed', closedAt: '2026-10-27T19:00:00Z' };
const open = { id: 2, ref: 'TP-11340', subject: 'Statement', status: 'Open', statusBase: 'open', closedAt: null };

describe('mail review words', () => {
  test('ticket refs and the closed note (Pacific day)', () => {
    expect(fmtRef(closed)).toBe('#249132');
    expect(fmtRef(open)).toBe('TP-11340');
    expect(closedNote(closed)).toBe('(Closed 27 Oct)');
    expect(closedNote(open)).toBe('');
    // 02:00 UTC on the 28th is still the 27th in BC.
    expect(closedNote({ ...closed, closedAt: '2026-10-28T02:00:00Z' })).toBe('(Closed 27 Oct)');
  });

  test('effects: the server’s list wins; otherwise the reopen flag speaks', () => {
    expect(suggestionEffects({ action: 'attach', ticket: closed, reopen: true })).toEqual(['reopens it']);
    expect(suggestionEffects({ action: 'attach', ticket: closed, reopen: false })).toEqual(['leaves it closed']);
    expect(suggestionEffects({ action: 'attach', ticket: open, reopen: false })).toEqual([]);
    expect(suggestionEffects({ action: 'attach', ticket: closed, reopen: true, effects: ['reopens it', 'notifies Alex Rivera'] })).toEqual(['reopens it', 'notifies Alex Rivera']);
  });

  test('each kind of suggestion in words', () => {
    expect(suggestionSentence({ action: 'attach', ticket: closed, reopen: true })).toBe('Add to #249132, reopens it');
    expect(suggestionSentence({ action: 'create', requester: { email: 'dana@example.com', name: 'Dana Whitlock' } })).toBe('New ticket for Dana Whitlock');
    expect(suggestionSentence({ action: 'no_ticket' })).toBe('No ticket needed');
    expect(describeSuggestion({ action: 'unsure', ticket: open }).verb).toBe('Not sure: best guess is to add to');
    expect(describeSuggestion(null).verb).toBe('No good match');
  });

  test('what may be accepted, alone and in bulk', () => {
    expect(isAcceptable({ action: 'no_ticket', confidence: 'sure' })).toBe(true);
    expect(isAcceptable({ action: 'unsure', ticket: open })).toBe(false);
    expect(isAcceptable({ action: 'attach', ticket: null })).toBe(false);
    // The AI never discards on its own, so "no ticket" is never part of a bulk accept.
    expect(isSureBulk({ action: 'no_ticket', confidence: 'sure' })).toBe(false);
    expect(isSureBulk({ action: 'attach', ticket: open, confidence: 'likely' })).toBe(false);
    expect(isSureBulk({ action: 'create', confidence: 'sure' })).toBe(true);
  });

  test('the requester for a new ticket is the first address outside the viewer’s domain', () => {
    const item = { from: { email: 'robin@example.com' }, to: ['ar@example.com', 'dana@client.example.org'], cc: [] };
    expect(defaultRequester(item, 'sam@example.com')).toBe('dana@client.example.org');
    expect(defaultRequester({ from: { email: 'dana@client.example.org' }, to: ['ar@example.com'] }, 'sam@example.com')).toBe('dana@client.example.org');
    expect(defaultRequester({ ...item, suggestion: { requester: { email: 'lee@client.example.org' } } }, 'sam@example.com')).toBe('lee@client.example.org');
  });

  test('result and agreement sentences', () => {
    expect(resultSentence({ action: 'attach', reopen: false }, open)).toBe('Added to TP-11340.');
    expect(resultSentence({ action: 'no_ticket' })).toBe('Marked as no ticket needed.');
    expect(agreementSentence({ sureAccepted: 61, sureChanged: 5, agreementPct: 92.4 })).toBe('People kept 92% of sure suggestions, 61 of 66');
    expect(agreementSentence({ sureAccepted: 0, sureChanged: 0 })).toBe('');
  });
});
