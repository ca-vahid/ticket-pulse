// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fsSystemEntryKind } from './fsSystemEntry';
import { buildHistoryItems } from './ticketHistory';
import { isConversationEntry } from '../components/tickets/ticketUi';

// QA 10-13 #5: "<Name> has submitted the survey response" is FreshService
// talking, not the requester. It leaves the Conversation and becomes one
// quiet History row, for new rows and for the rows stored before the fix.
const at = '2026-10-13T15:49:51.000Z';
const newRow = { id: 1, source: 'freshservice_reconciliation', eventType: 'activity', authorType: 'system', actorName: 'FreshService', incoming: false, isPrivate: false, bodyText: 'Daniel Israel has submitted the survey response', occurredAt: at, rawPayload: { tpSystemKind: 'survey_response' } };
const oldMirrorRow = { id: 2, source: 'freshservice_reconciliation', eventType: 'reply', authorType: 'requester', actorName: 'FreshService user', incoming: true, isPrivate: false, bodyText: 'Daniel Israel has submitted the survey response', occurredAt: at, rawPayload: { fsUpdatedAt: at } };
const oldFsRow = { id: 3, source: 'freshservice_conversation', eventType: 'customer_reply', incoming: true, isPrivate: false, bodyText: 'Saeid Ahadi has submitted the survey response', occurredAt: at, rawPayload: { source: 5 } };
const realReply = { id: 4, source: 'freshservice_conversation', eventType: 'customer_reply', incoming: true, isPrivate: false, bodyText: 'I filled in the survey response and it is still broken', occurredAt: at, rawPayload: { source: 0 } };
const mailReply = { id: 5, source: 'email_inbound', eventType: 'reply', authorType: 'requester', incoming: true, bodyText: 'Karen Wong has submitted the survey response', occurredAt: at };

describe('fsSystemEntryKind', () => {
  it('recognises new and previously stored survey lines', () => {
    expect(fsSystemEntryKind(newRow)).toBe('survey_response');
    expect(fsSystemEntryKind(oldMirrorRow)).toBe('survey_response');
    expect(fsSystemEntryKind(oldFsRow)).toBe('survey_response');
  });

  it('leaves real messages alone', () => {
    expect(fsSystemEntryKind(realReply)).toBeNull();
    expect(fsSystemEntryKind(mailReply)).toBeNull(); // only FreshService-fed rows
    expect(fsSystemEntryKind(null)).toBeNull();
  });
});

describe('where a survey line shows', () => {
  it('is not a conversation message', () => {
    expect(isConversationEntry(newRow)).toBe(false);
    expect(isConversationEntry(oldMirrorRow)).toBe(false);
    expect(isConversationEntry(oldFsRow)).toBe(false);
    expect(isConversationEntry(realReply)).toBe(true);
  });

  it('is one History row from FreshService', () => {
    const items = buildHistoryItems({ thread: [oldMirrorRow, realReply] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ actor: 'FreshService', machine: true, verb: 'survey response submitted', detail: 'Daniel Israel has submitted the survey response' });
  });
});
