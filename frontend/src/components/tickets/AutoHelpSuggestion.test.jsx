/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProposedReplyCard from './ProposedReplyCard';
import { csatWords, followUpPromise, friendlyError, nPct, runLifeLine } from '../knowledge/autoHelpWords';

// Auto-help P1 approve mode: the "Auto-help suggests" variant of the
// proposed-reply card — sources, the automated-answer line, the follow-up
// promise with dates, Send / Edit & send / Dismiss with a one-tap reason.

const proposedReplies = vi.fn();
const sendProposedReply = vi.fn().mockResolvedValue({});
const dismissProposedReply = vi.fn().mockResolvedValue({});
vi.mock('../../services/api', () => ({
  ticketsAPI: {
    proposedReplies: (...a) => proposedReplies(...a),
    sendProposedReply: (...a) => sendProposedReply(...a),
    dismissProposedReply: (...a) => dismissProposedReply(...a),
  },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const AUTO = {
  id: 77,
  status: 'proposed',
  source: 'auto_help',
  autoHelpRunId: 901,
  confidence: 'high',
  bodyHtml: '<p>preview</p>',
  autoHelp: {
    runId: 901,
    playbookName: 'Software installs',
    confidence: 0.91,
    sensitive: false,
    answerHtml: '<p>You can install it yourself:</p><ol><li>Open Company Portal.</li><li>Search for Bluebeam Revu and choose Install.</li></ol>',
    disclosure: 'This is an automated first answer from the IT team. Reply any time to reach a person.',
    footer: 'Did this sort it out? Just reply if you still need a hand — a person will pick it up.',
    sources: [{ sourceId: 'article:12', type: 'article', id: 12, title: 'Install apps from Company Portal', section: 'Steps', url: '/knowledge/articles/12' }],
    followUp: { onSilence: 'resolve', nudgeAt: '2026-10-14T17:00:00.000Z', closeAt: '2026-10-16T17:00:00.000Z' },
    dismissReasons: ['wrong_answer', 'not_needed', 'other'],
  },
};

const renderCard = (props = {}) => render(
  <MemoryRouter>
    <ProposedReplyCard ticketId={501} canWrite {...props} />
  </MemoryRouter>,
);

describe('Auto-help suggestion card', () => {
  test('shows title + playbook, confidence as words, the mail in the e-mail well, sources and the dated promise', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    renderCard();
    const card = await screen.findByTestId('auto-help-suggestion');
    expect(within(card).getByRole('heading', { name: 'Auto-help suggests' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Software installs');
    expect(card).toHaveTextContent('91 % confident');
    const well = within(card).getByTestId('email-well');
    expect(well).toHaveClass('tp-light');
    expect(within(well).getByTestId('auto-help-disclosure')).toHaveTextContent(/automated first answer from the IT team/);
    expect(well).toHaveTextContent('Search for Bluebeam Revu and choose Install.');
    expect(within(well).getByTestId('auto-help-footer')).toHaveTextContent('Did this sort it out?');
    const link = within(card).getByRole('link', { name: 'Install apps from Company Portal › Steps' });
    expect(link).toHaveAttribute('href', '/knowledge/articles/12');
    expect(within(card).getByTestId('auto-help-promise')).toHaveTextContent(/checks in on .*14.* closes the ticket on .*16/);
    // Not the plain workflow card.
    expect(screen.queryByTestId('proposed-reply-card')).toBeNull();
  });

  test('Send sends it as it is and tells the page when Auto-help checks in', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    const onSent = vi.fn();
    renderCard({ onSent });
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendProposedReply).toHaveBeenCalledWith(501, 77, {}));
    expect(onSent).toHaveBeenCalledWith(expect.stringMatching(/^Sent\. If there is no reply, Auto-help checks in on/));
    await waitFor(() => expect(screen.queryByTestId('auto-help-suggestion')).toBeNull());
  });

  test('Edit & send edits the answer only, keyboard first, and sends the edited HTML', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    renderCard({ onSent: () => {} });
    fireEvent.click(await screen.findByRole('button', { name: /Edit & send/ }));
    const editor = await screen.findByRole('textbox', { name: 'Edit the answer' });
    expect(editor).toHaveFocus();
    expect(editor.innerHTML).toContain('Open Company Portal.');
    // The line and footer stay outside the editor (the server always adds them).
    expect(within(editor).queryByText(/automated first answer/)).toBeNull();
    editor.innerHTML = '<p>Open Company Portal from the Start menu and choose Install.</p>';
    fireEvent.click(screen.getByRole('button', { name: 'Send edited answer' }));
    await waitFor(() => expect(sendProposedReply).toHaveBeenCalledWith(501, 77, { bodyHtml: '<p>Open Company Portal from the Start menu and choose Install.</p>' }));
  });

  test('Escape leaves editing without sending', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Edit & send/ }));
    const editor = await screen.findByRole('textbox', { name: 'Edit the answer' });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit the answer' })).toBeNull();
    expect(sendProposedReply).not.toHaveBeenCalled();
  });

  test('Dismiss asks why with one tap, then sends the reason', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const reasons = screen.getByTestId('dismiss-reasons');
    expect(dismissProposedReply).not.toHaveBeenCalled();
    fireEvent.click(within(reasons).getByRole('button', { name: 'Wrong answer' }));
    await waitFor(() => expect(dismissProposedReply).toHaveBeenCalledWith(501, 77, { reason: 'wrong_answer' }));
  });

  test('a failed send keeps the card and says why', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    sendProposedReply.mockRejectedValueOnce(new Error('This suggestion was already sent or dismissed'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already sent or dismissed');
    expect(screen.getByTestId('auto-help-suggestion')).toBeInTheDocument();
  });

  test('sensitive playbooks say a person always sends', async () => {
    proposedReplies.mockResolvedValue({ data: [{ ...AUTO, autoHelp: { ...AUTO.autoHelp, sensitive: true } }] });
    renderCard();
    expect(await screen.findByText(/Sensitive topic/)).toBeInTheDocument();
  });
});

describe('Auto-help suggestion — safety and wording', () => {
  test('edit mode sanitizes the drafted HTML: no <script>, no onerror, no inline handlers', async () => {
    const evil = '<p>Steps</p><script>window.__pwned = 1</script><img src="x" onerror="window.__pwned = 2"><a href="#" onclick="alert(1)">link</a>';
    proposedReplies.mockResolvedValue({ data: [{ ...AUTO, autoHelp: { ...AUTO.autoHelp, answerHtml: evil } }] });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Edit & send/ }));
    const editor = await screen.findByRole('textbox', { name: 'Edit the answer' });
    expect(editor.innerHTML).toContain('Steps');
    expect(editor.innerHTML).not.toMatch(/<script/i);
    expect(editor.innerHTML).not.toMatch(/onerror/i);
    expect(editor.innerHTML).not.toMatch(/onclick/i);
    expect(window.__pwned).toBeUndefined();
  });

  test('the edited HTML is sanitized again before it is sent', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    renderCard({ onSent: () => {} });
    fireEvent.click(await screen.findByRole('button', { name: /Edit & send/ }));
    const editor = await screen.findByRole('textbox', { name: 'Edit the answer' });
    editor.innerHTML = '<p>Fixed</p><img src="x" onerror="alert(1)">';
    fireEvent.click(screen.getByRole('button', { name: 'Send edited answer' }));
    await waitFor(() => expect(sendProposedReply).toHaveBeenCalled());
    const body = sendProposedReply.mock.calls[0][2].bodyHtml;
    expect(body).toContain('Fixed');
    expect(body).not.toMatch(/onerror/i);
  });

  test('raw transport errors become sentences an agent can act on', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    sendProposedReply.mockRejectedValueOnce(new Error('Network error. Please check your connection.'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn.t reach Ticket Pulse/);
    expect(alert).toHaveClass('text-destructive');
    expect(alert).not.toHaveClass('text-red-700');
  });

  test('friendlyError maps status codes and keeps server sentences', () => {
    const e = (message, status) => Object.assign(new Error(message), status ? { status } : {});
    expect(friendlyError(e('Request failed with status code 500', 500))).toMatch(/may already have been sent/);
    expect(friendlyError(e('nope', 403))).toMatch(/don.t have permission to send/);
    expect(friendlyError(e('nope', 403), 'dismiss')).toMatch(/permission to dismiss/);
    expect(friendlyError(e('gone', 404))).toMatch(/no longer on the ticket/);
    expect(friendlyError(e('timeout of 30000ms exceeded'))).toMatch(/Couldn.t reach Ticket Pulse/);
    expect(friendlyError(e('The ticket is resolved — reopen it before sending', 400))).toBe('The ticket is resolved — reopen it before sending');
    expect(friendlyError(e('Request failed with status code 418', 418))).toMatch(/Could not send the answer/);
  });

  test('tells the agent the answer is AI-drafted', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    renderCard();
    expect(await screen.findByTestId('auto-help-ai-drafted')).toHaveTextContent(/AI-drafted/);
    expect(screen.queryByTestId('auto-help-disclosure-off')).toBeNull();
  });

  test('says so when the workspace turned the automated-answer line off (not forced on)', async () => {
    proposedReplies.mockResolvedValue({ data: [{ ...AUTO, autoHelp: { ...AUTO.autoHelp, disclosure: null } }] });
    renderCard();
    expect(await screen.findByTestId('auto-help-disclosure-off')).toHaveTextContent('The automated-answer line is off for this workspace');
    expect(screen.queryByTestId('auto-help-disclosure')).toBeNull();
  });

  test('Escape with edits asks first: Keep editing keeps them, Discard throws them away', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Edit & send/ }));
    const editor = await screen.findByRole('textbox', { name: 'Edit the answer' });
    editor.innerHTML = '<p>My own words</p>';
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Escape' });
    const ask = screen.getByTestId('auto-help-discard-confirm');
    expect(ask).toHaveTextContent('Discard your edits');
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByTestId('auto-help-discard-confirm')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Edit the answer' }).innerHTML).toContain('My own words');

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit the answer' }), { key: 'Escape' });
    fireEvent.click(within(screen.getByTestId('auto-help-discard-confirm')).getByRole('button', { name: 'Discard edits' }));
    expect(screen.queryByRole('textbox', { name: 'Edit the answer' })).toBeNull();
    expect(sendProposedReply).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('confidence number and % never split across lines', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    renderCard();
    expect(await screen.findByText('91 % confident')).toHaveClass('whitespace-nowrap');
  });
});

describe('Auto-help words', () => {
  test('CSAT always carries its N, in plain words', () => {
    expect(csatWords({ n: 0 })).toBe('No survey answers yet (N = 0)');
    expect(csatWords({ n: 10, avg: 3.7, outOf: 4 })).toBe('Average 3.7 out of 4 across 10 survey answers (N = 10)');
    expect(csatWords({ n: 1, avg: 4, outOf: 4 })).toBe('Average 4 out of 4 across 1 survey answer (N = 1)');
    expect(csatWords({ n: 10, satisfied: 8, avg: 3.6, outOf: 4 })).toBe('8 of 10 survey answers satisfied · average 3.6 out of 4 (N = 10)');
  });
  test('a count and its % are glued with non-breaking spaces', () => {
    expect(nPct({ n: 4, pct: 40 })).toBe(`4${String.fromCharCode(160)}(40${String.fromCharCode(160)}%)`);
  });
  test('leave_open promise; no dates → no promise', () => {
    expect(followUpPromise({ onSilence: 'leave_open', nudgeAt: '2026-10-14T17:00:00Z', closeAt: '2026-10-16T17:00:00Z' })).toMatch(/hands it back to a person/);
    expect(followUpPromise({})).toBeNull();
  });
  test('run life line', () => {
    expect(runLifeLine({ decision: 'agent_edited_sent', outcome: 'resolved_silence' })).toBe('Edited, then sent · Closed after no reply');
    expect(runLifeLine({ decision: 'agent_dismissed', dismissReason: 'not_needed' })).toBe('Dismissed (not needed)');
    expect(runLifeLine({ status: 'staged' })).toBe('Waiting for an agent');
    expect(runLifeLine({ decision: 'agent_sent', nudgedAt: '2026-10-14' })).toBe('Sent unchanged · Checked in — waiting');
  });
});

describe('Auto-help suggestion — a send that could not be confirmed', () => {
  test('needs_check: the agent is told to check FreshService; the button confirms the resend explicitly', async () => {
    proposedReplies.mockResolvedValue({ data: [{ ...AUTO, status: 'needs_check' }] });
    renderCard();
    const card = await screen.findByTestId('auto-help-suggestion');
    expect(within(card).getByTestId('auto-help-needs-check')).toHaveTextContent("We couldn't confirm the answer went out — check the ticket in FreshService before sending again.");
    fireEvent.click(within(card).getByRole('button', { name: 'I checked — send again' }));
    await waitFor(() => expect(sendProposedReply).toHaveBeenCalledWith(501, 77, { confirmResend: true }));
  });

  test('a normal suggestion never sends confirmResend', async () => {
    proposedReplies.mockResolvedValue({ data: [AUTO] });
    renderCard();
    const card = await screen.findByTestId('auto-help-suggestion');
    expect(within(card).queryByTestId('auto-help-needs-check')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendProposedReply).toHaveBeenCalledWith(501, 77, {}));
  });
});
