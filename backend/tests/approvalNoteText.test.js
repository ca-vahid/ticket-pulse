import { jest } from '@jest/globals';

/**
 * 23 Sep 2026 (TP-1567): approval notes were stored with HTML entities in the
 * plain text ("storage -&nbsp; instead of …"). cleanPlainNote decodes them on
 * the way in, for the request note and the decision / condition notes.
 */
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
const { cleanPlainNote } = await import('../src/services/ticketApprovalService.js');

test('decodes entities (also double-escaped), nbsp becomes a space, spacing tidied, line breaks kept', () => {
  expect(cleanPlainNote('in Our storage -&nbsp; instead of ordering,&nbsp; for 1 person?&nbsp;'))
    .toBe('in Our storage - instead of ordering, for 1 person?');
  expect(cleanPlainNote('a &amp;nbsp; b &lt;ok&gt; &#39;x&#39; &#x2014; y')).toBe("a b <ok> 'x' — y");
  expect(cleanPlainNote('one\n\n\n\ntwo  three')).toBe('one\n\ntwo three');
  expect(cleanPlainNote('   ')).toBeNull();
  expect(cleanPlainNote(null)).toBeNull();
  expect(cleanPlainNote('R&D budget & more')).toBe('R&D budget & more');
});
