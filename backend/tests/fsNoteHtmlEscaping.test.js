import { describe, expect, test } from '@jest/globals';
import { unescapeIfEscaped } from '../src/services/freshServiceActionService.js';

/**
 * FR 09-10 — FreshService private notes showed literal `<p>` tags.
 *
 * The note body is HTML and the AI briefing is inserted into it raw, which is
 * right when `agentBriefingHtml` holds real markup. For some runs the model
 * returns it already entity-escaped and we store it verbatim, so
 * `&lt;p&gt;Juan Gonzalez…` renders as visible tags. Run 24271 is the reported
 * case; ~128 of 3,618 runs over 30 days carry the same shape.
 *
 * Decode ONLY when the value looks wholly escaped, so genuine HTML and prose
 * that merely mentions an entity are both left alone.
 */

describe('the reported case', () => {
  test('run 24271 decodes to real markup', () => {
    const stored = '&lt;p&gt;Juan Gonzalez (Digital Solutions Lead) is asking to have Azure billing '
      + 're-enabled for an AI-powered SharePoint feature.&lt;/p&gt;&lt;p&gt;This is being routed to you.&lt;/p&gt;';
    expect(unescapeIfEscaped(stored)).toBe(
      '<p>Juan Gonzalez (Digital Solutions Lead) is asking to have Azure billing '
      + 're-enabled for an AI-powered SharePoint feature.</p><p>This is being routed to you.</p>',
    );
  });
});

describe('what must NOT be touched', () => {
  test('real markup passes through unchanged — the 3,490 healthy runs', () => {
    const html = '<p>Requester is locked out of the VPN.</p><p>Routed on recent MFA work.</p>';
    expect(unescapeIfEscaped(html)).toBe(html);
  });

  test('prose that mentions entities is not mangled', () => {
    const prose = 'Values &lt; 5 and &gt; 2 were rejected by the form.';
    expect(unescapeIfEscaped(prose)).toBe(prose);
  });

  test('a double-escaped ampersand is not resurrected into a tag', () => {
    // &amp;lt;p&amp;gt; must stay text, not become <p>.
    const doubled = '&amp;lt;p&amp;gt;not a tag&amp;lt;/p&amp;gt;';
    expect(unescapeIfEscaped(doubled)).toBe(doubled);
  });

  test('mixed content with any real tag is left alone', () => {
    const mixed = '<b>Heads up</b> — the value was &lt;script&gt; in the original.';
    expect(unescapeIfEscaped(mixed)).toBe(mixed);
  });
});

describe('it never throws', () => {
  test.each([null, undefined, '', 0, false])('%p yields a string', (input) => {
    expect(typeof unescapeIfEscaped(input)).toBe('string');
  });

  test('a bare escaped entity with no tag shape is untouched', () => {
    expect(unescapeIfEscaped('&lt;')).toBe('&lt;');
    expect(unescapeIfEscaped('&amp;')).toBe('&amp;');
  });
});
