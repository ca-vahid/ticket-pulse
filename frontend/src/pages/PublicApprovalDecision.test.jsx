/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  approvedFixture,
  approvedInAppFixture,
  cancelledFixture,
  expiredError,
  infoRequestedFixture,
  invalidError,
  pendingFixture,
  rejectedFixture,
  supersededFixture,
} from './publicApproval/fixtures';

// Public approval page (/approval/:token) — the redesign (design-previews/
// approval-redesign/mock.html): token-driven surface with a page-local theme
// toggle, agent note well, collapsible description, Q&A thread, decision box
// with A/R shortcuts, and the rail. API shape = the contract in
// services/api.js → publicApprovalAPI.

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  decide: vi.fn(),
  clarify: vi.fn(),
}));
vi.mock('../services/api', () => ({ publicApprovalAPI: apiMock }));

// The editor is contenteditable (no innerText in jsdom) — stand in a textarea
// that emits the same { html, text } shape.
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  const Editor = forwardRef(function Editor({ value, onChange, placeholder, ariaLabel }, ref) {
    return (
      <textarea
        ref={ref}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange({ html: `<p>${e.target.value}</p>`, text: e.target.value })}
      />
    );
  });
  return { __esModule: true, default: Editor, isRichContent: () => false };
});

// services/api.js's response interceptor resolves with the JSON body and
// rewrites failures into Error { status, message } — mirror that here.
const ok = (data) => Promise.resolve(data);
const fail = ({ status, data }) => Promise.reject(Object.assign(new Error(data?.message || 'Request failed'), { status }));

const renderPage = (token = 'tok-1') => render(
  <MemoryRouter initialEntries={[`/approval/${token}`]}>
    <Routes>
      <Route path="/approval/:token" element={<PublicApprovalDecisionPage />} />
    </Routes>
  </MemoryRouter>,
);

import PublicApprovalDecisionPage from './PublicApprovalDecision';

const noteBox = () => screen.getByRole('textbox', { name: 'Decision note' });
const typeNote = (text) => fireEvent.change(noteBox(), { target: { value: text } });

describe('PublicApprovalDecision (approval redesign)', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.decide.mockReset();
    apiMock.clarify.mockReset();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
  });
  afterEach(() => cleanup());

  test('pending: header, agent note well (scrollable), rail facts + approvers, decision box', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    renderPage();

    // Header
    expect(await screen.findByRole('heading', { level: 1, name: 'Laptop Stability and Performance Concerns' })).toBeInTheDocument();
    expect(screen.getByText('Hardware purchase approval')).toBeInTheDocument();
    expect(screen.getByText('Awaiting your decision')).toBeInTheDocument();
    expect(screen.getByText(/#239934/)).toHaveTextContent('#239934 · created Aug 28 · due Sep 4');
    expect(screen.getByText(/sent to you by/)).toHaveTextContent(/Requested for Ingrid Berru Garcia · Geotechnical Engineer, Vancouver · sent to you by Marcus Blackstock on Sep 1/);
    const view = screen.getByRole('link', { name: /View ticket/ });
    expect(view).toHaveAttribute('href', 'https://ticketpulse.bgcsaas.com/tickets/239934');
    expect(view).toHaveAttribute('title', expect.stringMatching(/signed in/));
    expect(screen.getByRole('button', { name: /Copy ref/ })).toBeInTheDocument();
    expect(screen.getAllByText('IT workspace').length).toBeGreaterThan(0);

    // Agent note well: avatar initials, who asks, table inside an overflow-x-auto wrapper
    const note = screen.getByRole('region', { name: 'Request note' });
    expect(within(note).getByText('MB')).toBeInTheDocument();
    expect(within(note).getByText(/asks for your approval/)).toHaveTextContent('Marcus Blackstock (IT) asks for your approval');
    const well = screen.getByTestId('request-note-well');
    expect(well).toHaveClass('overflow-x-auto');
    expect(note).toHaveClass('tp-approval-note');
    expect(well.querySelector('table')).not.toBeNull();
    expect(within(well).getByText('MP2V5N1L')).toBeInTheDocument();

    // Description + rail
    expect(screen.getByRole('heading', { name: 'Ticket description' })).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Request details' });
    expect(within(rail).getByText('Ingrid Berru Garcia')).toBeInTheDocument();
    expect(within(rail).getByText('Geotechnical Engineer · Vancouver')).toBeInTheDocument();
    expect(within(rail).getByText('iberrugarcia@bgcengineering.ca')).toBeInTheDocument();
    expect(within(rail).getByText('Medium')).toBeInTheDocument();
    expect(within(rail).getByText('Service Request')).toBeInTheDocument();
    expect(within(rail).getByText('Devices & Hardware › Laptop procurement')).toBeInTheDocument();
    // "You" first, even though the server listed Dana Ruiz first
    const approverRows = within(rail).getAllByRole('listitem');
    expect(approverRows[0]).toHaveTextContent(/^You/);
    expect(approverRows[1]).toHaveTextContent('Dana Ruiz (Finance)');
    expect(within(rail).getByText('What happens next')).toBeInTheDocument();

    // Decision box
    expect(screen.getByRole('heading', { name: 'Your decision' })).toBeInTheDocument();
    expect(noteBox()).toHaveAttribute('placeholder', 'Optional note for approve · required reason for reject');
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Reject/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Ask a question/ })).toBeEnabled();
    expect(screen.getByText(/Sent to ingrid\.manager@bgcengineering\.ca · link expires Oct 1/)).toBeInTheDocument();
  });

  test('reject stays disabled until a reason is typed, then posts the reason', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    apiMock.decide.mockReturnValue(ok({ status: 'rejected', decidedAt: '2026-09-02T16:30:00.000Z', approverName: 'Dana Whitfield' }));
    renderPage();
    const reject = await screen.findByRole('button', { name: /^Reject/ });
    expect(reject).toBeDisabled();
    expect(screen.getByText('Add a reason to reject')).toBeInTheDocument();

    typeNote('Budget frozen until Q4.');
    expect(reject).toBeEnabled();
    expect(screen.queryByText('Add a reason to reject')).not.toBeInTheDocument();
    fireEvent.click(reject);

    await waitFor(() => expect(apiMock.decide).toHaveBeenCalledWith('tok-1', 'rejected', 'Budget frozen until Q4.', null));
    expect(await screen.findByText(/You rejected this on Sep 2/)).toBeInTheDocument();
    expect(screen.getByText('Budget frozen until Q4.')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });

  test('approve posts and swaps the box for the decided banner (focus lands on it)', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    apiMock.decide.mockReturnValue(ok({ status: 'approved', decidedAt: '2026-09-02T16:30:00.000Z', approverName: 'Dana Whitfield' }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(apiMock.decide).toHaveBeenCalledWith('tok-1', 'approved', null, null));
    const banner = await screen.findByText(/You approved this on Sep 2/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your decision' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(banner.closest('[tabindex="-1"]')));
    // The rail now shows the approver as approved
    const rail = screen.getByRole('complementary', { name: 'Request details' });
    expect(within(rail).getAllByRole('listitem')[0]).toHaveTextContent(/approved/);
  });

  test('a server error stays inline — the page never blanks', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    apiMock.decide.mockImplementation(() => fail({ status: 400, data: { message: 'Add a reason for rejecting' } }));
    renderPage();
    const reject = await screen.findByRole('button', { name: /^Reject/ });
    typeNote('x');
    fireEvent.click(reject);
    expect(await screen.findByRole('alert')).toHaveTextContent('Add a reason for rejecting');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeEnabled();
  });

  test('ask a question requires a note, sends clarify, and keeps the decision open', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    apiMock.decide.mockReturnValue(ok({ status: 'info_requested', decidedAt: null, approverName: 'Dana Whitfield' }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Ask a question/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Type your question/);
    expect(apiMock.decide).not.toHaveBeenCalled();

    typeNote('Is a refurbished unit an option?');
    fireEvent.click(screen.getByRole('button', { name: /Ask a question/ }));
    await waitFor(() => expect(apiMock.decide).toHaveBeenCalledWith('tok-1', 'clarify', 'Is a refurbished unit an option?', null));
    expect(await screen.findByText(/You asked a question on .* — you can still decide now/)).toBeInTheDocument();
    expect(screen.getByText('Question sent')).toBeInTheDocument();
    expect(screen.getByText(/You asked \(.*\): Is a refurbished unit an option\?/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for a reply from Marcus/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeEnabled();
  });

  test('info_requested: banner + Q&A thread with answered and unanswered entries', async () => {
    apiMock.get.mockReturnValue(ok(infoRequestedFixture));
    renderPage();
    expect(await screen.findByText(/You asked a question on Sep 2/)).toBeInTheDocument();
    expect(screen.getByText(/You asked \(Sep 1\): Is a refurbished unit an option\?/)).toBeInTheDocument();
    expect(screen.getByText(/Marcus replied \(Sep 2\): No refurbished stock/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for a reply from Marcus/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your decision' })).toBeInTheDocument();
  });

  test('keyboard: A approves, R needs a reason first, neither fires inside the editor', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    apiMock.decide.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByRole('button', { name: /^Approve/ });

    // R without a reason → helper error, no request
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Add a reason/);
    expect(apiMock.decide).not.toHaveBeenCalled();

    // Typing "a" in the editor must not approve
    fireEvent.keyDown(noteBox(), { key: 'a' });
    expect(apiMock.decide).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'a' });
    await waitFor(() => expect(apiMock.decide).toHaveBeenCalledWith('tok-1', 'approved', null, null));
    expect(screen.getByText('Approving…')).toBeInTheDocument();
  });

  test('keyboard: R with a reason rejects', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    apiMock.decide.mockReturnValue(ok({ status: 'rejected', decidedAt: '2026-09-02T16:30:00.000Z', approverName: 'Dana Whitfield' }));
    renderPage();
    await screen.findByRole('button', { name: /^Reject/ });
    typeNote('No budget.');
    fireEvent.keyDown(document.body, { key: 'R' });
    await waitFor(() => expect(apiMock.decide).toHaveBeenCalledWith('tok-1', 'rejected', 'No budget.', null));
  });

  test('approved by you (link) shows your note; approved in the app names the approver', async () => {
    apiMock.get.mockReturnValue(ok(approvedFixture));
    renderPage();
    expect(await screen.findByText(/You approved this on Sep 2/)).toBeInTheDocument();
    expect(screen.getByText('Approved — please order the 32 GB config.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your decision' })).not.toBeInTheDocument();
    cleanup();

    apiMock.get.mockReturnValue(ok(approvedInAppFixture));
    renderPage('tok-2');
    expect(await screen.findByText(/Approved by Priya Natarajan on Sep 2.* in the app/)).toBeInTheDocument();
  });

  test('rejected (already decided) renders the banner and reason', async () => {
    apiMock.get.mockReturnValue(ok(rejectedFixture));
    renderPage();
    expect(await screen.findByText(/You rejected this on Sep 2/)).toBeInTheDocument();
    expect(screen.getByText('Budget is frozen until Q4 — please re-submit in October.')).toBeInTheDocument();
  });

  test('cancelled shows the reason; superseded names who approved', async () => {
    apiMock.get.mockReturnValue(ok(cancelledFixture));
    renderPage();
    expect(await screen.findByText('This request was cancelled')).toBeInTheDocument();
    expect(screen.getByText('The requester found a spare unit in the Vancouver loaner pool.')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your decision' })).not.toBeInTheDocument();
    cleanup();

    apiMock.get.mockReturnValue(ok(supersededFixture));
    renderPage('tok-3');
    expect(await screen.findByText(/Superseded — approved by Priya Natarajan on Sep 2/)).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Request details' });
    expect(within(rail).getAllByRole('listitem')[0]).toHaveTextContent('superseded by Priya Natarajan');
  });

  test('a raw axios-shaped 400 (response.data.requestedByName) names the agent on the expired page', async () => {
    apiMock.get.mockReturnValue(Promise.reject({ response: expiredError }));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'This approval link has expired' })).toBeInTheDocument();
    expect(screen.getByText(/Ask/)).toHaveTextContent('Marcus Blackstock');
  });

  test('expired token → friendly page; invalid token → not-valid page; both keep the brand bar', async () => {
    apiMock.get.mockReturnValue(fail(expiredError));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'This approval link has expired' })).toBeInTheDocument();
    expect(screen.getByText(/Ask .*for a new link/)).toBeInTheDocument();
    expect(screen.getByText('Ticket Pulse')).toBeInTheDocument();
    cleanup();

    apiMock.get.mockReturnValue(fail(invalidError));
    renderPage('nope');
    expect(await screen.findByRole('heading', { name: "This approval link isn't valid" })).toBeInTheDocument();
    expect(screen.getByText('Ticket Pulse')).toBeInTheDocument();
  });

  test('a pending approval whose expiresAt has passed is treated as expired', async () => {
    apiMock.get.mockReturnValue(ok({ ...pendingFixture, approval: { ...pendingFixture.approval, expiresAt: '2020-01-01T00:00:00.000Z' } }));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'This approval link has expired' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });

  test('loading skeleton shows the brand bar first', () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByLabelText('Loading approval')).toBeInTheDocument();
    expect(screen.getByText('Ticket Pulse')).toBeInTheDocument();
  });

  test('theme toggle stamps .dark on <html>, persists tp_public_theme, never touches tp_theme', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Switch to dark theme' });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    fireEvent.click(toggle);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('tp_public_theme')).toBe('dark');
    expect(localStorage.getItem('tp_theme')).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('tp_public_theme')).toBe('light');
  });

  test('a stored tp_public_theme=dark wins over the OS preference on load', async () => {
    localStorage.setItem('tp_public_theme', 'dark');
    apiMock.get.mockReturnValue(ok(pendingFixture));
    renderPage();
    await screen.findByRole('heading', { level: 1 });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('copy ref writes the display ref and shows Copied', async () => {
    apiMock.get.mockReturnValue(ok(pendingFixture));
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Copy ref/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('#239934'));
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });

  test('View ticket prefers the public status URL when present', async () => {
    apiMock.get.mockReturnValue(ok({ ...pendingFixture, ticket: { ...pendingFixture.ticket, publicStatusUrl: 'https://ticketpulse.bgcsaas.com/ticket-status/abc' } }));
    renderPage();
    const view = await screen.findByRole('link', { name: /View ticket/ });
    expect(view).toHaveAttribute('href', 'https://ticketpulse.bgcsaas.com/ticket-status/abc');
    expect(view).toHaveAttribute('title', 'Open the ticket status page');
  });

  test('description falls back to plain text when there is no HTML', async () => {
    apiMock.get.mockReturnValue(ok({ ...pendingFixture, ticket: { ...pendingFixture.ticket, descriptionHtml: null } }));
    renderPage();
    expect(await screen.findByText(/Over the past six months, I've been experiencing ongoing issues/)).toBeInTheDocument();
  });

  test('unmount restores the app theme (tp_theme) on <html>', async () => {
    localStorage.setItem('tp_public_theme', 'dark');
    apiMock.get.mockReturnValue(ok(pendingFixture));
    const view = renderPage();
    await screen.findByRole('heading', { level: 1 });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await act(async () => { view.unmount(); });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
