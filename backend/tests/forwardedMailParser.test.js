import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseForwardedMail, htmlToText, parseAddress, parseAddressList, parseHeaderDate,
  subjectPrefix, stripSubjectPrefixes, findHeaderBlock, sliceHtml, textToHtml,
} from '../src/utils/forwardedMailParser.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'forwards');
const fixture = (name) => readFileSync(path.join(dir, name), 'utf8');
const text = (html) => htmlToText(html || '').trim();

const RITA = 'rita.requester@customer.example';
const ORIGINAL_BODY = /Invoice 4471 from July is still showing as unpaid/;

describe('subject prefixes', () => {
  test('classifies forward vs reply prefixes in en/de/fr/es and strips chains', () => {
    expect(subjectPrefix('FW: Invoice')).toEqual({ kind: 'forward', prefix: 'FW' });
    expect(subjectPrefix('Fwd: Invoice')).toEqual({ kind: 'forward', prefix: 'FWD' });
    expect(subjectPrefix('WG: Rechnung')).toEqual({ kind: 'forward', prefix: 'WG' });
    expect(subjectPrefix('TR: Facture')).toEqual({ kind: 'forward', prefix: 'TR' });
    expect(subjectPrefix('RV: Factura')).toEqual({ kind: 'forward', prefix: 'RV' });
    expect(subjectPrefix('RE: Invoice')).toEqual({ kind: 'reply', prefix: 'RE' });
    expect(subjectPrefix('AW: Rechnung')).toEqual({ kind: 'reply', prefix: 'AW' });
    expect(subjectPrefix('[EXTERNAL] Re: hi')).toEqual({ kind: 'reply', prefix: 'RE' });
    expect(subjectPrefix('Invoice')).toEqual({ kind: null, prefix: null });
    expect(stripSubjectPrefixes('FW: RE: AW: Invoice 4471 [TP-1204]')).toBe('Invoice 4471 [TP-1204]');
    expect(stripSubjectPrefixes('Re:Re: x')).toBe('x');
    expect(stripSubjectPrefixes('Report: weekly')).toBe('Report: weekly');
  });
});

describe('address + date parsing', () => {
  test('parseAddress handles angle, mailto-bracket, bare and quoted forms', () => {
    expect(parseAddress('Rita Requester <Rita@Customer.example>')).toEqual({ name: 'Rita Requester', email: 'rita@customer.example' });
    expect(parseAddress('"Requester, Rita" <rita@x.example>')).toEqual({ name: 'Requester, Rita', email: 'rita@x.example' });
    expect(parseAddress('Rita Requester [mailto:rita@x.example]')).toEqual({ name: 'Rita Requester', email: 'rita@x.example' });
    expect(parseAddress('rita@x.example')).toEqual({ name: null, email: 'rita@x.example' });
    expect(parseAddress('rita@x.example (Rita)')).toEqual({ name: 'Rita', email: 'rita@x.example' });
    expect(parseAddress('Rita Requester')).toEqual({ name: 'Rita Requester', email: null });
    expect(parseAddress('Rita &lt;rita@x.example&gt;')).toEqual({ name: 'Rita', email: 'rita@x.example' });
    expect(parseAddress('')).toEqual({ name: null, email: null });
  });

  test('parseAddressList splits on ; and , outside brackets', () => {
    expect(parseAddressList('Boss <boss@x.example>; "Peer, Pat" <pat@x.example>, solo@x.example')).toEqual([
      { name: 'Boss', email: 'boss@x.example' },
      { name: 'Peer, Pat', email: 'pat@x.example' },
      { name: null, email: 'solo@x.example' },
    ]);
    expect(parseAddressList('')).toEqual([]);
  });

  test('parseHeaderDate reads Outlook, Gmail, Apple, German, French, Spanish and RFC 2822 forms', () => {
    const iso = (s) => parseHeaderDate(s)?.toISOString();
    expect(iso('Monday, September 1, 2026 9:41 AM')).toBe(new Date('September 1, 2026 9:41').toISOString());
    expect(iso('Mon, Sep 1, 2026 at 9:41 AM')).toBe(new Date('September 1, 2026 9:41').toISOString());
    expect(iso('September 1, 2026 at 9:41:12 AM PDT')).toBe('2026-09-01T16:41:12.000Z');
    expect(iso('Montag, 1. September 2026 09:41')).toBe(new Date('September 1, 2026 9:41').toISOString());
    expect(iso('lundi 1 septembre 2026 09:41')).toBe(new Date('September 1, 2026 9:41').toISOString());
    expect(iso('lunes, 1 de septiembre de 2026 9:41')).toBe(new Date('September 1, 2026 9:41').toISOString());
    expect(iso('Tue, 2 Sep 2026 07:15:03 -0700')).toBe('2026-09-02T14:15:03.000Z');
    expect(iso('01.09.2026 09:41')).toBe(new Date('2026-09-01T09:41:00').toISOString());
    expect(parseHeaderDate('yesterday-ish')).toBeNull();
    expect(parseHeaderDate('')).toBeNull();
  });
});

describe('htmlToText / textToHtml', () => {
  test('flattens blocks and <br>, decodes entities, drops style/head, collapses blank runs', () => {
    const t = htmlToText('<html><head><style>p{}</style></head><body><div>A &amp; B</div><p>C<br>\nD</p><div><br></div><div><br></div><div>&nbsp;E&#39;s</div></body></html>');
    expect(t).toBe('\nA & B\n\nC\nD\n\n\nE\'s\n'.replace(/\n{3,}/g, '\n\n'));
    expect(textToHtml('one\ntwo\n\n<three>')).toBe('<p>one<br>two</p><p>&lt;three&gt;</p>');
  });
});

describe('header-block detection (text pass)', () => {
  test('finds an Outlook block only when Sent/Date follows From within the window', () => {
    const block = findHeaderBlock('note\n\nFrom: Rita <rita@x.example>\nSent: Monday, September 1, 2026 9:41 AM\nTo: a@x.example\nSubject: hi\n\nbody');
    expect(block.from).toEqual({ name: 'Rita', email: 'rita@x.example' });
    expect(block.headers.subject).toBe('hi');
    expect(block.endLine).toBe(5);
    expect(findHeaderBlock('From: our desk\nline\nline\nline\nline\nline\nline\nline\nSent: today')).toBeNull();
    expect(findHeaderBlock('')).toBeNull();
  });

  test('ignores a block that only appears deep in the body (beyond the top ~40 lines)', () => {
    const deep = `${Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n')}\nFrom: Rita <rita@x.example>\nSent: Monday, September 1, 2026 9:41 AM\nbody`;
    expect(findHeaderBlock(deep)).toBeNull();
  });

  test('wrapped To: lists continue onto the next line', () => {
    const block = findHeaderBlock('From: Rita <rita@x.example>\nSent: Monday, September 1, 2026 9:41 AM\nTo: a@x.example;\nb@x.example; c@x.example\nSubject: hi\n\nbody');
    expect(block.headers.to).toBe('a@x.example; b@x.example; c@x.example');
  });
});

describe('fixtures — positive', () => {
  const cases = [
    ['outlook-owa.html', 'FW: Invoice 4471 still unpaid', 'outlook_owa', { cc: 2 }],
    ['outlook-desktop-classic.html', 'FW: Invoice 4471 still unpaid', 'outlook_classic', {}],
    ['outlook-mac-new.html', 'Fwd: Invoice 4471 still unpaid', 'outlook_owa', {}],
    ['outlook-ios.html', 'FW: Invoice 4471 still unpaid', 'outlook_mobile', {}],
    ['gmail.html', 'Fwd: Invoice 4471 still unpaid', 'gmail', { cc: 1, marker: 'gmail' }],
    ['apple-mail.html', 'Fwd: Invoice 4471 still unpaid', 'apple_mail', { marker: 'apple' }],
  ];

  test.each(cases)('%s → forward from Rita with the original sliced out', (file, subject, client, extra) => {
    const r = parseForwardedMail({ html: fixture(file), subject });
    expect(r.isForward).toBe(true);
    expect(r.hasHeaderBlock).toBe(true);
    expect(r.client).toBe(client);
    if (extra.marker) expect(r.marker).toBe(extra.marker);
    expect(r.original.email).toBe(RITA);
    expect(r.original.name).toBe('Rita Requester');
    expect(r.original.date).toBeInstanceOf(Date);
    expect(r.original.date.getUTCFullYear()).toBe(2026);
    expect(r.original.subject).toBe('Invoice 4471 still unpaid');
    expect(r.original.to).toEqual([{ name: 'Alex Agent', email: 'alex.agent@bgcengineering.ca' }]);
    if (extra.cc) expect(r.original.cc).toHaveLength(extra.cc);
    // The sliced original keeps the body and drops the header block + note.
    expect(text(r.originalHtml)).toMatch(ORIGINAL_BODY);
    expect(text(r.originalHtml)).not.toMatch(/From:|Sent:|Date:/);
    expect(text(r.originalHtml)).not.toMatch(/ticket/i);
    expect(r.originalText).toMatch(ORIGINAL_BODY);
    expect(r.originalText).not.toMatch(/^(From|Sent|Date|To|Subject):/m);
    // The note is the agent's own words only.
    expect(text(r.noteHtml)).not.toMatch(ORIGINAL_BODY);
    expect(r.noteText).not.toMatch(ORIGINAL_BODY);
    expect(r.noteText.length).toBeGreaterThan(5);
    expect(r.segments).toEqual([]);
  });

  test('outlook-desktop-de.html → German labels, WG: prefix, German date', () => {
    const r = parseForwardedMail({ html: fixture('outlook-desktop-de.html'), subject: 'WG: Rechnung 4471 noch offen' });
    expect(r.isForward).toBe(true);
    expect(r.client).toBe('outlook_classic');
    expect(r.subjectPrefix).toEqual({ kind: 'forward', prefix: 'WG' });
    expect(r.original.email).toBe('sabine.mueller@kunde.example');
    expect(r.original.name).toBe('Sabine Müller');
    expect(r.original.date.toISOString()).toBe(new Date('September 1, 2026 09:41').toISOString());
    expect(r.original.subject).toBe('Rechnung 4471 noch offen');
    expect(r.original.cc).toEqual([{ name: 'Buchhaltung', email: 'buchhaltung@kunde.example' }]);
    expect(text(r.originalHtml)).toMatch(/die Rechnung 4471 vom Juli/);
    expect(text(r.originalHtml)).not.toMatch(/Von:|Gesendet:/);
    expect(r.noteText).toMatch(/Bitte ein Ticket/);
  });

  test('gmail.txt → text-only forward: originalText sliced, no HTML slices', () => {
    const r = parseForwardedMail({ text: fixture('gmail.txt'), subject: 'Fwd: Invoice 4471 still unpaid' });
    expect(r.isForward).toBe(true);
    expect(r.client).toBe('gmail');
    expect(r.marker).toBe('gmail');
    expect(r.original.email).toBe(RITA);
    expect(r.original.cc).toEqual([{ name: 'Boss Person', email: 'boss@customer.example' }]);
    expect(r.originalHtml).toBeNull();
    expect(r.noteHtml).toBeNull();
    expect(r.originalText).toMatch(/^Hi Alex,/);
    expect(r.originalText).toMatch(/Thanks,\nRita$/);
    expect(r.noteText).toMatch(/^Forwarding so we track/);
    expect(r.noteText).toMatch(/Alex$/);
  });

  test('nested-outlook-chain.html → only the TOP block is parsed; the inner block stays in the original', () => {
    const r = parseForwardedMail({ html: fixture('nested-outlook-chain.html'), subject: 'FW: FW: Invoice 4471 still unpaid' });
    expect(r.isForward).toBe(true);
    expect(r.original.email).toBe('bob.middle@bgcengineering.ca');
    expect(r.original.subject).toBe('FW: Invoice 4471 still unpaid');
    expect(text(r.originalHtml)).toMatch(/Alex — is this yours\?/);
    expect(text(r.originalHtml)).toMatch(/From: Rita Requester/);
    expect(text(r.originalHtml)).toMatch(ORIGINAL_BODY);
    expect(r.noteText).toBe('Bob passed this on — can PA take it?');
    expect(r.segments).toEqual([]);
  });

  test('a forward whose subject was edited (no prefix) still counts on the header block alone', () => {
    const r = parseForwardedMail({ html: fixture('outlook-owa.html'), subject: 'Rita needs a hand with invoice 4471' });
    expect(r.isForward).toBe(true);
    expect(r.subjectPrefix.kind).toBeNull();
  });
});

describe('fixtures — negative', () => {
  test('signature-with-From-line.html → no header block, not a forward', () => {
    const r = parseForwardedMail({ html: fixture('signature-with-From-line.html'), subject: 'September close date?' });
    expect(r.isForward).toBe(false);
    expect(r.hasHeaderBlock).toBe(false);
    expect(r.original.email).toBeNull();
    expect(r.originalHtml).toBeNull();
    expect(r.noteText).toBeNull();
  });

  test('reply-not-forward.html → header block present but RE: subject makes it a quoted reply', () => {
    const r = parseForwardedMail({ html: fixture('reply-not-forward.html'), subject: 'RE: Invoice 4471 still unpaid [TP-1204]' });
    expect(r.isForward).toBe(false);
    expect(r.hasHeaderBlock).toBe(true);
    expect(r.subjectPrefix).toEqual({ kind: 'reply', prefix: 'RE' });
    // The quoted From is still exposed for the agent-Cc rule.
    expect(r.original.email).toBe('patickets@bgcengineering.ca');
    expect(r.noteText).toMatch(/^Thanks — attached is the remittance/);
    expect(text(r.originalHtml)).toMatch(/we are looking into invoice 4471/);
  });

  test('a FW: subject with a plain body is NOT a forward (prefix is corroborating only)', () => {
    const r = parseForwardedMail({ html: '<div>Can you look at this?</div>', subject: 'FW: something' });
    expect(r.isForward).toBe(false);
    expect(r.hasHeaderBlock).toBe(false);
  });

  test('empty inputs', () => {
    expect(parseForwardedMail({}).isForward).toBe(false);
    expect(parseForwardedMail({ html: '', text: '', subject: null }).hasHeaderBlock).toBe(false);
    expect(sliceHtml('')).toBeNull();
    expect(sliceHtml('<p>nothing</p>')).toBeNull();
  });
});
