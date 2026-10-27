/**
 * Approval e-mail templates (MEGA-0901 AP-2): pasted-table normalization,
 * description excerpt, and — since 26 Oct 2026 — the reply format every
 * approval e-mail shares: the sender's words, one grey hint, one plain link,
 * no card, no buttons, no painted surfaces.
 */
import { describe, expect, test } from '@jest/globals';
import {
  dropEmptyTableColumns, normalizeNoteHtmlForEmail, textExcerpt, initialsOf,
  renderApproverRequestEmail, decisionIntentUrl, renderRequesterDecisionEmail, renderRequesterClarificationEmail,
  renderRequesterHandoffEmail, renderDecisionThreadEmail, renderApprovalMessageEmail, renderConditionsEmail,
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
    expect(initialsOf('Rita Ann Requester')).toBe('RR');
    expect(initialsOf('Pat')).toBe('P');
    expect(initialsOf('')).toBe('?');
  });
});

/** What no reply-format e-mail may carry: card chrome, buttons, painted surfaces, pictograms. */
function expectPlainMessage(html) {
  expect(html).not.toMatch(/<!DOCTYPE|<html|<body/i);
  expect(html).not.toMatch(/background(-color)?:/i);
  expect(html).not.toMatch(/bgcolor=/i);
  expect(html).not.toContain('gradient');
  expect(html).not.toContain('cid:tp-');
  expect(html).not.toContain('Sent by Ticket Pulse');
  expect(html).not.toContain('&#9679;'); // no status dots
  expect(html).not.toContain('border-radius:7px'); // no buttons
}

const baseCtx = () => ({
  categoryName: 'New Computer Upgrade',
  ticket: { ref: '#239934', subject: 'Laptop <b>fails</b>', appUrl: 'https://app/tickets/1' },
  requester: { name: 'Rita Requester', title: 'Engineer', department: 'Vancouver', location: 'Vancouver' },
  requestedByName: 'Mia Agent',
  approverName: 'Pat Approver',
  noteHtml: '<p>Quote below</p>',
  otherApprovers: [{ name: 'Lee Second', status: 'pending' }],
  decisionUrl: 'https://app/approval/tok',
  expiresAt: '2026-10-02T17:37:00Z',
});

describe('renderApproverRequestEmail — the agent\'s message to the approver', () => {
  test('greeting, one sentence of what is asked, the note as written, facts, one decide link and the hint', () => {
    const html = renderApproverRequestEmail({ ...baseCtx(), amountLabel: 'CAD 2,400.00', tierLabel: 'Tier 2', signatureHtml: '<p>Mia Agent · IT</p>' });
    expectPlainMessage(html);
    expect(html).toContain('Hi Pat,');
    // Title and place once (department == location), the ref linked to the ticket.
    expect(html).toContain('Mia Agent asks you to approve New Computer Upgrade for Rita Requester (Engineer, Vancouver) on <a href="https://app/tickets/1"');
    expect(html).not.toContain('Vancouver, Vancouver');
    expect(html).toContain('<p>Quote below</p>');
    expect(html).toContain('Amount:</span> CAD 2,400.00');
    expect(html).toContain('Approval tier:</span> Tier 2');
    expect(html).toContain('Also asked:</span> Lee Second. The first decision closes the request for everyone.');
    expect(html).toContain('Mia Agent · IT');
    // ONE decision link (the page has approve / conditions / ask / no), after the signature.
    expect(html.match(/href="https:\/\/app\/approval\/tok"/g)).toHaveLength(1);
    expect(html).toContain('Decide on this request&nbsp;&rarr;');
    expect(html).not.toContain('intent=');
    expect(html.indexOf('Decide on this request')).toBeGreaterThan(html.indexOf('Mia Agent · IT'));
    expect(html).toContain('Approve, approve with conditions, ask a question or say no on that page. The link is yours alone and works until October 2, 2026.');
    expect(html).toContain('color:#6b7280');
    // User text is escaped; no addresses or photos up top.
    expect(renderApproverRequestEmail({ ...baseCtx(), categoryName: null })).toContain('&ldquo;Laptop &lt;b&gt;fails&lt;/b&gt;&rdquo;');
    expect(html).not.toContain('cid:');
  });

  test('the history is appended after the message', () => {
    const html = renderApproverRequestEmail({ ...baseCtx(), quoteHtml: '<p>Earlier in this conversation</p>' });
    expect(html.indexOf('Earlier in this conversation')).toBeGreaterThan(html.indexOf('Decide on this request'));
  });

  test('a re-request leads with the answer the approver asked for', () => {
    const html = renderApproverRequestEmail({ ...baseCtx(), clarification: { question: 'Refurb ok?', answer: 'No stock.', answeredBy: 'Rita Requester' } });
    expect(html).toContain('Here is the answer you asked for.');
    expect(html).toContain('You asked:</span> Refurb ok?');
    expect(html).toContain('Rita Requester replied:</span> No stock.');
    expect(html.indexOf('Refurb ok?')).toBeLessThan(html.indexOf('Quote below'));
  });

  test('hand-off lines say why it is with this approver, with their note', () => {
    const esc = renderApproverRequestEmail({ ...baseCtx(), handoff: { kind: 'escalated', byName: 'Lee Second', fromTierName: 'Tier 1', toTierName: 'Tier 2', note: 'Over my limit' } });
    expect(esc).toContain('Lee Second escalated this request from Tier 1 to you (Tier 2).');
    expect(esc).toContain('Their note:</span> Over my limit');
    expect(renderApproverRequestEmail({ ...baseCtx(), handoff: { kind: 'forwarded', byName: 'Lee' } })).toContain('forwarded this request to you as the final approver');
    expect(renderApproverRequestEmail({ ...baseCtx(), handoff: { kind: 'auto_start', toTierName: 'Tier 2', note: 'Mia is a Tier 1 approver' } })).toContain('comes to you at <b>Tier 2</b> directly: Mia is a Tier 1 approver.');
  });

  test('reserved devices are a fact line', () => {
    const html = renderApproverRequestEmail({ ...baseCtx(), laptops: [{ asset: { make: 'Dell', model: 'Latitude 7450', assetTag: 'TAG-1', cpu: 'i7', ram: '32 GB' }, recipient: { name: 'Rita Requester' } }] });
    expect(html).toContain('Device reserved:</span> Dell Latitude 7450 (TAG-1), i7 · 32 GB; goes to Rita Requester on approval');
  });

  test('degrades without optional data', () => {
    const html = renderApproverRequestEmail({ ticket: { ref: 'TP-9', subject: 'x' }, decisionUrl: 'https://app/a', noteHtml: '', otherApprovers: [] });
    expect(html).toContain('Hello,');
    expect(html).toContain('The service desk asks you to approve &ldquo;x&rdquo; on TP-9.');
    expect(html).not.toContain('Also asked');
    expect(html).toContain('href="https://app/a"');
  });

  test('decisionIntentUrl keeps an existing query string', () => {
    expect(decisionIntentUrl('https://app/a', 'ask')).toBe('https://app/a?intent=ask');
    expect(decisionIntentUrl('https://app/a?x=1', 'reject')).toBe('https://app/a?x=1&intent=reject');
    expect(decisionIntentUrl('', 'ask')).toBe('');
  });
});

describe('the verdict, as the approver\'s message', () => {
  const t = { ref: '#1', subject: 'S', appUrl: 'https://app/tickets/1' };
  test('agent copy: verdict first in plain words, conditions as a list, note, signature, one hint with the ticket link', () => {
    const html = renderRequesterDecisionEmail({ ticket: t, categoryName: 'Software', approved: true, approverName: 'Pat', conditionNote: 'UAT first\nNo prod data', note: 'Go ahead', signatureHtml: '<p>Pat · CFO</p>', requester: { name: 'Rita' } });
    expectPlainMessage(html);
    expect(html).toMatch(/^<p[^>]*><b>Approved with conditions\.<\/b> Software for Rita, <a href="https:\/\/app\/tickets\/1"/);
    expect(html).toContain('<li style="margin:0 0 6px;">UAT first</li><li style="margin:0 0 6px;">No prod data</li>');
    expect(html).toContain('Go ahead');
    expect(html).toContain('Pat · CFO');
    expect(html).toContain('You can carry on with the ticket, within the conditions.');
    expect(html).toContain('>Open the ticket</a>');
  });
  test('changed and self-decided copies say so', () => {
    expect(renderRequesterDecisionEmail({ ticket: t, approved: false, approverName: 'Pat', changedFrom: 'approved' })).toContain('<b>Not approved.</b> (changed from approved)');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: true, isSelf: true })).toContain('You decided your own request; this is your copy.');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: false, note: 'Too <b>pricey</b>' })).toContain('Too &lt;b&gt;pricey&lt;/b&gt;');
    expect(renderRequesterDecisionEmail({ ticket: t, approved: true, conditionNote: 'UAT only' })).toContain('Condition:</span> UAT only');
  });
  test('parties copy: the agent can carry on; the requester\'s copy carries no ticket link and nothing internal', () => {
    const toApprover = renderDecisionThreadEmail({ ticket: t, categoryName: 'Software', approved: true, approverName: 'Pat', requestedByName: 'Mia Agent', recipient: { role: 'approver', name: 'Lee' }, requester: { name: 'Rita' } });
    expectPlainMessage(toApprover);
    expect(toApprover).toContain('<b>Approved.</b> Software for Rita');
    expect(toApprover).toContain('Mia can carry on with the ticket.');
    expect(toApprover).toContain('href="https://app/tickets/1"');
    const toRita = renderDecisionThreadEmail({ ticket: { ...t, appUrl: null }, categoryName: 'Software', approved: true, approverName: 'Pat', requestedByName: 'Mia Agent', recipient: { role: 'requester', name: 'Rita' }, requester: { name: 'Rita' } });
    expect(toRita).toContain('<b>Approved.</b> Your Software request, #1.');
    expect(toRita).not.toContain('href=');
    expect(toRita).not.toContain('carry on');
    expect(toRita).toContain('If you have a question about this, reply to this e-mail.');
  });
});

describe('the agent-facing notices', () => {
  const t = { ref: 'TP-1', subject: 'S', appUrl: 'https://x/tickets/1' };
  test('hand-off: short sentence, no note, nothing to do, the ticket link', () => {
    const html = renderRequesterHandoffEmail({ ticket: t, kind: 'escalated', byName: 'Pat', toNames: ['Lee'], toTierName: 'Tier 2', requester: { name: 'Rita' }, agentName: 'Mia Agent' });
    expectPlainMessage(html);
    expect(html).toContain('Hi Mia,');
    expect(html).toContain('Pat escalated your approval request for Rita on <a href="https://x/tickets/1"');
    expect(html).toContain('to Lee (Tier 2).');
    expect(html).toContain('Nothing is needed from you; you will hear when it is decided.');
    expect(renderRequesterHandoffEmail({ ticket: t, kind: 'auto', byName: 'Pat', toNames: ['Lee'], fromTierName: 'Tier 1', toTierName: 'Tier 2' })).toContain('moved on to Lee (Tier 2)');
  });
  test('clarification: the approver\'s question in their words, then "Answer on the ticket →"', () => {
    const html = renderRequesterClarificationEmail({ ticket: t, approverName: 'Pat Approver', question: 'Refurb <ok>?', requester: { name: 'Rita' }, agentName: 'Mia' });
    expectPlainMessage(html);
    expect(html).toContain('Pat Approver needs more information before deciding the request for Rita on');
    expect(html).toContain('Refurb &lt;ok&gt;?');
    expect(html).toContain('Answer on the ticket&nbsp;&rarr;');
    expect(html).toContain('Your answer goes back to Pat by e-mail');
  });
  test('conditions: the list, not approved yet, the note, one link to answer', () => {
    const html = renderConditionsEmail({ approverName: 'Pat Approver', technicianName: 'Mia Agent', categoryName: 'Security', ticket: { ref: 'TP-1', subject: 'Dashboards', appUrl: 'https://tp/tickets/1' }, items: [{ text: 'Named workspaces only' }, { text: 'Audit log on' }], note: 'Security first', requester: { name: 'Rita' } });
    expectPlainMessage(html);
    expect(html).toContain('Hi Mia,');
    expect(html).toContain('Pat Approver will approve the Security request for Rita on');
    expect(html).toContain('on 2 conditions. It is not approved yet: answer each one and your answers go straight back to Pat.');
    expect(html).toContain('<li style="margin:0 0 6px;">Named workspaces only</li>');
    expect(html).toContain('Security first');
    expect(html).toContain('href="https://tp/tickets/1"');
    expect(html).toContain('Answer on the ticket&nbsp;&rarr;');
  });
});

describe('renderApprovalMessageEmail — internal questions, notes and answers', () => {
  test('the author\'s words and signature, one hint with the web link, the Internal line', () => {
    const html = renderApprovalMessageEmail({
      kind: 'question', authorName: 'Pat Approver', bodyText: 'Budget?\n\nWhich code?', signatureHtml: '<p>Pat · CFO</p>',
      replyUrl: 'https://app/approval-reply/t', canReplyByEmail: true, requesterName: 'Rita Requester', internalNote: true, copied: ['Lee'],
    });
    expectPlainMessage(html);
    expect(html).toMatch(/^<p[^>]*>Budget\?<\/p><p[^>]*>Which code\?<\/p>/);
    expect(html).toContain('Pat · CFO');
    expect(html).toContain('Just reply to this e-mail to answer, or <a href="https://app/approval-reply/t"');
    expect(html).toContain('Lee is copied.');
    expect(html).toContain('Internal: Rita is not on this conversation.');
  });
  test('an answer for an approver who decides carries the decide link; without a mailbox the web link is the way', () => {
    const answer = renderApprovalMessageEmail({ kind: 'answer', authorName: 'Mia Agent', bodyText: 'DEV only', canReplyByEmail: true, decideUrl: 'https://app/approval/x', internalNote: true, requesterName: 'Rita' });
    expect(answer).toContain('Mia answered. Reply to this e-mail to add to the conversation.');
    expect(answer).toContain('href="https://app/approval/x"');
    expect(answer).toContain('Decide on this request');
    const noMail = renderApprovalMessageEmail({ kind: 'question', authorName: 'Pat', bodyText: 'x', replyUrl: 'https://app/r', canReplyByEmail: false });
    expect(noMail).toContain('>Answer on the web</a>; this mailbox does not read replies.');
  });
});
