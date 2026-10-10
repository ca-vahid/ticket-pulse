import { describe, expect, test } from 'vitest';
import { canDeleteNoteEntry } from './noteDeleteRules';

// QA 10-09 item 6: the Delete control on a thread note shows for its author
// or an admin — the same rule ticketService.deleteNote applies on the server.
const note = (over = {}) => ({ id: 1, eventType: 'note', authorType: 'agent', actorEmail: 'terry@example.com', isPrivate: true, ...over });
const tp = (over = {}) => ({ origin: 'ticketpulse', isAdmin: false, actorEmail: 'terry@example.com', readOnly: false, ...over });

describe('canDeleteNoteEntry', () => {
  test('the author sees Delete on their own note (case and spaces ignored)', () => {
    expect(canDeleteNoteEntry(note(), tp())).toBe(true);
    expect(canDeleteNoteEntry(note({ actorEmail: ' Terry@Example.com ' }), tp())).toBe(true);
  });

  test('someone else does not', () => {
    expect(canDeleteNoteEntry(note(), tp({ actorEmail: 'olga@example.com' }))).toBe(false);
  });

  test('an admin sees it on any note', () => {
    expect(canDeleteNoteEntry(note(), tp({ isAdmin: true, actorEmail: 'ada@example.com' }))).toBe(true);
    expect(canDeleteNoteEntry(note({ actorEmail: null }), tp({ isAdmin: true, actorEmail: 'ada@example.com' }))).toBe(true);
  });

  test('a note with no author e-mail is nobody’s own — not even for a viewer with no e-mail', () => {
    expect(canDeleteNoteEntry(note({ actorEmail: null }), tp())).toBe(false);
    expect(canDeleteNoteEntry(note({ actorEmail: null }), tp({ actorEmail: '' }))).toBe(false);
    expect(canDeleteNoteEntry(note({ actorEmail: '' }), tp({ actorEmail: null }))).toBe(false);
  });

  test('the read-only role never sees it', () => {
    expect(canDeleteNoteEntry(note(), tp({ readOnly: true }))).toBe(false);
  });

  test('FreshService tickets: nobody, author or admin', () => {
    expect(canDeleteNoteEntry(note(), tp({ origin: 'freshservice' }))).toBe(false);
    expect(canDeleteNoteEntry(note(), tp({ origin: 'freshservice', isAdmin: true }))).toBe(false);
    expect(canDeleteNoteEntry(note(), tp({ origin: null }))).toBe(false);
  });

  test('only internal notes: replies, forwards, synced private notes and system notes stay', () => {
    for (const eventType of ['reply', 'forward', 'customer_reply', 'private_note']) {
      expect(canDeleteNoteEntry(note({ eventType }), tp())).toBe(false);
      expect(canDeleteNoteEntry(note({ eventType }), tp({ isAdmin: true }))).toBe(false);
    }
    expect(canDeleteNoteEntry(note({ authorType: 'system' }), tp({ isAdmin: true }))).toBe(false);
  });

  test('no entry, no options: false', () => {
    expect(canDeleteNoteEntry(null, tp())).toBe(false);
    expect(canDeleteNoteEntry(note())).toBe(false);
  });
});
