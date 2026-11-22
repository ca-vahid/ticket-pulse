/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

/**
 * 22 Nov 2026 — a quiet warning above the reply composer when the requester
 * does not read replies: a machine sender (the workspace's no-reply list) or
 * an unattended requester. A warning, never a block; asked once per ticket.
 */
const getMock = vi.fn();
vi.mock('../../services/api', () => ({ replyWarningAPI: { get: (...args) => getMock(...args) } }));

const { default: ReplyAudienceWarning } = await import('./ReplyAudienceWarning');
const { REPLY_WARNING_TEXT, resetReplyWarningCache } = await import('./replyWarning');

const answer = (kind) => ({ success: true, data: { kind, unattended: kind === 'unattended', machineSender: kind === 'machine_sender' ? 'noreply' : null } });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  resetReplyWarningCache();
  getMock.mockReset();
});
afterEach(() => cleanup());

describe('ReplyAudienceWarning', () => {
  test('a machine sender: the automated-sender line, asked once for the ticket', async () => {
    getMock.mockResolvedValue(answer('machine_sender'));
    render(<ReplyAudienceWarning ticketId={42} hasRequester show />);
    const line = await screen.findByTestId('reply-audience-warning');
    expect(line).toHaveTextContent('This address doesn’t read replies (it’s an automated sender). Add a private note instead.');
    expect(line).not.toHaveTextContent('Cc');
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith(42);
  });

  test('a machine sender on a ticket with someone in Cc: also suggests replying to them', async () => {
    getMock.mockResolvedValue(answer('machine_sender'));
    render(<ReplyAudienceWarning ticketId={42} hasRequester hasCc show />);
    expect(await screen.findByTestId('reply-audience-warning')).toHaveTextContent(
      'This address doesn’t read replies (it’s an automated sender). Add a private note instead, or reply to a person in Cc.',
    );
  });

  test('an unattended requester: the automated-system line, with no request at all', async () => {
    render(<ReplyAudienceWarning ticketId={42} unattended hasRequester show />);
    expect(screen.getByTestId('reply-audience-warning')).toHaveTextContent(
      'This requester is an automated system and doesn’t read replies. Add a private note instead.',
    );
    expect(screen.getByTestId('reply-audience-warning')).toHaveAttribute('data-kind', 'unattended');
    await flush();
    expect(getMock).not.toHaveBeenCalled();
  });

  test('a normal requester: no warning', async () => {
    getMock.mockResolvedValue(answer(null));
    render(<ReplyAudienceWarning ticketId={42} hasRequester show />);
    await flush();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('reply-audience-warning')).not.toBeInTheDocument();
  });

  test('it is a quiet line, not a pill or a block: an icon and plain amber text with a dark twin', async () => {
    getMock.mockResolvedValue(answer('machine_sender'));
    render(<ReplyAudienceWarning ticketId={42} hasRequester show />);
    const line = await screen.findByTestId('reply-audience-warning');
    expect(line.tagName).toBe('P');
    expect(line).toHaveAttribute('role', 'note');
    expect(line.className).toContain('text-amber-800');
    expect(line.className).toContain('dark:text-amber-200');
    expect(line.className).not.toMatch(/rounded-full|bg-/);
    expect(line.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  test('prefetched while the composer is on note, shown when it switches to reply, never asked twice', async () => {
    getMock.mockResolvedValue(answer('machine_sender'));
    const { rerender } = render(<ReplyAudienceWarning ticketId={42} hasRequester show={false} />);
    await flush();
    expect(screen.queryByTestId('reply-audience-warning')).not.toBeInTheDocument();
    rerender(<ReplyAudienceWarning ticketId={42} hasRequester show />);
    expect(screen.getByTestId('reply-audience-warning')).toBeInTheDocument();
    // Closing and opening the ticket again within the session uses the cache.
    cleanup();
    render(<ReplyAudienceWarning ticketId={42} hasRequester show />);
    expect(screen.getByTestId('reply-audience-warning')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  test('a failed check shows nothing and never throws', async () => {
    getMock.mockRejectedValue(new Error('network'));
    render(<ReplyAudienceWarning ticketId={42} hasRequester show />);
    await flush();
    expect(screen.queryByTestId('reply-audience-warning')).not.toBeInTheDocument();
  });

  test('no requester e-mail: nothing is asked', async () => {
    render(<ReplyAudienceWarning ticketId={42} hasRequester={false} show />);
    await flush();
    expect(getMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reply-audience-warning')).not.toBeInTheDocument();
  });

  test('another ticket never shows the previous ticket\'s answer', async () => {
    getMock.mockImplementation(async (id) => answer(id === 42 ? 'machine_sender' : null));
    const { rerender } = render(<ReplyAudienceWarning ticketId={42} hasRequester show />);
    expect(await screen.findByTestId('reply-audience-warning')).toBeInTheDocument();
    rerender(<ReplyAudienceWarning ticketId={43} hasRequester show />);
    expect(screen.queryByTestId('reply-audience-warning')).not.toBeInTheDocument();
    await flush();
    expect(screen.queryByTestId('reply-audience-warning')).not.toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith(43);
  });

  test('the sentences are the approved copy', () => {
    expect(REPLY_WARNING_TEXT.machine_sender).toBe('This address doesn’t read replies (it’s an automated sender). Add a private note instead.');
    expect(REPLY_WARNING_TEXT.machine_sender_cc).toBe('This address doesn’t read replies (it’s an automated sender). Add a private note instead, or reply to a person in Cc.');
    expect(REPLY_WARNING_TEXT.unattended).toBe('This requester is an automated system and doesn’t read replies. Add a private note instead.');
  });
});
