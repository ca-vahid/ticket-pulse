/** @vitest-environment jsdom */
import { describe, expect, test, vi } from 'vitest';
import api, { buildThreadPayload, ticketsAPI } from './api';

// Review 24 Nov 2026: files from internal notes go only with an explicit flag.
describe('ticketsAPI.forward — includePrivateAttachments', () => {
  test('sent only when set and only with ids, in JSON and multipart', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true });
    try {
      await ticketsAPI.forward(5, { to: ['a@example.com'], note: '', includeAttachmentIds: [12] });
      expect(post.mock.calls[0][1]).toEqual({ to: ['a@example.com'], note: '', includeAttachmentIds: [12] });
      await ticketsAPI.forward(5, { to: ['a@example.com'], note: '', includeAttachmentIds: [12, 31], includePrivateAttachments: true });
      expect(post.mock.calls[1][1]).toMatchObject({ includeAttachmentIds: [12, 31], includePrivateAttachments: true });
      await ticketsAPI.forward(5, {
        to: ['a@example.com'], note: '', includeAttachmentIds: [31], includePrivateAttachments: true,
        files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })],
      });
      expect(post.mock.calls[2][1].get('includePrivateAttachments')).toBe('true');
      await ticketsAPI.forward(5, { to: ['a@example.com'], note: '', includePrivateAttachments: true });
      expect(post.mock.calls[3][1]).toEqual({ to: ['a@example.com'], note: '' });
    } finally {
      post.mockRestore();
    }
  });
});

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

  // QA 11-24 #8: a reply to someone other than the requester keeps its
  // addressee whichever shape the request takes.
  test('a reply to someone else carries replyToEntryId / replyToEmail in both shapes', () => {
    const [json] = buildThreadPayload({ bodyText: 'hi', replyToEntryId: 88, replyToEmail: 'tim@example.com' });
    expect(json).toMatchObject({ replyToEntryId: 88, replyToEmail: 'tim@example.com' });
    const [form] = buildThreadPayload({
      bodyText: 'hi', replyToEntryId: 88, replyToEmail: 'tim@example.com',
      files: [new File(['x'], 'invoice.pdf', { type: 'application/pdf' })],
    });
    expect(form.get('replyToEntryId')).toBe('88');
    expect(form.get('replyToEmail')).toBe('tim@example.com');
    const [plain] = buildThreadPayload({ bodyText: 'hi', files: [new File(['x'], 'a.png', { type: 'image/png' })] });
    expect(plain.get('replyToEntryId')).toBeNull();
  });

  test('ccRemoved never leaks into the body fields', () => {
    const [payload] = buildThreadPayload({ bodyText: 'hi', ccRemoved: ['a@x.com'] });
    expect(payload.bodyText).toBe('hi');
    expect(payload.ccRemoved).toEqual(['a@x.com']);
  });
});
