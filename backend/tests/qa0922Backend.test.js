import { jest } from '@jest/globals';
import { bulletproofButtons } from '../src/utils/emailHtmlHardening.js';

/**
 * QA 09-22: #1 the composer's blank line arrived as five <br/>s; #3 a padded
 * anchor is not a button in classic Outlook; #10 the default-variant seeding
 * ran on every list call.
 */
const PA_BUTTON = `<p style="margin:15px 0;">
        <a href="https://ticketpulse.bgcsaas.com/tickets"
           target="_blank"
           style="background-color:#005A9C;
                  color:#ffffff;
                  padding:10px 16px;
                  text-decoration:none;
                  border-radius:4px;
                  display:inline-block;
                  font-family: Arial, Helvetica, sans-serif !important;
                  font-weight:bold;">
            Open Ticket Pulse
        </a>
    </p>`;

describe('bulletproofButtons (#3)', () => {
  test('a padded, coloured anchor becomes a table-cell button; the anchor keeps href/target and loses the padding', () => {
    const out = bulletproofButtons(PA_BUTTON);
    expect(out).toContain('<td bgcolor="#005A9C"');
    expect(out).toMatch(/<td[^>]*style="[^"]*padding:10px 16px[^"]*"/);
    expect(out).toMatch(/<td[^>]*style="[^"]*border-radius:4px[^"]*"/);
    expect(out).toMatch(/<a href="https:\/\/ticketpulse\.bgcsaas\.com\/tickets" target="_blank" style="[^"]*"/);
    const anchorStyle = /<a [^>]*style="([^"]*)"/.exec(out)[1];
    expect(anchorStyle).not.toMatch(/padding|background/);
    expect(anchorStyle).toContain('color:#ffffff');
    expect(anchorStyle).toContain('font-weight:bold');
    expect(out).toContain('>Open Ticket Pulse</a>');
  });

  test('plain links and already-bulletproof anchors are left alone; the transform is idempotent', () => {
    const plain = '<p>See <a href="https://x.example/a" style="color:#005A9C;">the ticket</a>.</p>';
    expect(bulletproofButtons(plain)).toBe(plain);
    const once = bulletproofButtons(PA_BUTTON);
    expect(bulletproofButtons(once)).toBe(once);
    expect(bulletproofButtons('')).toBe('');
    expect(bulletproofButtons(null)).toBe('');
  });
});

describe('textToReplyHtml (#1)', () => {
  test('one blank line stays one blank line; five newlines collapse to two', async () => {
    jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
    const { textToReplyHtml } = await import('../src/services/ticketService.js');
    expect(textToReplyHtml('Hi Susan,\n\n\n\n\nTesting spacing in reply.\n\n\n\n\nKind regards,'))
      .toBe('<p>Hi Susan,<br/><br/>Testing spacing in reply.<br/><br/>Kind regards,</p>');
    expect(textToReplyHtml('a\nb')).toBe('<p>a<br/>b</p>');
    expect(textToReplyHtml('a\r\n\r\nb')).toBe('<p>a<br/><br/>b</p>');
    expect(textToReplyHtml(null)).toBe('<p></p>');
  });
});
