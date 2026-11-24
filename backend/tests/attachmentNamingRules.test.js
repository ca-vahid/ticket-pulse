import {
  contentDisposition, extractFromRules, formatAttachmentName, isNameableDocument, normaliseEditedName,
  pacificDate, uniqueName, vendorFromEditedName, withNameFields, MAX_STEM_CHARS,
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
    expect(formatAttachmentName({ vendor: 'Active Glass', invoiceNumber: 'INV-100234', date: '2026-11-23', ext: 'pdf' }))
      .toBe('Active Glass_INV-100234_2026_11_23.pdf');
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
    expect(vendorFromEditedName('Acme Supplies_INV-12_2026_11_23.pdf')).toBe('Acme Supplies');
    expect(vendorFromEditedName('just a name.pdf')).toBeNull();
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
