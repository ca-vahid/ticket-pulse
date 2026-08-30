import {
  FS_CONVERSATION_PREFIX,
  LEGACY_FS_CONV_PREFIX,
  fsConversationEntryId,
  fsConversationEntryIdCandidates,
  isFsConversationEntryId,
  legacyFsConversationEntryId,
  parseFsConversationId,
} from '../src/utils/fsEntryId.js';

/**
 * Mega 08-30 Phase DR1 — one namespace for FS conversation stamps. The live
 * write, the reconcile import and the FS conversation sync all mint
 * `fs-conversation:<id>`; the parser still reads the legacy `fs-conv-<id>`.
 */
describe('fsEntryId', () => {
  test('mints the canonical fs-conversation:<id> stamp', () => {
    expect(fsConversationEntryId(1042916725)).toBe('fs-conversation:1042916725');
    expect(fsConversationEntryId('42001')).toBe('fs-conversation:42001');
    expect(fsConversationEntryId(BigInt(7))).toBe('fs-conversation:7');
    expect(FS_CONVERSATION_PREFIX).toBe('fs-conversation:');
    expect(LEGACY_FS_CONV_PREFIX).toBe('fs-conv-');
  });

  test('refuses an empty id (a stamp without an id would collide across conversations)', () => {
    expect(() => fsConversationEntryId(null)).toThrow(TypeError);
    expect(() => fsConversationEntryId('')).toThrow(TypeError);
    expect(() => legacyFsConversationEntryId(undefined)).toThrow(TypeError);
  });

  test('parses BOTH the canonical and the legacy prefix (longest prefix first)', () => {
    expect(parseFsConversationId('fs-conversation:1042916725')).toBe('1042916725');
    expect(parseFsConversationId('fs-conv-1042916725')).toBe('1042916725');
    expect(parseFsConversationId('fs-conv-555')).toBe('555');
  });

  test('does not mistake other stamps for a conversation', () => {
    expect(parseFsConversationId('fs-conversation-fallback:abc123')).toBeNull();
    expect(parseFsConversationId('mirror-9001')).toBeNull();
    expect(parseFsConversationId('fs-conversation:')).toBeNull();
    expect(parseFsConversationId('fs-conv-')).toBeNull();
    expect(parseFsConversationId(null)).toBeNull();
    expect(parseFsConversationId(undefined)).toBeNull();
    expect(parseFsConversationId(42)).toBeNull();
    expect(isFsConversationEntryId('fs-conversation:1')).toBe(true);
    expect(isFsConversationEntryId('fs-conv-1')).toBe(true);
    expect(isFsConversationEntryId('mirror-1')).toBe(false);
  });

  test('candidates list the canonical stamp first, then the legacy one', () => {
    expect(fsConversationEntryIdCandidates(88001)).toEqual(['fs-conversation:88001', 'fs-conv-88001']);
  });
});
