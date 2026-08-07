import { jest } from '@jest/globals';
import sanitizeHtml from 'sanitize-html';

// QA 08-06 #3 — the engine's body sanitizer stripped h2/div/table styling
// because its allowlist diverged from the (permissive) signature config.
// Both now share EMAIL_SANITIZE_OPTIONS; sanitizeEmailHtml applies it as-is.

const prismaMock = {
  $transaction: jest.fn((callback) => callback(prismaMock)),
  notificationEmailBlock: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn(), upsert: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { EMAIL_SANITIZE_OPTIONS } = await import('../src/services/notificationWorkflowSignatureService.js');

// Susan's QA template shape: styled heading + table layout + div wrapper.
const QA_TEMPLATE = [
  '<div class="wrapper" style="font-family:Arial,sans-serif;">',
  '<h2 style="color:#005A9C;">New Field Card Request</h2>',
  '<table width="100%" cellpadding="4" style="border-collapse:collapse;">',
  '<tr><td align="left" style="font-weight:bold;">Project</td><td>Coyote Landslide</td></tr>',
  '</table>',
  '<p style="margin-top:12px;">Thanks,<br>Project Accounting</p>',
  '</div>',
].join('');

describe('shared EMAIL_SANITIZE_OPTIONS (QA 08-06 #3)', () => {
  test('the QA template survives the body sanitizer with its styling intact', () => {
    const sanitized = sanitizeHtml(QA_TEMPLATE, EMAIL_SANITIZE_OPTIONS);
    // The exact QA regression: the h2 color style was being stripped.
    expect(sanitized).toContain('<h2 style="color:#005A9C');
    expect(sanitized).toContain('<div class="wrapper"');
    expect(sanitized).toContain('<table width="100%" cellpadding="4"');
    expect(sanitized).toContain('align="left"');
    expect(sanitized).toContain('style="font-weight:bold');
    expect(sanitized).toContain('<p style="margin-top:12px');
  });

  test('dangerous content is still removed (scripts, event handlers, js: URLs)', () => {
    const dirty = '<h2 style="color:#005A9C" onclick="alert(1)">Hi</h2>'
      + '<script>alert(1)</script>'
      + '<a href="javascript:alert(1)">x</a>'
      + '<img src="https://example.com/x.png" onerror="alert(1)">';
    const sanitized = sanitizeHtml(dirty, EMAIL_SANITIZE_OPTIONS);
    expect(sanitized).not.toContain('script');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('onerror');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).toContain('<h2 style="color:#005A9C">Hi</h2>');
    expect(sanitized).toContain('<img src="https://example.com/x.png"');
  });

  test('data: image sources remain allowed for embedded logos', () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo">';
    expect(sanitizeHtml(html, EMAIL_SANITIZE_OPTIONS)).toContain('src="data:image/png;base64');
  });
});
