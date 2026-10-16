/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 10-15 #7 — the requester status page (/ticket-status/:token): one number,
// one status with a four-step progress, who is helping, what happens next.

const apiMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../services/api', () => ({ publicTicketStatusAPI: apiMock }));

import PublicTicketStatus from './PublicTicketStatus';

const basePayload = (overrides = {}) => {
  const { ticket = {}, ...rest } = overrides;
  return {
    workspace: { name: 'IT', timezone: 'America/Los_Angeles' },
    ticket: {
      displayRef: 'TP-10018',
      origin: 'ticketpulse',
      freshserviceTicketId: '245001',
      subject: 'Laptop dock does not wake the screens',
      summary: 'Both screens stay black after lunch. Guide: https://example.com/dock-help',
      status: 'Open',
      statusTone: 'open',
      priority: 'Medium',
      category: { ticketPulseCategory: 'Hardware', ticketPulseSubcategory: 'Docking stations' },
      requester: null,
      assignedAgent: { name: 'Sam Okafor', photoUrl: null },
      createdAt: '2026-10-14T16:00:00.000Z',
      assignedAt: '2026-10-14T16:20:00.000Z',
      resolvedAt: null,
      closedAt: null,
      completedAt: null,
      ...ticket,
    },
    timeline: [
      { key: 'received', label: 'Received', at: '2026-10-14T16:00:00.000Z' },
      { key: 'assigned', label: 'Assigned', at: '2026-10-14T16:20:00.000Z' },
      { key: 'active', label: 'In progress', at: '2026-10-14T16:20:00.000Z' },
    ],
    eta: {
      state: 'on_track',
      estimatedSeconds: 86400,
      estimatedResolutionLabel: '1d',
      sampleSize: 42,
      lookbackDays: 180,
      percentile: 75,
      expectedAt: '2026-10-15T16:00:00.000Z',
    },
    stats: { todayCreated: 12, todayResolvedOrClosed: 9, weekCreated: 80, weekResolvedOrClosed: 70 },
    branding: { brandName: 'Example IT Help', accentColor: '#2563eb', logoDataUrl: null },
    link: {
      expiresAt: '2026-12-13T00:00:00.000Z',
      raiseUrgencyUrl: 'https://status.example.com/ticket-urgency/tok',
      immediateSupportUrl: 'https://status.example.com/ticket-escalation/tok',
    },
    publicActions: {
      urgencyRaised: false,
      immediateSupportRequested: false,
      raiseUrgencyAvailable: true,
      immediateSupportAvailable: false,
    },
    settings: { showRequesterName: false, showAssignedAgentAvatar: true, manualRefreshOnly: true },
    refreshedAt: '2026-10-15T17:00:00.000Z',
    ...rest,
  };
};

const renderPage = (payload) => {
  apiMock.get.mockResolvedValue({ data: payload });
  return render(
    <MemoryRouter initialEntries={['/ticket-status/tok']}>
      <Routes><Route path="/ticket-status/:token" element={<PublicTicketStatus />} /></Routes>
    </MemoryRouter>,
  );
};

const stepStates = () => within(screen.getByRole('list', { name: 'Progress' }))
  .getAllByRole('listitem')
  .map(item => item.getAttribute('data-state'));

describe('PublicTicketStatus', () => {
  beforeEach(() => apiMock.get.mockReset());
  afterEach(() => cleanup());

  test('a Ticket Pulse ticket shows its TP number exactly once and never the FreshService id', async () => {
    const { container } = renderPage(basePayload());
    expect(await screen.findByRole('heading', { level: 1, name: 'Laptop dock does not wake the screens' })).toBeInTheDocument();
    expect(screen.getByTestId('ticket-ref')).toHaveTextContent('TP-10018');
    const text = container.textContent;
    expect(text.match(/TP-10018/g)).toHaveLength(1);
    expect(text).not.toContain('245001');
  });

  test('a FreshService ticket shows #<fs id>', async () => {
    renderPage(basePayload({ ticket: { displayRef: '#244990', origin: 'freshservice', freshserviceTicketId: '244990' } }));
    expect(await screen.findByTestId('ticket-ref')).toHaveTextContent('#244990');
  });

  test('open and assigned: In progress, helper named, human ETA, jargon tucked away', async () => {
    const { container } = renderPage(basePayload());
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('In progress');
    expect(stepStates()).toEqual(['complete', 'complete', 'current', 'upcoming']);
    expect(screen.getByText('Sam Okafor')).toBeInTheDocument();
    expect(screen.getByText('Most requests like this are done within about a day.')).toBeInTheDocument();
    // Percentile/sample size only inside the disclosure; no stats tiles or confidence badge.
    expect(screen.getByText('How we estimate this').closest('details')).not.toHaveAttribute('open');
    expect(container.textContent).not.toMatch(/Confidence|P75|New today|Resolved 7 days/);
    expect(screen.getByRole('link', { name: /Mark as urgent/ })).toHaveAttribute('href', 'https://status.example.com/ticket-urgency/tok');
    expect(screen.queryByRole('link', { name: /after-hours help/ })).not.toBeInTheDocument();
  });

  test('open and not assigned yet', async () => {
    renderPage(basePayload({
      ticket: { assignedAgent: { name: null, photoUrl: null }, assignedAt: null },
      timeline: [{ key: 'received', label: 'Received' }, { key: 'active', label: 'In progress' }],
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Received');
    expect(stepStates()).toEqual(['complete', 'current', 'upcoming', 'upcoming']);
    expect(screen.getByText('Not assigned yet')).toBeInTheDocument();
    expect(screen.getByText('We will pick someone shortly.')).toBeInTheDocument();
  });

  test('waiting on the requester', async () => {
    renderPage(basePayload({
      ticket: { status: 'Pending Response', statusTone: 'waiting' },
      eta: { state: 'paused', paused: true, sampleSize: 0 },
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Waiting on you');
    expect(stepStates()).toEqual(['complete', 'complete', 'current', 'upcoming']);
    expect(screen.getByText('We need something from you before we can continue.')).toBeInTheDocument();
  });

  test('closed: all steps done, resolution time, no urgency button', async () => {
    renderPage(basePayload({
      ticket: { status: 'Closed', statusTone: 'resolved', closedAt: '2026-10-14T17:20:00.000Z' },
      timeline: [{ key: 'received' }, { key: 'assigned' }, { key: 'closed', label: 'Closed' }],
      eta: { state: 'resolved', isComplete: true, actualResolutionLabel: '1h 20m', sampleSize: 0 },
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Closed');
    expect(stepStates()).toEqual(['complete', 'complete', 'complete', 'complete']);
    expect(screen.getByText('Closed in 1h 20m.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Mark as urgent/ })).not.toBeInTheDocument();
    expect(screen.getByText('Still not right?')).toBeInTheDocument();
  });

  test('urgency already raised: one calm notice, no second urgency button', async () => {
    renderPage(basePayload({
      publicActions: {
        urgencyRaised: true,
        urgencyRaisedAt: '2026-10-14T18:30:00.000Z',
        immediateSupportRequested: false,
        raiseUrgencyAvailable: true,
        immediateSupportAvailable: true,
      },
    }));
    await screen.findByTestId('status-headline');
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/You marked this request as urgent/);
    expect(screen.queryByRole('link', { name: /Mark as urgent/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /after-hours help/ })).toHaveAttribute('href', 'https://status.example.com/ticket-escalation/tok');
  });

  test('assignee hidden by settings is never shown as unassigned', async () => {
    renderPage(basePayload({ ticket: { assignedAgent: null } }));
    expect(await screen.findByText('Our support team')).toBeInTheDocument();
    expect(screen.queryByText('Not assigned yet')).not.toBeInTheDocument();
  });

  test('request summary sits collapsed under "Your request" with links made clickable', async () => {
    renderPage(basePayload());
    const summary = await screen.findByText('Your request');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByRole('link', { hidden: true })).toHaveAttribute('href', 'https://example.com/dock-help');
  });
});
