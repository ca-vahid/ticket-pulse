import { describe, expect, test } from 'vitest';
import { fillGreetingPlaceholders, wrapWithGreeting } from './replyGreeting';

// Reply greeting + sign-off (QA 09-18 #4).
const cfg = { enabled: true, greeting: 'Hi {{requester.firstName}},', signoff: 'Thank you,\n{{agent.firstName}}' };
const ctx = { requester: { name: 'Jenny Kolada-Tran', email: 'jkoladatran@x.io' }, agent: { name: 'Andrii Grynik' }, ticket: { displayRef: 'TP-1560', subject: 'Rental' } };

describe('fillGreetingPlaceholders', () => {
  test('fills names, refs and subject; drops unknown tokens', () => {
    expect(fillGreetingPlaceholders('Hi {{requester.firstName}} ({{ticket.ref}}) {{x.y}}', ctx)).toBe('Hi Jenny (TP-1560) ');
  });
  test('falls back to the e-mail local part, then "there"', () => {
    expect(fillGreetingPlaceholders('Hi {{requester.firstName}},', { requester: { email: 'roger.hsu@x.io' } })).toBe('Hi Roger,');
    expect(fillGreetingPlaceholders('Hi {{requester.name}},', {})).toBe('Hi there,');
  });
});

describe('wrapWithGreeting', () => {
  test('an empty reply becomes greeting, a blank line to type in, and the sign-off', () => {
    expect(wrapWithGreeting('', cfg, ctx)).toBe('<p>Hi Jenny,</p><p><br></p><p><br></p><p><br></p><p>Thank you,<br>Andrii</p>');
  });
  test('an existing reply is wrapped, not replaced', () => {
    expect(wrapWithGreeting('<p>Done — the list is updated.</p>', cfg, ctx))
      .toBe('<p>Hi Jenny,</p><p><br></p><p>Done — the list is updated.</p><p><br></p><p>Thank you,<br>Andrii</p>');
  });
  test('a reply that already opens with the greeting is left alone', () => {
    const once = wrapWithGreeting('', cfg, ctx);
    expect(wrapWithGreeting(once, cfg, ctx)).toBe(once);
  });
  test('html in the wording is escaped', () => {
    expect(wrapWithGreeting('', { greeting: '<b>Hi</b> {{requester.firstName}}', signoff: '' }, ctx)).toBe('<p>&lt;b&gt;Hi&lt;/b&gt; Jenny</p><p><br></p><p><br></p>');
  });
});
