/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { buildThreadPayload } from './api';

/**
 * QA 09-09 #6 — the composer names the addresses the agent took off the Cc row
 * so the server's "Also for" safety net does not put them back. This must
 * survive BOTH request shapes: the multipart branch appends a fixed field list,
 * so a reply that happens to carry an attachment would otherwise drop the
 * removals and mail the very people the agent excluded.
 */

describe('buildThreadPayload — ccRemoved', () => {
  test('JSON branch carries the removals', () => {
    const [payload] = buildThreadPayload({
      bodyText: 'hi',
      cc: ['keep@x.com'],
      ccRemoved: ['mblackstock@bgcengineering.ca'],
    });
    expect(payload.cc).toEqual(['keep@x.com']);
    expect(payload.ccRemoved).toEqual(['mblackstock@bgcengineering.ca']);
  });

  test('multipart branch carries the removals too (reply with an attachment)', () => {
    const file = new File(['x'], 'screenshot.png', { type: 'image/png' });
    const [form] = buildThreadPayload({
      bodyText: 'hi',
      cc: ['keep@x.com'],
      ccRemoved: ['mblackstock@bgcengineering.ca', 'second@x.com'],
      files: [file],
    });
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('cc')).toBe('keep@x.com');
    // Comma-joined: the server's email list schema splits on , and ;
    expect(form.get('ccRemoved')).toBe('mblackstock@bgcengineering.ca,second@x.com');
  });

  test('omitted when there is nothing to remove — no behaviour change for ordinary replies', () => {
    const [payload] = buildThreadPayload({ bodyText: 'hi', cc: ['a@x.com'] });
    expect(payload).not.toHaveProperty('ccRemoved');

    const [form] = buildThreadPayload({
      bodyText: 'hi',
      cc: ['a@x.com'],
      ccRemoved: [],
      files: [new File(['x'], 'a.png', { type: 'image/png' })],
    });
    expect(form.get('ccRemoved')).toBeNull();
  });

  test('ccRemoved never leaks into the body fields', () => {
    const [payload] = buildThreadPayload({ bodyText: 'hi', ccRemoved: ['a@x.com'] });
    expect(payload.bodyText).toBe('hi');
    expect(payload.ccRemoved).toEqual(['a@x.com']);
  });
});
