/** @vitest-environment jsdom */
// 20 Nov 2026: an approval that was still open when its ticket was closed
// ended as "not needed any more" (decidedVia 'ticket_closed'). The approver's
// link must say so — never "You closed this approval", and no decision box.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { approvedFixture } from './publicApproval/fixtures';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), decide: vi.fn(), handoff: vi.fn(), clarify: vi.fn(), postMessage: vi.fn() }));
vi.mock('../services/api', () => ({ publicApprovalAPI: apiMock }));
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  const Editor = forwardRef(function Editor({ ariaLabel }, ref) { return <textarea ref={ref} aria-label={ariaLabel} />; });
  return { __esModule: true, default: Editor, isRichContent: () => false };
});

import PublicApprovalDecisionPage from './PublicApprovalDecision';

const renderPage = () => render(
  <MemoryRouter initialEntries={['/approval/tok-1']}>
    <Routes><Route path="/approval/:token" element={<PublicApprovalDecisionPage />} /></Routes>
  </MemoryRouter>,
);

const closedByTicket = {
  ...approvedFixture,
  approval: {
    ...approvedFixture.approval,
    status: 'closed',
    closeReason: 'not_needed',
    decidedVia: 'ticket_closed',
    decidedAt: '2026-11-20T18:00:00.000Z',
    decisionNote: 'Not needed any more: the ticket was closed without a decision.',
    decisionNoteHtml: null,
    conditionNote: null,
  },
  approvers: approvedFixture.approvers.map((a) => ({ ...a, status: 'closed' })),
};

describe('public approval page: closed because the ticket closed', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    localStorage.clear();
    window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });
  afterEach(() => cleanup());

  test('says it is no longer needed, nobody needs to act, and offers no decision', async () => {
    apiMock.get.mockReturnValue(Promise.resolve(closedByTicket));
    renderPage();
    expect(await screen.findByText('No longer needed: the ticket was closed')).toBeInTheDocument();
    expect(screen.getByTestId('approval-status-badge')).toHaveTextContent('No longer needed');
    expect(screen.getByTestId('approval-closed-by-ticket')).toHaveTextContent('The ticket was closed without a decision, so this request is not needed any more. Nothing is needed from you.');
    expect(screen.queryByText(/You closed this approval/)).toBeNull();
    expect(screen.queryByText(/the agent has been told/)).toBeNull();
    expect(screen.queryByTestId('approval-composer')).toBeNull();
  });

  test('deciding just after the ticket closed (409): the page reloads and shows no longer needed', async () => {
    const pending = { ...closedByTicket, approval: { ...approvedFixture.approval, status: 'pending', decidedAt: null, decidedVia: null, decisionNote: null, decisionNoteHtml: null, conditionNote: null }, approvers: approvedFixture.approvers.map((a) => ({ ...a, status: 'pending' })) };
    apiMock.get.mockReturnValueOnce(Promise.resolve(pending)).mockReturnValueOnce(Promise.resolve(closedByTicket));
    apiMock.decide.mockImplementation(() => Promise.reject(Object.assign(new Error('This approval was closed because the ticket closed. Nothing was recorded or sent.'), { status: 409, code: 'approval_closed_by_ticket' })));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: /Yes, approve/ }));
    expect(await screen.findByText('No longer needed: the ticket was closed')).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('approval-composer')).toBeNull();
  });

  test('a person closing it keeps the old words', async () => {
    apiMock.get.mockReturnValue(Promise.resolve({ ...closedByTicket, approval: { ...closedByTicket.approval, decidedVia: 'link', decisionNote: 'Ingrid does not need it.' } }));
    renderPage();
    expect(await screen.findByText(/You closed this approval on .*: no longer needed/)).toBeInTheDocument();
    expect(screen.getByTestId('approval-status-badge')).toHaveTextContent('Closed');
    expect(screen.queryByTestId('approval-closed-by-ticket')).toBeNull();
  });
});
