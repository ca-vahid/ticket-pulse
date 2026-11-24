import {
  cleanNamePart, contentDisposition, extensionFor, extractFromRules, formatAttachmentName, holdsToken, isNameableDocument,
  normaliseEditedName, pacificDate, uniqueName, vendorFromEditedName, withNameFields, MAX_NAME_CHARS, MAX_STEM_CHARS,
} from '../src/services/attachmentNamingRules.js';

/**
 * 4.4.08 attachment display names: the rules' first pass and the name format.
 * Invented vendors and domains only (the repository is public).
 */
const internalDomains = ['ourco.example'];
const rules = (over) => extractFromRules({ internalDomains, aliases: {}, ...over });

describe('rules: vendor and invoice number from subject, sender and file name', () => {
  test('"New Invoice from Acme Supplies" from a payment platform names the vendor, not the platform', () => {
    const out = rules({ subject: 'New Invoice from Acme Supplies', fromEmail: 'noreply@getbalance.com', fromName: 'Balance', fileName: 'INV-100234.pdf' });
    expect(out.vendor).toEqual({ value: 'Acme Supplies', confidence: 'high', from: 'subject' });
    expect(out.invoice).toMatchObject({ value: 'INV-100234', confidence: 'high' });
    expect(out.domainKind).toBe('platform');
    expect(out.rulesSufficient).toBe(true);
  });

  test('"Invoice 28401 from Northwind Traders" gives both, with high confidence', () => {
    const out = rules({ subject: 'Invoice 28401 from Northwind Traders', fromEmail: 'quickbooks@notification.intuit.com', fileName: 'document.pdf' });
    expect(out.vendor).toMatchObject({ value: 'Northwind Traders', confidence: 'high' });
    expect(out.invoice).toMatchObject({ value: '28401', confidence: 'high' });
    expect(out.rulesSufficient).toBe(true);
  });

  test('a QuickBooks-style file name holds both', () => {
    const out = rules({ subject: 'Your invoice', fromEmail: 'quickbooks@notification.intuit.com', fileName: 'Invoice_28401_from_Northwind_Traders.pdf' });
    expect(out.vendor).toMatchObject({ value: 'Northwind Traders', confidence: 'high', from: 'file' });
    expect(out.invoice).toMatchObject({ value: '28401' });
  });

  test('a bare INV-1234.pdf gives the number but no vendor, so the rules are not enough', () => {
    const out = rules({ subject: 'Invoice attached', fromEmail: 'ar@vendor.example', fileName: 'INV-1234.pdf' });
    expect(out.vendor).toBeNull();
    expect(out.invoice).toMatchObject({ value: 'INV-1234', confidence: 'high' });
    expect(out.rulesSufficient).toBe(false);
  });

  test('a payment-platform sender display name "X via Balance" names X', () => {
    const out = rules({ subject: 'Payment request', fromEmail: 'noreply@getbalance.com', fromName: 'Acme Supplies via Balance', fileName: 'doc.pdf' });
    expect(out.vendor).toMatchObject({ value: 'Acme Supplies', from: 'sender' });
  });

  test('a platform\'s own name is never the vendor', () => {
    const out = rules({ subject: 'Invoice from QuickBooks', fromEmail: 'quickbooks@notification.intuit.com', fromName: 'QuickBooks', fileName: 'doc.pdf' });
    expect(out.vendor).toBeNull();
  });

  test('misfires are refused: a date after "from", a month as the vendor, our own company', () => {
    expect(rules({ subject: 'Payment Advice Note from 11/16/2026', fromEmail: 'ap@vendor.example', fileName: 'remit.pdf' }).vendor).toBeNull();
    expect(rules({ subject: 'September Invoice', fromEmail: 'dana@vendor.example', fromName: 'Dana Fox', fileName: 'a.pdf' }).vendor).toBeNull();
    expect(rules({ subject: 'Invoice', fromEmail: 'x@vendor.example', fileName: 'OurCo_Invoice_5521.pdf' }).vendor).toBeNull();
  });

  test('a person\'s name as the sender is not a vendor; a company name is', () => {
    expect(rules({ subject: 'hello', fromEmail: 'dana@vendor.example', fromName: 'Dana Fox', fileName: 'a.pdf' }).vendor).toBeNull();
    expect(rules({ subject: 'hello', fromEmail: 'billing@vendor.example', fromName: 'Acme Supplies Billing', fileName: 'a.pdf' }).vendor)
      .toMatchObject({ value: 'Acme Supplies', confidence: 'medium' });
  });

  test('a colleague\'s forward reads the quoted original sender', () => {
    const out = rules({
      subject: 'FW: Northwind Rentals Invoice 3431033',
      fromEmail: 'eli.park@ourco.example',
      fileName: 'RentalInvoice 3431033 - 2.pdf',
      bodyText: 'Please pay.\n\nFrom: Northwind Rentals <billing@northwind.example>\nSent: Monday',
    });
    expect(out.senderDomain).toBe('northwind.example');
    expect(out.forwarded).toBe(true);
    expect(out.vendor).toMatchObject({ value: 'Northwind Rentals', confidence: 'medium' });
    expect(out.invoice).toMatchObject({ value: '3431033', confidence: 'high' });
  });

  test('the learned vendor list wins, for the domain and its subdomains, but never for a platform', () => {
    const aliases = { 'acme.example': 'Acme Supplies', 'getbalance.com': 'Wrong' };
    expect(rules({ subject: 'x', fromEmail: 'a@mail.acme.example', fileName: 'x.pdf', aliases }).vendor)
      .toEqual({ value: 'Acme Supplies', confidence: 'high', from: 'vendor_list' });
    expect(rules({ subject: 'x', fromEmail: 'a@getbalance.com', fileName: 'x.pdf', aliases }).vendor).toBeNull();
  });
});

describe('name format', () => {
  test('Vendor_Invoice_YYYY_MM_DD.ext, spaces and capitals kept', () => {
    expect(formatAttachmentName({ vendor: 'Acme Glass', invoiceNumber: 'INV-100234', date: '2026-11-23', ext: 'pdf' }))
      .toBe('Acme Glass_INV-100234_2026_11_23.pdf');
  });

  test('no invoice number → Vendor_YYYY_MM_DD.ext', () => {
    expect(formatAttachmentName({ vendor: 'Acme Supplies', invoiceNumber: null, date: '2026-11-23', ext: 'PDF' }))
      .toBe('Acme Supplies_2026_11_23.pdf');
  });

  test('no vendor → no name', () => {
    expect(formatAttachmentName({ vendor: '  ', invoiceNumber: 'INV-1', date: '2026-11-23', ext: 'pdf' })).toBeNull();
  });

  test('illegal characters are stripped and whitespace collapsed', () => {
    expect(formatAttachmentName({ vendor: 'Acme:  "Supplies"* <Ltd>|', invoiceNumber: 'A/B\\12?', date: '2026-01-05', ext: 'pdf' }))
      .toBe('Acme Supplies Ltd_A B 12_2026_01_05.pdf');
  });

  test('capped at 120 characters before the extension, keeping the number and date', () => {
    const name = formatAttachmentName({ vendor: 'Acme '.repeat(60), invoiceNumber: 'INV-77', date: '2026-11-23', ext: 'pdf' });
    expect(name.length).toBe(MAX_STEM_CHARS + 4);
    expect(name.endsWith('_INV-77_2026_11_23.pdf')).toBe(true);
  });

  test('two files on one ticket with the same name get " (2)", then " (3)"', () => {
    expect(uniqueName('Acme_2026_11_23.pdf', ['acme_2026_11_23.PDF'])).toBe('Acme_2026_11_23 (2).pdf');
    expect(uniqueName('Acme_2026_11_23.pdf', ['Acme_2026_11_23.pdf', 'Acme_2026_11_23 (2).pdf'])).toBe('Acme_2026_11_23 (3).pdf');
    expect(uniqueName('Acme_2026_11_23.pdf', ['Other.pdf'])).toBe('Acme_2026_11_23.pdf');
  });

  test('the date is the Pacific day', () => {
    // 05:00 UTC on 24 Nov is 9 PM on 23 Nov in Vancouver.
    expect(pacificDate(new Date('2026-11-24T05:00:00Z'))).toBe('2026-11-23');
  });

  test('a typed name keeps the original extension', () => {
    expect(normaliseEditedName('Acme_12.PDF', 'INV-12.pdf')).toBe('Acme_12.pdf');
    expect(normaliseEditedName('Acme v2.1', 'INV-12.pdf')).toBe('Acme v2.1.pdf');
    expect(normaliseEditedName('   ', 'INV-12.pdf')).toBeNull();
    expect(normaliseEditedName(42, 'INV-12.pdf')).toBeNull();
    expect(normaliseEditedName(['Acme'], 'INV-12.pdf')).toBeNull();
  });

  test('an extension is 1–8 letters or digits; otherwise it comes from the content type', () => {
    expect(extensionFor('INV-12.pdf', 'application/pdf')).toBe('pdf');
    expect(extensionFor('Statement on Demand.XLSX', null)).toBe('xlsx');
    expect(extensionFor('Remittance for Acme Supplies Inc.', 'application/pdf')).toBe('pdf');
    expect(extensionFor('scan.final version', 'application/pdf')).toBe('pdf');
    expect(extensionFor('noext', 'application/x-unknown')).toBe('');
    expect(normaliseEditedName('Acme_12', 'Remittance for Acme Supplies Inc.', 'application/pdf')).toBe('Acme_12.pdf');
    expect(formatAttachmentName({ vendor: 'Acme', date: '2026-11-23', ext: 'not an ext!' })).toBe('Acme_2026_11_23');
  });

  test('the whole name stays within 200 characters, " (n)" included', () => {
    const long = `${'Acme Supplies '.repeat(30)}.pdf`;
    const n = normaliseEditedName(long, 'a.pdf');
    expect(Array.from(n).length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    const taken = [n];
    const twin = uniqueName(n, taken);
    expect(Array.from(twin).length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    const wide = uniqueName(`${'x'.repeat(196)}.pdf`, [`${'x'.repeat(196)}.pdf`]);
    expect(wide.length).toBe(MAX_NAME_CHARS);
    expect(wide.endsWith(' (2).pdf')).toBe(true);
  });

  test('Windows-reserved base names get a trailing "_"', () => {
    expect(normaliseEditedName('CON', 'a.pdf')).toBe('CON_.pdf');
    expect(normaliseEditedName('lpt1', 'a.pdf')).toBe('lpt1_.pdf');
    expect(normaliseEditedName('nul.backup', 'a.pdf')).toBe('nul.backup_.pdf');
    expect(normaliseEditedName('Console', 'a.pdf')).toBe('Console.pdf');
    expect(formatAttachmentName({ vendor: 'AUX', date: null, ext: 'pdf' })).toBe('AUX_.pdf');
  });

  test('direction marks and control characters are stripped', () => {
    expect(cleanNamePart('Acme‮FDP.exe')).toBe('AcmeFDP.exe');
    expect(cleanNamePart('Acme⁦Supplies⁩‎‏')).toBe('AcmeSupplies');
    expect(cleanNamePart('Acme\u0001\u001fSupplies\u0085')).toBe('Acme Supplies');
  });

  test('truncation never splits a surrogate pair', () => {
    const vendor = '\u{1F4C4}'.repeat(200); // 200 code points, 400 UTF-16 units
    const name = formatAttachmentName({ vendor, invoiceNumber: null, date: '2026-11-23', ext: 'pdf' });
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(Array.from(name).length).toBe(MAX_STEM_CHARS + 4);
    const edited = normaliseEditedName('\u{1F4C4}'.repeat(150), 'a.pdf');
    expect(edited).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('learning from a person\'s edit', () => {
  test('only the Vendor_<something with a digit> shape teaches', () => {
    expect(vendorFromEditedName('Acme Supplies_INV-12_2026_11_23.pdf')).toBe('Acme Supplies');
    expect(vendorFromEditedName('Northwind Traders_28401.pdf')).toBe('Northwind Traders');
    expect(vendorFromEditedName('just a name.pdf')).toBeNull();
    expect(vendorFromEditedName('Copy_of_invoice.pdf')).toBeNull();
    expect(vendorFromEditedName('Acme Supplies_terms.pdf')).toBeNull();
  });

  test('generic words, our own company and platforms never teach', () => {
    expect(vendorFromEditedName('Signed_W9.pdf')).toBeNull();
    expect(vendorFromEditedName('Scanned_2026_11_23.pdf')).toBeNull();
    expect(vendorFromEditedName('Invoice_12345.pdf')).toBeNull();
    expect(vendorFromEditedName('Document_1.pdf')).toBeNull();
    expect(vendorFromEditedName('Final_2.pdf')).toBeNull();
    expect(vendorFromEditedName('OurCo_12.pdf', internalDomains)).toBeNull();
    expect(vendorFromEditedName('QuickBooks_12.pdf')).toBeNull();
  });
});

describe('a subject\'s invoice number on a mail with several documents', () => {
  const mail = { subject: 'Invoice 28401 from Northwind Traders', fromEmail: 'ar@northwind.example' };

  test('only the file whose own name holds the number gets it; the others ask Claude', () => {
    const inv = rules({ ...mail, fileName: 'Invoice_28401.pdf', documentCount: 3 });
    expect(inv.invoice).toMatchObject({ value: '28401', confidence: 'high', from: 'subject+file' });
    expect(inv.rulesSufficient).toBe(true);

    const terms = rules({ ...mail, fileName: 'Terms and conditions.pdf', documentCount: 3 });
    expect(terms.vendor).toMatchObject({ value: 'Northwind Traders' });
    expect(terms.invoice).toBeNull();
    expect(terms.subjectInvoiceHint).toBe('28401');
    expect(terms.rulesSufficient).toBe(false);
  });

  test('the file\'s own name must hold the number as a whole token', () => {
    expect(holdsToken('Statement INV-77012', 'INV-7701')).toBe(false);
    expect(holdsToken('INV-7701', 'INV-7701')).toBe(true);
    expect(holdsToken('Acme_inv-7701_final', 'INV-7701')).toBe(true); // "_" separates, as in Vendor_INV-7701
    expect(holdsToken('Acme inv-7701 final', 'INV-7701')).toBe(true);
    expect(holdsToken('A7701', '7701')).toBe(false);
    expect(holdsToken('Invoice (1.5)', '1.5')).toBe(true); // regex characters are escaped
    expect(holdsToken('Invoice 125', '1.5')).toBe(false);

    const mail = { subject: 'Invoice INV-7701 from Northwind Traders', fromEmail: 'ar@northwind.example', documentCount: 2 };
    expect(rules({ ...mail, fileName: 'Statement INV-77012.pdf' }).invoice?.value).not.toBe('INV-7701');
    expect(rules({ ...mail, fileName: 'Statement INV-77012.pdf' }).subjectInvoiceHint).toBe('INV-7701');
    expect(rules({ ...mail, fileName: 'INV-7701.pdf' }).invoice).toMatchObject({ value: 'INV-7701', confidence: 'high', from: 'subject+file' });
  });

  test('a bare year in the subject is never an invoice number', () => {
    const out = rules({ subject: 'Acme Supplies statement #2026', fromEmail: 'ar@acme.example', fileName: 'Statement 2026-11.pdf', documentCount: 2 });
    expect(out.invoice).toBeNull();
    expect(out.subjectInvoiceHint).toBeNull();
    expect(rules({ subject: 'Invoice 2026 from Northwind Traders', fromEmail: 'ar@northwind.example', fileName: 'a.pdf' }).invoice).toBeNull();
    expect(rules({ subject: 'Invoice 20261 from Northwind Traders', fromEmail: 'ar@northwind.example', fileName: 'a.pdf' }).invoice).toMatchObject({ value: '20261' });
  });

  test('the mail\'s only document takes the subject\'s number', () => {
    const only = rules({ ...mail, fileName: 'document.pdf', documentCount: 1 });
    expect(only.invoice).toMatchObject({ value: '28401', confidence: 'high', from: 'subject' });
    expect(only.rulesSufficient).toBe(true);
  });

  test('a vendor-list entry alone never makes the rules enough', () => {
    const out = rules({ subject: 'x', fromEmail: 'ar@acme.example', fileName: 'INV-77.pdf', aliases: { 'acme.example': { vendor: 'Acme Supplies', learnedAt: '2026-11-20T00:00:00Z', by: 'Dana Fox' } } });
    expect(out.vendor).toMatchObject({ value: 'Acme Supplies', from: 'vendor_list' });
    expect(out.invoice).toMatchObject({ value: 'INV-77', confidence: 'high' });
    expect(out.rulesSufficient).toBe(false);
  });
});

describe('which files are named', () => {
  test('documents yes; pictures, inline parts and mail artefacts no', () => {
    expect(isNameableDocument({ fileName: 'INV-1.pdf', contentType: 'application/pdf' })).toBe(true);
    expect(isNameableDocument({ fileName: 'Statement.xlsx', contentType: 'application/vnd.ms-excel' })).toBe(true);
    expect(isNameableDocument({ fileName: 'logo.png', contentType: 'image/png' })).toBe(false);
    expect(isNameableDocument({ fileName: 'picture-1-ABC123-image.png', contentType: 'application/octet-stream' })).toBe(false);
    expect(isNameableDocument({ fileName: 'scan.pdf', contentType: 'application/pdf', isInline: true })).toBe(false);
    expect(isNameableDocument({ fileName: 'original-message.html', contentType: 'text/html' })).toBe(false);
    expect(isNameableDocument({ fileName: 'invite.ics', contentType: 'text/calendar' })).toBe(false);
  });
});

describe('payload and download header', () => {
  test('withNameFields adds the contract fields', () => {
    expect(withNameFields({ id: 1, fileName: 'INV-1.pdf' })).toEqual({
      id: 1, fileName: 'INV-1.pdf', displayName: null, originalName: 'INV-1.pdf', nameSource: null, nameDetails: null, namedAt: null, namedBy: null,
    });
  });

  test('Content-Disposition: plain ASCII name', () => {
    expect(contentDisposition('Acme Supplies_INV-1_2026_11_23.pdf'))
      .toBe('attachment; filename="Acme Supplies_INV-1_2026_11_23.pdf"; filename*=UTF-8\'\'Acme%20Supplies_INV-1_2026_11_23.pdf');
  });

  test('Content-Disposition: non-ASCII gets an ASCII fallback and RFC 5987 encoding', () => {
    expect(contentDisposition('Café Müller (2).pdf'))
      .toBe('attachment; filename="Cafe Muller (2).pdf"; filename*=UTF-8\'\'Caf%C3%A9%20M%C3%BCller%20%282%29.pdf');
    expect(contentDisposition('株式会社.pdf')).toMatch(/^attachment; filename="____\.pdf"; filename\*=UTF-8''%E6%A0%AA/);
  });

  test('Content-Disposition: quotes and line breaks cannot break the header', () => {
    const header = contentDisposition('a"b\r\nSet-Cookie: x.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="a_b Set-Cookie: x.pdf"')).toBe(true);
  });
});
