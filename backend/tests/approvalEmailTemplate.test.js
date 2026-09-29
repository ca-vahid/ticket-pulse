/**
 * Approval e-mail templates (MEGA-0901 AP-2): Outlook-safe shell, pasted-table
 * normalization, description excerpt, and the load-bearing sentence shapes.
 */
import { describe, expect, test } from '@jest/globals';
import {
  dropEmptyTableColumns, normalizeNoteHtmlForEmail, textExcerpt, initialsOf,
  renderApproverRequestEmail, decisionIntentUrl, renderRequesterDecisionEmail, renderRequesterClarificationEmail,
} from '../src/services/approvalEmailTemplate.js';

const PASTE = '<table width="1400" style="width:1400px"><tr>'
  + '<td width="30" style="width:30px">10</td><td>MP2V5N1L</td><td style="background:#cfe2f3"></td><td></td><td>Lenovo</td><td>&nbsp;</td><td>32 GB</td>'
  + '</tr><tr><td>11</td><td>ABC</td><td></td><td></td><td>Dell</td><td></td><td>16 GB</td></tr></table>';

describe('dropEmptyTableColumns', () => {
  test('removes columns that are blank in every row and keeps the rest in order', () => {
    const out = dropEmptyTableColumns(PASTE);
    expect(out.match(/<td/g)).toHaveLength(8);
    expect(out).toContain('<td width="30" style="width:30px">10</td><td>MP2V5N1L</td><td>Lenovo</td><td>32 GB</td>');
    expect(out).toContain('<td>11</td><td>ABC</td><td>Dell</td><td>16 GB</td>');
  });
  test('leaves tables with colspan/rowspan untouched', () => {
    const t = '<table><tr><td colspan="2">a</td><td></td></tr></table>';
    expect(dropEmptyTableColumns(t)).toBe(t);
  });
  test('drops fully empty rows', () => {
    const t = '<table><tr><td>a</td><td>b</td></tr><tr><td></td><td>&nbsp;</td></tr></table>';
    expect(dropEmptyTableColumns(t).match(/<tr/g)).toHaveLength(1);
  });
});

describe('normalizeNoteHtmlForEmail', () => {
  test('strips fixed widths and pasted styles, adds borders + padding, wraps in a scroll container', () => {
    const out = normalizeNoteHtmlForEmail(`<p>Quote:</p>${PASTE}`);
    expect(out).not.toContain('width="1400"');
    expect(out).not.toContain('width:1400px');
    expect(out).not.toContain('#cfe2f3');
    expect(out).toContain('border:1px solid #cbd5e1;padding:6px 8px');
    expect(out).toContain('<div style="overflow-x:auto;max-width:100%;"><table cellpadding="0" cellspacing="0" border="0"');
    expect(out.match(/<td/g)).toHaveLength(8);
    expect(out).toContain('<p style="margin:0 0 8px">Quote:</p>');
  });
  test('keeps links (styled, new tab) and drops scripts/images', () => {
    const out = normalizeNoteHtmlForEmail('<p>see <a href="https://x.io/q">quote</a><img src="https://x.io/a.png"><script>x()</script></p>');
    expect(out).toContain('<a href="https://x.io/q" target="_blank" rel="noreferrer" style="color:#2563eb">quote</a>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('script');
  });
  test('empty input → empty string', () => {
    expect(normalizeNoteHtmlForEmail('')).toBe('');
    expect(normalizeNoteHtmlForEmail(null)).toBe('');
  });
});

describe('textExcerpt', () => {
  test('flattens HTML to text, keeps paragraph breaks, and cuts on a word boundary', () => {
    const html = `<p>Hi,</p><p>${'word '.repeat(200)}</p>`;
    const out = textExcerpt(html, 100);
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith('Hi,\nword word')).toBe(true);
    expect(out.text.endsWith('…')).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(101);
  });
  test('short text is returned whole and entities are decoded', () => {
    expect(textExcerpt('<p>A &amp; B</p>')).toEqual({ text: 'A & B', truncated: false });
    expect(textExcerpt('')).toEqual({ text: '', truncated: false });
  });
  test('initials', () => {
    expect(initialsOf('Ingrid Berru Garcia')).toBe('IG');
    expect(initialsOf('Reza')).toBe('R');
    expect(initialsOf('')).toBe('?');
  });
});

const baseCtx = () => ({
  workspaceName: 'IT',
  categoryName: 'New Computer Upgrade',
  ticket: { ref: '#239934', subject: 'Laptop <b>fails</b>', createdAt: '2026-08-31T18:00:00Z', dueBy: '2026-09-04T22:00:00Z', priorityLabel: 'Medium', typeLabel: 'Incident', categoryPath: 'Devices › Laptops', statusLabel: 'Pending', description: '<p>It shuts down.</p>', appUrl: 'https://app/tickets/1' },
  requester: { name: 'Ingrid Berru Garcia', title: 'Engineer', department: 'Vancouver', location: 'Vancouver' },
  requestedByName: 'Marcus Blackstock',
  noteHtml: '<p>Quote below</p>',
  otherApprovers: [{ name: 'Reza Zaim', status: 'pending' }],
  decisionUrl: 'https://app/approval/tok',
  expiresAt: '2026-10-02T17:37:00Z',
});

describe('renderApproverRequestEmail', () => {
  // 29 Sep 2026 redesign (mockups C1 + D3): category title, linked ticket ref,
  // decision row at the end with ?intent= links, surfaces never painted.
  test('carries every fact the page shows, escapes user text, and ends with the decision row', () => {
    const html = renderApproverRequestEmail(baseCtx());
    // Title is the category; the ticket ref links to the ticket, subject beside it.
    expect(html).toContain('>New Computer Upgrade<');
    expect(html).toContain('href="https://app/tickets/1"');
    expect(html).toContain('#239934&nbsp;&#8599;');
    expect(html).toContain('Laptop &lt;b&gt;fails&lt;/b&gt;');
    // No greeting / "asks you to approve" sentence — the people row names them.
    expect(html).not.toContain('asks you to approve');
    expect(html).not.toContain('Your decision is needed');
    expect(html).toContain('Requested for');
    expect(html).toContain('Ingrid Berru Garcia');
    expect(html).toContain('>IG<');
    // Title and place on one line; department == location → printed once.
    expect(html).toContain('Engineer · Vancouver');
    expect(html).not.toContain('Vancouver · Vancouver');
    expect(html).toContain('Asked by');
    expect(html).toContain('Marcus Blackstock');
    expect(html).toContain('Devices › Laptops');
    expect(html).toContain('Sep 4'); // due
    expect(html).toContain('Why Marcus is asking');
    expect(html).toContain('What Ingrid wrote');
    expect(html).toContain('It shuts down.');
    expect(html).toContain('Also asked to approve');
    expect(html).toContain('Reza Zaim');
    // Decision row: Approve half, Decline and Ask a quarter; each pre-picks its choice.
    expect(html).toContain('href="https://app/approval/tok?intent=approve"');
    expect(html).toContain('href="https://app/approval/tok?intent=reject"');
    expect(html).toContain('href="https://app/approval/tok?intent=ask"');
    expect(html.indexOf('intent=approve')).toBeGreaterThan(html.indexOf('It shuts down.'));
    expect(html).toContain('<td width="50%" valign="top" style="padding:0 4px 0 0px;">');
    expect(html).toContain('expires on October 2, 2026');
    expect(html).toContain('IT workspace');
    // No raw e-mail addresses, no data URIs, no painted page/card background.
    expect(html).not.toMatch(/@[a-z]+\.[a-z]+/);
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('background:#f1f5f9');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });
  test('re-request shows the Q&A first', () => {
    const html = renderApproverRequestEmail({ ...baseCtx(), reRequest: true, clarification: { question: 'Refurb ok?', answer: 'No stock.' } });
    expect(html).toContain('Re-requested with the answer you asked for');
    expect(html).toContain('<b>You asked:</b> Refurb ok?');
    expect(html).toContain('<b>Marcus Blackstock replied:</b> No stock.');
    expect(html.indexOf('Refurb ok?')).toBeLessThan(html.indexOf('Why Marcus is asking'));
  });
  test('renders inline (cid:) photos when attachments exist, initials otherwise', () => {
    const ctx = baseCtx();
    ctx.requester.photoCid = 'requester-photo';
    ctx.requestedByPhotoCid = 'requested-by-photo';
    const html = renderApproverRequestEmail(ctx);
    expect(html).toContain('<img src="cid:requester-photo" width="38" height="38" alt="IG"');
    expect(html).toContain('<img src="cid:requested-by-photo" width="38" height="38" alt="MB"');
    expect(html).not.toContain('>IG<');
    expect(html).not.toMatch(/src="https?:/);
    const plain = renderApproverRequestEmail(baseCtx());
    expect(plain).not.toContain('cid:requester-photo');
    expect(plain).not.toContain('cid:requested-by-photo');
    expect(plain).toContain('>IG<');
  });
  test('degrades without optional data', () => {
    const html = renderApproverRequestEmail({ ticket: { ref: 'TP-9', subject: 'x' }, decisionUrl: 'https://app/a', noteHtml: '', otherApprovers: [] });
    // No category → the subject is the title; the ref falls back to the approval page.
    expect(html).toContain('>x<');
    expect(html).toContain('href="https://app/a"');
    expect(html).not.toContain('is asking');
    expect(html).not.toContain(' wrote<');
    expect(html).not.toContain('Also asked');
    expect(html).toContain('href="https://app/a?intent=approve"');
  });
  test('decisionIntentUrl keeps an existing query string', () => {
    expect(decisionIntentUrl('https://app/a', 'ask')).toBe('https://app/a?intent=ask');
    expect(decisionIntentUrl('https://app/a?x=1', 'reject')).toBe('https://app/a?x=1&intent=reject');
    expect(decisionIntentUrl('', 'ask')).toBe('');
  });
});

describe('renderRequesterDecisionEmail / renderRequesterClarificationEmail', () => {
  const t = { ref: '#1', subject: 'S', appUrl: 'https://app/tickets/1' };
  test('sentence shapes are preserved', () => {
    expect(renderRequesterDecisionEmail({ ticket: t, approved: true, approverName: 'Boss', requester: { name: 'Rita' } }))
      .toContain('Boss decided your approval request for <b>Rita</b>: <span style="color:#065f46;font-weight:bold;">approved</span>');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: false, approverName: 'Boss', changedFrom: 'approved' }))
      .toContain('Boss changed the decision on your approval request: <span style="color:#991b1b;font-weight:bold;">not approved</span>');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: true, isSelf: true })).toContain('You approved your own approval request');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: false, isSelf: true, note: 'Too <b>pricey</b>' })).toContain('Your note');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: false, isSelf: true, note: 'Too <b>pricey</b>' })).toContain('Too &lt;b&gt;pricey&lt;/b&gt;');
  });
  test('clarification carries the question and an answer button', () => {
    const html = renderRequesterClarificationEmail({ workspaceName: 'IT', ticket: t, approverName: 'Vahid', question: 'Refurb <ok>?', requester: { name: 'Rita' } });
    expect(html).toContain('Needs your answer');
    expect(html).toContain('Vahid</b> needs more information before deciding the request for <b>Rita</b>');
    expect(html).toContain('Refurb &lt;ok&gt;?');
    expect(html).toContain('Answer on the ticket &rarr;');
  });
});

describe('brand pictograms (17 Sep 2026 redesign)', () => {
  test('the request e-mail carries no pictograms (29 Sep 2026 redesign) — only people photos, if any', () => {
    const html = renderApproverRequestEmail(baseCtx());
    expect(html).not.toContain('cid:tp-');
    expect(html).toContain('Service desk agent');
  });

  test('every verdict and hand-off e-mail names its pictogram', async () => {
    const { hasBrandAsset } = await import('../src/services/emailBrandAssets.js');
    if (!hasBrandAsset('kind-approved')) return;
    const t = { ref: '#1', subject: 'x', appUrl: 'https://app/t/1' };
    expect(renderRequesterDecisionEmail({ ticket: t, approved: true, approverName: 'Boss' })).toContain('cid:tp-kind-approved');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: true, approverName: 'Boss', conditionNote: 'UAT first' })).toContain('cid:tp-kind-condition');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: false, approverName: 'Boss' })).toContain('cid:tp-kind-rejected');
    expect(renderRequesterClarificationEmail({ ticket: t, approverName: 'Boss', question: 'Why?' })).toContain('cid:tp-kind-question');
  });
});
