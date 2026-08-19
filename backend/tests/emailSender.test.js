import { formatSender, sanitizeFromName, MAX_FROM_NAME_LENGTH } from '../src/utils/emailSender.js';

describe('formatSender', () => {
  test('formats a simple name as a quoted RFC 5322 mailbox', () => {
    expect(formatSender({ name: 'Ticket Pulse', email: 'ticketpulse@bgcengineering.ca' }))
      .toBe('"Ticket Pulse" <ticketpulse@bgcengineering.ca>');
  });

  test('quotes names containing commas so the header does not split', () => {
    expect(formatSender({ name: 'Pulse, Ticket', email: 'tp@example.com' }))
      .toBe('"Pulse, Ticket" <tp@example.com>');
  });

  test('escapes double quotes and backslashes inside the display name', () => {
    expect(formatSender({ name: 'Ticket "TP" Pulse', email: 'tp@example.com' }))
      .toBe('"Ticket \\"TP\\" Pulse" <tp@example.com>');
    expect(formatSender({ name: 'Back\\slash', email: 'tp@example.com' }))
      .toBe('"Back\\\\slash" <tp@example.com>');
  });

  test('keeps unicode display names intact', () => {
    expect(formatSender({ name: 'Ticket Pulse Comptabilité', email: 'tp@example.com' }))
      .toBe('"Ticket Pulse Comptabilité" <tp@example.com>');
  });

  test('returns the plain address when the name is blank or whitespace', () => {
    expect(formatSender({ name: '', email: 'tp@example.com' })).toBe('tp@example.com');
    expect(formatSender({ name: '   ', email: 'tp@example.com' })).toBe('tp@example.com');
    expect(formatSender({ name: null, email: 'tp@example.com' })).toBe('tp@example.com');
    expect(formatSender({ email: 'tp@example.com' })).toBe('tp@example.com');
  });

  test('returns null without an address', () => {
    expect(formatSender({ name: 'Ticket Pulse', email: '' })).toBeNull();
    expect(formatSender({})).toBeNull();
    expect(formatSender()).toBeNull();
  });

  test('strips header-injection characters from the name', () => {
    expect(formatSender({ name: 'Evil\r\nBcc: x@y.z', email: 'tp@example.com' }))
      .toBe('"Evil Bcc: x@y.z" <tp@example.com>');
    expect(formatSender({ name: '<script>Pulse</script>', email: 'tp@example.com' }))
      .toBe('"script Pulse /script" <tp@example.com>');
  });
});

describe('sanitizeFromName', () => {
  test('trims and collapses whitespace', () => {
    expect(sanitizeFromName('  Ticket   Pulse  IT ')).toBe('Ticket Pulse IT');
  });

  test('returns null for empty and non-string-ish input', () => {
    expect(sanitizeFromName('')).toBeNull();
    expect(sanitizeFromName('   ')).toBeNull();
    expect(sanitizeFromName(null)).toBeNull();
    expect(sanitizeFromName(undefined)).toBeNull();
  });

  test('removes angle brackets and newlines', () => {
    expect(sanitizeFromName('Ticket <Pulse>\nIT')).toBe('Ticket Pulse IT');
  });

  test('caps the length at the shared maximum', () => {
    const long = 'A'.repeat(200);
    expect(sanitizeFromName(long)).toHaveLength(MAX_FROM_NAME_LENGTH);
  });
});
