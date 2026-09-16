/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Approvals v3 — the requester's reply page (/approval-reply/:token).

const apiMock = vi.hoisted(() => ({ replyView: vi.fn(), replySend: vi.fn() }));
vi.mock('../services/api', () => ({ publicApprovalAPI: apiMock }));

vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  const Editor = forwardRef(function Editor({ value, onChange, placeholder, ariaLabel }, ref) {
    return <textarea ref={ref} aria-label={ariaLabel} placeholder={placeholder} value={value} onChange={(e) => onChange({ html: `<p>${e.target.value}</p>`, text: e.target.value })} />;
  });
  return { __esModule: true, default: Editor, isRichContent: () => false };
});

import PublicApprovalReply from './PublicApprovalReply';

const ok = (data) => Promise.resolve(data);
const fail = ({ status, data }) => Promise.reject(Object.assign(new Error(data?.message || 'Request failed'), { status }));

const view = {
  recipient: { email: 'reggie@bgc.ca', name: 'Reggie Chen', role: 'requester' },
  question: { id: 10, kind: 'question', audience: 'requester', author: { email: 'neville@bgc.ca', name: 'Neville Vyland', role: 'approver' }, bodyText: 'Which environments need the DNS records?', to: ['reggie@bgc.ca'], cc: ['mehdi@bgc.ca'], createdAt: '2026-09-16T18:00:00.000Z' },
  thread: [
    { id: 10, kind: 'question', audience: 'requester', author: { email: 'neville@bgc.ca', name: 'Neville Vyland', role: 'approver' }, bodyText: 'Which environments need the DNS records?', to: ['reggie@bgc.ca'], cc: ['mehdi@bgc.ca'], createdAt: '2026-09-16T18:00:00.000Z' },
  ],
  approval: { id: 5, status: 'info_requested', category: 'Cybersecurity & Risk', requestGroupId: 'g1', expired: false },
  ticket: { id: 21787, displayRef: '#242054', subject: 'DNS and Microsoft 365 support for Rhiza' },
  participants: { requester: { email: 'reggie@bgc.ca', name: 'Reggie Chen' }, agent: { email: 'mehdi@bgc.ca', name: 'Mehdi Abbaspour' }, approvers: [] },
};

const renderPage = () => render(
  <MemoryRouter initialEntries={['/approval-reply/tok-9']}>
    <Routes><Route path="/approval-reply/:token" element={<PublicApprovalReply />} /></Routes>
  </MemoryRouter>,
);

describe('PublicApprovalReply', () => {
  beforeEach(() => {
    apiMock.replyView.mockReset();
    apiMock.replySend.mockReset();
    localStorage.clear();
    window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });
  afterEach(() => cleanup());

  test('shows who asked what, the visible thread, and a mail-sized editor; sends the answer', async () => {
    apiMock.replyView.mockReturnValue(ok(view));
    apiMock.replySend.mockReturnValue(ok({ message: { id: 11, kind: 'answer', audience: 'requester', author: { email: 'reggie@bgc.ca', name: 'Reggie Chen', role: 'requester' }, bodyText: 'DEV and UAT only.', inReplyToId: 10, createdAt: '2026-09-16T18:10:00.000Z' } }));
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'DNS and Microsoft 365 support for Rhiza' })).toBeInTheDocument();
    expect(screen.getByText('Neville Vyland asked')).toBeInTheDocument();
    expect(screen.getByText('Which environments need the DNS records?')).toBeInTheDocument();
    expect(screen.getByText('Question for you')).toBeInTheDocument();

    // empty send → inline error
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Type your answer first.');
    expect(apiMock.replySend).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'DEV and UAT only.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(apiMock.replySend).toHaveBeenCalledWith('tok-9', { bodyText: 'DEV and UAT only.', bodyHtml: null }));
    expect(await screen.findByText('Your answer is on the request')).toBeInTheDocument();
    const thread = screen.getByTestId('approval-thread');
    expect(within(thread).getByText('DEV and UAT only.')).toBeInTheDocument();
    expect(within(thread).getByText(/You answered/)).toBeInTheDocument();
  });

  test('an invalid token renders the not-valid card and still offers e-mail reply', async () => {
    apiMock.replyView.mockImplementation(() => fail({ status: 404, data: { message: 'This reply link is not valid' } }));
    renderPage();
    expect(await screen.findByText("This reply link isn't valid")).toBeInTheDocument();
    expect(screen.getByText(/replying to the e-mail itself/)).toBeInTheDocument();
  });

  test('a send failure stays inline', async () => {
    apiMock.replyView.mockReturnValue(ok(view));
    apiMock.replySend.mockImplementation(() => fail({ status: 400, data: { message: 'This reply link has expired' } }));
    renderPage();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Your answer' }), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This reply link has expired');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
