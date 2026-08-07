// QA 08-06 #5 — shared real-HTML detector: plain text carrying angle-bracket
// tokens (<Processed>) must NOT be treated as HTML, while genuine markup must.
import { escapeHtml, looksLikeRealHtml, plainTextToHtml } from '../src/utils/htmlContent.js';

describe('looksLikeRealHtml', () => {
  test('plain text with bracketed tokens is NOT html', () => {
    expect(looksLikeRealHtml('Status changed to <Processed>')).toBe(false);
    expect(looksLikeRealHtml('<Pending Review> then <Approved>')).toBe(false);
    expect(looksLikeRealHtml('Use <YourName> as the placeholder')).toBe(false);
    expect(looksLikeRealHtml('a < b and b > c')).toBe(false);
    expect(looksLikeRealHtml('')).toBe(false);
    expect(looksLikeRealHtml(null)).toBe(false);
  });

  test('known html tags ARE html', () => {
    expect(looksLikeRealHtml('<p>hello</p>')).toBe(true);
    expect(looksLikeRealHtml('line one<br>line two')).toBe(true);
    expect(looksLikeRealHtml('<br/>')).toBe(true);
    expect(looksLikeRealHtml('<h2 style="color:#005A9C">Head</h2>')).toBe(true);
    expect(looksLikeRealHtml('text with </div> closer')).toBe(true);
    expect(looksLikeRealHtml('<A HREF="https://x">link</A>')).toBe(true);
    expect(looksLikeRealHtml('<table><tr><td>x</td></tr></table>')).toBe(true);
  });

  test('lookalike prefixes do not fool the detector', () => {
    // "Processed" starts with the real tag name "p" but is not <p ...>.
    expect(looksLikeRealHtml('<Processed>')).toBe(false);
    expect(looksLikeRealHtml('<Broken>')).toBe(false); // starts like <br
    expect(looksLikeRealHtml('<iframe src="x"></iframe>')).toBe(true);
  });
});

describe('plainTextToHtml', () => {
  test('escapes brackets and converts newlines so tokens stay visible', () => {
    expect(plainTextToHtml('Status: <Processed>\nID: 1260'))
      .toBe('Status: &lt;Processed&gt;<br>ID: 1260');
  });

  test('empty input returns null', () => {
    expect(plainTextToHtml('')).toBeNull();
    expect(plainTextToHtml('   ')).toBeNull();
    expect(plainTextToHtml(null)).toBeNull();
  });
});

describe('escapeHtml', () => {
  test('escapes the four html-significant characters', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});
