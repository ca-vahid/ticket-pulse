import { describe, expect, test } from '@jest/globals';
import {
  capFullBody, contextLine, detectInlineAnswers, htmlToLines, inlineAnswersHtml, inlineAnswersText, safeSlice, safeTail, withoutOriginalBody,
} from '../src/utils/inlineAnswers.js';
import { stripQuotedHtml } from '../src/utils/replyQuoteStripper.js';
import {
  EXPECTED_CONTEXTS, REPLY_INLINE_DESKTOP, REPLY_INLINE_WEB, REPLY_OLDER_MESSAGE, REPLY_PLAIN_TEXT, REPLY_TOP_POSTED,
  REPLY_TWO_LINE_ANSWER, SENT_HTML, SENT_SIGNATURE_TEXT, SENT_TEXT,
} from './fixtures/inlineAnswersFixtures.js';

/**
 * Inline answers (20 Nov 2026): a requester typed the answers under each of the
 * agent's questions inside the quote and wrote only "Please see below" on top.
 * The quote is compared with the agent's message; what was added is an answer,
 * paired with the line of our message it follows.
 */

describe('detectInlineAnswers — answers typed inside the quote', () => {
  test('Outlook desktop reply: three pairs with the questions as context lines', () => {
    // The stripper keeps only the top line, which is why the answers were lost.
    expect(stripQuotedHtml(REPLY_INLINE_DESKTOP)).not.toContain('OK to proceed');
    const res = detectInlineAnswers({ replyHtml: REPLY_INLINE_DESKTOP, sentHtml: SENT_HTML, sentSignatureText: SENT_SIGNATURE_TEXT });
    expect(res.result).toBe('found');
    expect(res.answers.map((a) => a.context)).toEqual(EXPECTED_CONTEXTS);
    expect(res.answers.map((a) => a.answer)).toEqual([
      'OK to proceed.',
      'All three',
      'Only the query page, so they can filter however they want and grab files easily.',
    ]);
    expect(res.answers.every((a) => a.highlighted)).toBe(true);
  });

  test('Outlook on the web reply (older history and a hidden ref under the quote): the same three pairs', () => {
    const res = detectInlineAnswers({ replyHtml: REPLY_INLINE_WEB, sentHtml: SENT_HTML });
    expect(res.result).toBe('found');
    expect(res.answers.map((a) => a.context)).toEqual(EXPECTED_CONTEXTS);
    expect(res.answers[1].answer).toBe('All three');
    // The earlier message under the quote and the disclaimer are not answers.
    expect(JSON.stringify(res.answers)).not.toMatch(/metadata on each file|Privacy notice|ref:hidden/);
  });

  test('a top-posted reply with an unchanged quote: no section', () => {
    const res = detectInlineAnswers({ replyHtml: REPLY_TOP_POSTED, sentHtml: SENT_HTML, sentSignatureText: SENT_SIGNATURE_TEXT });
    expect(res.result).toBe('none');
    expect(res.answers).toEqual([]);
  });

  test('a reply quoting an older message we cannot match: no section', () => {
    const res = detectInlineAnswers({ replyHtml: REPLY_OLDER_MESSAGE, sentHtml: SENT_HTML });
    expect(res.result).toBe('unreliable');
    expect(res.answers).toEqual([]);
  });

  test('an answer over two lines is one answer', () => {
    const res = detectInlineAnswers({ replyHtml: REPLY_TWO_LINE_ANSWER, sentHtml: SENT_HTML });
    expect(res.result).toBe('found');
    expect(res.answers).toHaveLength(1);
    expect(res.answers[0].context).toBe(EXPECTED_CONTEXTS[1]);
    expect(res.answers[0].answer).toBe('All three, please.\nKeep the folder names as they are on the hub.');
  });

  test('a plain-text reply with ">" prefixes and different line wrapping is still detected', () => {
    for (const sent of [{ sentText: SENT_TEXT }, { sentHtml: SENT_HTML }]) {
      const res = detectInlineAnswers({ replyText: REPLY_PLAIN_TEXT, ...sent });
      expect(res.result).toBe('found');
      expect(res.answers).toEqual([
        { context: EXPECTED_CONTEXTS[0], answer: 'Yes, go ahead.', highlighted: false },
        { context: EXPECTED_CONTEXTS[1], answer: 'Only the first two.', highlighted: false },
      ]);
    }
  });

  test('more than ~60% of the quote is new (a forwarded thread around a short message): unreliable', () => {
    const sent = '<p>Can you confirm the room number please?</p>';
    const reply = '<div>See below</div><div id="appendonsend"></div><hr><div><b>From:</b> Dana<br><b>Sent:</b> Friday<br><b>To:</b> Priya</div>'
      + '<div>Can you confirm the room number please?</div>'
      + '<div>Here is a long forwarded conversation about the move, the boxes, the parking passes, the new keys, the badge office hours and the floor plan for the third floor that has nothing to do with the question.</div>';
    const res = detectInlineAnswers({ replyHtml: reply, sentHtml: sent });
    expect(res.result).toBe('unreliable');
    expect(res.reason).toBe('mostly_new');
  });

  test('nothing to compare with: unreliable, never throws', () => {
    expect(detectInlineAnswers({ replyHtml: REPLY_INLINE_DESKTOP, sentHtml: '' }).result).toBe('unreliable');
    expect(detectInlineAnswers({}).result).toBe('none');
  });
});

describe('helpers', () => {
  test('hidden elements are skipped and highlight boundaries split words', () => {
    const lines = htmlToLines('<div>fresh?<span style="background:yellow">OK</span></div><div style="display:none">secret</div>');
    expect(lines).toHaveLength(1);
    expect(lines[0].words.map((w) => [w.s, w.hl])).toEqual([['fresh?', false], ['OK', true]]);
  });

  test('context lines lose their list number and are cut from the front with "…"', () => {
    expect(contextLine('2. Should all three folders go?')).toBe('Should all three folders go?');
    const long = `${'word '.repeat(40)}end of the question?`;
    const out = contextLine(long);
    expect(out.startsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('end of the question?')).toBe(true);
  });

  test('the FreshService copy gets the pairs as simple, escaped HTML', () => {
    const html = inlineAnswersHtml([{ context: 'Is <it> OK?', answer: 'Yes\nToday' }, { context: '', answer: 'dropped' }]);
    expect(html).toBe('<p><b>Answered inline</b></p><p><b>Is &lt;it&gt; OK?</b><br>Yes<br>Today</p>');
    expect(inlineAnswersHtml(null)).toBe('');
    expect(inlineAnswersHtml([])).toBe('');
    expect(inlineAnswersText([{ context: 'Q?', answer: 'A' }])).toBe('Answered inline\nQ?\nA');
  });

  test('the full body is capped: styles and inline pictures go first, then it is cut', () => {
    const big = `<style>${'x'.repeat(300)}</style><p>hello</p><img src="data:image/png;base64,${'A'.repeat(300)}">`;
    expect(capFullBody(big, 200)).toEqual({ html: '<p>hello</p><img src="">', truncated: false });
    expect(capFullBody('<p>'.padEnd(500, 'y'), 100)).toEqual({ html: '<p>'.padEnd(100, 'y'), truncated: true });
  });

  test('a cut never splits an emoji (Postgres refuses half a surrogate pair)', () => {
    const smile = String.fromCodePoint(0x1f600);
    // capFullBody: the cap lands between the two halves of the emoji.
    const body = `${'a'.repeat(9)}${smile}bbbb`;
    const capped = capFullBody(body, 10);
    expect(capped).toEqual({ html: 'a'.repeat(9), truncated: true });
    expect(capped.html.isWellFormed()).toBe(true);
    expect(safeSlice(`ab${smile}`, 3)).toBe('ab');
    expect(safeTail(`${smile}cd`, 1)).toBe('cd');
    // contextLine: the front cut lands inside an emoji.
    const long = `${smile}${'x'.repeat(119)} end?`.replace(/x{10}/g, (m) => `${m} `);
    for (let pad = 0; pad < 4; pad += 1) {
      const out = contextLine(`${'y'.repeat(pad)}${long}`);
      expect(out.isWellFormed()).toBe(true);
      expect(JSON.parse(JSON.stringify(out))).toBe(out);
    }
    // answerText: an answer over the length cap, the emoji exactly on the cut.
    const answer = `${'a'.repeat(1498)}${smile}tail`;
    const reply = `<div>See below</div><div id="appendonsend"></div><hr><div><b>From:</b> Dana<br><b>Sent:</b> Friday<br><b>To:</b> Priya</div>${SENT_HTML.replace('start fresh?', `start fresh? ${answer}`)}`;
    const res = detectInlineAnswers({ replyHtml: reply, sentHtml: SENT_HTML });
    expect(res.result).toBe('found');
    expect(res.answers[0].answer.isWellFormed()).toBe(true);
    expect(res.answers[0].answer.endsWith(`${'a'.repeat(3)}…`)).toBe(true);
  });

  test('Outlook plain-text link rewrites ("guide<https://…>", "a@b<mailto:…>") are not answers', () => {
    const sentHtml = '<p>Hi Priya,</p><p>Please follow the <a href="https://kb.example.com/vpn">guide</a> to set up the VPN on the new laptop.</p>'
      + '<p>If it fails, write to <a href="mailto:help@example.com">help@example.com</a> and we will call you back.</p><p>Thanks,</p><p>Dana</p>';
    const replyText = [
      'Thanks, will do.',
      '',
      'On Fri, Nov 20, 2026 at 3:03 PM Dana Fox <it@example.com> wrote:',
      '> Hi Priya,',
      '>',
      '> Please follow the guide<https://kb.example.com/vpn> to set up the VPN on',
      '> the new laptop.',
      '>',
      '> If it fails, write to help@example.com<mailto:help@example.com> and we will',
      '> call you back.',
      '>',
      '> Thanks,',
      '> Dana',
    ].join('\n');
    const res = detectInlineAnswers({ replyText, sentHtml });
    expect(res.result).toBe('none');
    expect(res.answers).toEqual([]);
  });

  test('the ticket page gets a flag, not the stored original', () => {
    const entry = { id: 1, rawPayload: { cc_emails: ['a@example.com'], fullBodyHtml: '<p>all</p>', inlineAnswers: [] } };
    expect(withoutOriginalBody(entry)).toEqual({ id: 1, rawPayload: { cc_emails: ['a@example.com'], inlineAnswers: [], hasOriginalEmail: true } });
    const plain = { id: 2, rawPayload: { cc_emails: [] } };
    expect(withoutOriginalBody(plain)).toBe(plain);
    expect(withoutOriginalBody({ id: 3, rawPayload: null })).toEqual({ id: 3, rawPayload: null });
  });
});
