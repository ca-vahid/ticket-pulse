import { describe, expect, test } from '@jest/globals';
import {
  normalizeSubject, normalizeBody, bodiesAgree, attachmentFingerprint, contentAgrees,
} from '../src/services/duplicateBurstService.js';

/**
 * QA 09-09 #1 — Kirsten: "#241154 dismissed as a duplicate (it wasn't a
 * duplicate) - same with four other instacart invoices".
 *
 * The guard matched on subject alone. "New Invoice from Instacart Business" is
 * a template: the invoice number lives in the body, so seventeen genuinely
 * different invoices collapsed onto each other in 30 days. The subject match
 * stays — a burst does share a subject — but when both tickets carry a real
 * body, the bodies now have to agree too.
 */

const instacartA = 'Invoice INV-4471 for Instacart Business. Total $412.90 due 2026-09-22. Order placed by the Vancouver office.';
const instacartB = 'Invoice INV-4488 for Instacart Business. Total $88.15 due 2026-09-24. Order placed by the Calgary office.';

// Both Tytan tickets' bodies are literally this — 8 characters of markup.
const EMPTY_BODY = '<br>\n\n\n\n';

describe('bodiesAgree — the reported bug', () => {
  test('two different Instacart invoices are NOT the same request', () => {
    // Same subject, so the old guard collapsed them.
    expect(normalizeSubject('New Invoice from Instacart Business'))
      .toBe(normalizeSubject('New Invoice from Instacart Business'));
    // Different bodies, so they are not a burst.
    expect(bodiesAgree(instacartA, instacartB)).toBe(false);
  });

  test('the same invoice sent twice IS still a duplicate', () => {
    expect(bodiesAgree(instacartA, instacartA)).toBe(true);
  });
});

describe('bodiesAgree — the original Teams-app storm must still be caught', () => {
  test('identical copies of one request still agree', () => {
    const body = 'My laptop will not connect to the Calgary VPN after the update this morning. Please help.';
    expect(bodiesAgree(body, body)).toBe(true);
  });

  test('copies differing only in markup, casing and whitespace still agree', () => {
    const a = 'My laptop will not connect to the Calgary VPN after the update this morning.';
    const b = '<p>My  LAPTOP will not connect to the Calgary VPN,  after the update this morning.</p>';
    expect(bodiesAgree(a, b)).toBe(true);
  });

  test('a body too short to mean anything falls back to subject-only matching', () => {
    // "see attached" carries no signal — refusing to match on it would let a
    // real burst of attachment-only tickets through.
    expect(bodiesAgree('see attached', 'see attached please')).toBe(true);
    expect(bodiesAgree('', instacartA)).toBe(true);
    expect(bodiesAgree(null, null)).toBe(true);
  });
});

describe('normalizeBody', () => {
  test('strips markup and punctuation, collapses whitespace, lowercases', () => {
    expect(normalizeBody('<div>Hello,   WORLD!</div>')).toBe('hello world');
  });

  test('an empty body normalizes to an empty string, not a crash', () => {
    expect(normalizeBody(null)).toBe('');
    expect(normalizeBody(undefined)).toBe('');
  });
});

/**
 * Kirsten also named #241127 (Tytan Safety Invoice). Bodies could not save
 * that one: both tickets' bodies are literally "<br>" — 8 characters. The
 * invoice IS the attachment, and the vendor's exporter names every file
 * SalesInvoice.Report.pdf. Only the byte size tells them apart.
 */
describe('contentAgrees — attachments decide when the body says nothing', () => {
  test('the real Tytan pair: same name, different size -> NOT duplicates', () => {
    const a = { body: EMPTY_BODY, attachments: [{ fileName: 'SalesInvoice.Report.pdf', sizeBytes: 204780 }] };
    const b = { body: EMPTY_BODY, attachments: [{ fileName: 'SalesInvoice.Report.pdf', sizeBytes: 201147 }] };
    expect(contentAgrees(a, b)).toBe(false);
  });

  test('the identical document sent twice IS still a duplicate', () => {
    const file = [{ fileName: 'SalesInvoice.Report.pdf', sizeBytes: 204780 }];
    expect(contentAgrees({ body: EMPTY_BODY, attachments: file }, { body: EMPTY_BODY, attachments: file })).toBe(true);
  });

  test('a different number of attachments is not the same request', () => {
    const a = { body: EMPTY_BODY, attachments: [{ fileName: 'a.pdf', sizeBytes: 10 }] };
    const b = { body: EMPTY_BODY, attachments: [{ fileName: 'a.pdf', sizeBytes: 10 }, { fileName: 'b.pdf', sizeBytes: 20 }] };
    expect(contentAgrees(a, b)).toBe(false);
  });

  test('attachment order does not matter', () => {
    const a = { body: EMPTY_BODY, attachments: [{ fileName: 'b.pdf', sizeBytes: 20 }, { fileName: 'a.pdf', sizeBytes: 10 }] };
    const b = { body: EMPTY_BODY, attachments: [{ fileName: 'a.pdf', sizeBytes: 10 }, { fileName: 'b.pdf', sizeBytes: 20 }] };
    expect(contentAgrees(a, b)).toBe(true);
  });

  test('no attachments on either side falls back to subject-only (the real burst)', () => {
    expect(contentAgrees({ body: EMPTY_BODY, attachments: [] }, { body: EMPTY_BODY, attachments: [] })).toBe(true);
  });

  test('a decisive body wins without consulting attachments', () => {
    // Different attachments, but the bodies already agree in full.
    const body = 'My laptop will not connect to the Calgary VPN after the update this morning. Please help.';
    const a = { body, attachments: [{ fileName: 'x.png', sizeBytes: 1 }] };
    const b = { body, attachments: [{ fileName: 'y.png', sizeBytes: 2 }] };
    expect(contentAgrees(a, b)).toBe(true);
  });

  test('a decisive body that DISAGREES is rejected regardless of attachments', () => {
    const file = [{ fileName: 'same.pdf', sizeBytes: 100 }];
    const a = { body: instacartA, attachments: file };
    const b = { body: instacartB, attachments: file };
    expect(contentAgrees(a, b)).toBe(false);
  });
});

describe('attachmentFingerprint', () => {
  test('name and size, sorted, so order never matters', () => {
    expect(attachmentFingerprint([{ fileName: 'B.pdf', sizeBytes: 2 }, { fileName: 'a.pdf', sizeBytes: 1 }]))
      .toBe('a.pdf:1|b.pdf:2');
  });

  test('empty input yields an empty fingerprint (no signal, not a match)', () => {
    expect(attachmentFingerprint([])).toBe('');
    expect(attachmentFingerprint(null)).toBe('');
  });
});
