/**
 * Approval e-mail templates (MEGA-0901 AP-2): Outlook-safe shell, pasted-table
 * normalization, description excerpt, and the load-bearing sentence shapes.
 */
import { describe, expect, test } from '@jest/globals';
import {
  dropEmptyTableColumns, normalizeNoteHtmlForEmail, textExcerpt, initialsOf,
  renderApproverRequestEmail, renderRequesterDecisionEmail, renderRequesterClarificationEmail,
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
  test('carries every fact the page shows, escapes user text, and has one primary button', () => {
    const html = renderApproverRequestEmail(baseCtx());
    expect(html).toContain('Approval requested');
    expect(html).toContain('New Computer Upgrade approval — your decision is needed');
    expect(html).toContain('Laptop &lt;b&gt;fails&lt;/b&gt;');
    expect(html).toContain('#239934  ·  created Aug 31  ·  due Sep 4');
    expect(html).toContain('Requested for');
    expect(html).toContain('Ingrid Berru Garcia');
    expect(html).toContain('>IG<');
    expect(html).toContain('Engineer · Vancouver'); // department == location → printed once
    expect(html).not.toContain('Vancouver · Vancouver');
    expect(html).toContain('Asked by');
    expect(html).toContain('Marcus Blackstock');
    expect(html).toContain('Devices › Laptops');
    expect(html).toContain('Note from Marcus Blackstock');
    expect(html).toContain('Ticket description');
    expect(html).toContain('It shuts down.');
    expect(html).toContain('Also asked to approve');
    expect(html).toContain('Reza Zaim');
    expect(html).toContain('href="https://app/approval/tok"');
    expect(html).toContain('Review and decide &rarr;');
    expect(html).toContain('expires on October 2, 2026');
    expect(html).toContain('open the ticket in Ticket Pulse');
    expect(html).toContain('IT workspace');
    // No raw e-mail addresses, no data URIs.
    expect(html).not.toMatch(/@[a-z]+\.[a-z]+/);
    expect(html).not.toContain('data:image');
  });
  test('re-request shows the Q&A and a different pill/button', () => {
    const html = renderApproverRequestEmail({ ...baseCtx(), reRequest: true, clarification: { question: 'Refurb ok?', answer: 'No stock.' } });
    expect(html).toContain('Re-requested');
    expect(html).toContain('re-requested with the answer you asked for');
    expect(html).toContain('<b>You asked:</b> Refurb ok?');
    expect(html).toContain('<b>Marcus Blackstock replied:</b> No stock.');
    expect(html).toContain('Review the answer and decide &rarr;');
  });
  test('renders inline (cid:) photos when attachments exist, initials otherwise', () => {
    const ctx = baseCtx();
    ctx.requester.photoCid = 'requester-photo';
    ctx.requestedByPhotoCid = 'requested-by-photo';
    const html = renderApproverRequestEmail(ctx);
    expect(html).toContain('<img src="cid:requester-photo" width="40" height="40" alt="IG"');
    expect(html).toContain('<img src="cid:requested-by-photo" width="32" height="32" alt="MB"');
    expect(html).not.toContain('>IG<');
    expect(html).not.toMatch(/src="https?:/);
    const plain = renderApproverRequestEmail(baseCtx());
    expect(plain).not.toContain('cid:');
    expect(plain).toContain('>IG<');
  });
  test('degrades without optional data', () => {
    const html = renderApproverRequestEmail({ ticket: { ref: 'TP-9', subject: 'x' }, decisionUrl: 'https://app/a', noteHtml: '', otherApprovers: [] });
    expect(html).toContain('Approval — your decision is needed');
    expect(html).not.toContain('Note from');
    expect(html).not.toContain('Ticket description');
    expect(html).not.toContain('Also asked');
    expect(html).toContain('Review and decide');
  });
});

describe('renderRequesterDecisionEmail / renderRequesterClarificationEmail', () => {
  const t = { ref: '#1', subject: 'S', appUrl: 'https://app/tickets/1' };
  test('sentence shapes are preserved', () => {
    expect(renderRequesterDecisionEmail({ ticket: t, approved: true, approverName: 'Boss', requester: { name: 'Rita' } }))
      .toContain('Boss decided your approval request for <b>Rita</b>: <span style="color:#065f46;font-weight:bold;">APPROVED</span>');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: false, approverName: 'Boss', changedFrom: 'approved' }))
      .toContain('Boss changed the decision on your approval request: <span style="color:#991b1b;font-weight:bold;">REJECTED</span>');
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
