/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 10-15 #7 — the requester status page (/ticket-status/:token): one number,
// one status with a four-step progress, who is helping, what happens next.

const apiMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../services/api', () => ({ publicTicketStatusAPI: apiMock }));

import PublicTicketStatus, { trimBounds } from './PublicTicketStatus';

const basePayload = (overrides = {}) => {
  const { ticket = {}, ...rest } = overrides;
  return {
    workspace: { name: 'IT', timezone: 'America/Vancouver' },
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
  // Braces matter: a function returned from beforeEach runs as a teardown, and
  // mockReset() returns the mock itself — which would call the API again.
  beforeEach(() => { apiMock.get.mockReset(); });
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
    expect(stepStates()).toEqual(['complete', 'current', 'upcoming']);
    // QA 10-21 #6: three bars, no Assigned step.
    expect(within(screen.getByRole('list', { name: 'Progress' })).queryByText('Assigned')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Where it stands' })).toBeInTheDocument();
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
    expect(stepStates()).toEqual(['current', 'upcoming', 'upcoming']);
    expect(screen.getByText('Not assigned yet')).toBeInTheDocument();
    expect(screen.getByText('We will pick someone shortly.')).toBeInTheDocument();
  });

  test('waiting on the requester', async () => {
    renderPage(basePayload({
      ticket: { status: 'Pending Response', statusTone: 'waiting' },
      eta: { state: 'paused', paused: true, sampleSize: 0 },
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Waiting on you');
    expect(stepStates()).toEqual(['complete', 'current', 'upcoming']);
    expect(screen.getByText('We need something from you before we can continue.')).toBeInTheDocument();
  });

  test('closed: all steps done, resolution time, no urgency button', async () => {
    renderPage(basePayload({
      ticket: { status: 'Closed', statusTone: 'resolved', closedAt: '2026-10-14T17:20:00.000Z' },
      timeline: [{ key: 'received' }, { key: 'assigned' }, { key: 'closed', label: 'Closed' }],
      eta: { state: 'resolved', isComplete: true, actualResolutionLabel: '1h 20m', actualResolutionSeconds: 4800, sampleSize: 0 },
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Closed');
    expect(stepStates()).toEqual(['complete', 'complete', 'complete']);
    // QA 10-21 #8: a heading that fits a closed ticket, the time in words.
    expect(screen.getByRole('heading', { name: 'Where it stands' })).toBeInTheDocument();
    expect(screen.queryByText('What happens next')).not.toBeInTheDocument();
    expect(screen.getByText('Closed in 1 hour 20 minutes.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing more is needed from you\./)).toBeInTheDocument();
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

  // QA 10-19 #6: the server decides the stage from the status first.
  const serverProgress = (overrides = {}) => ({
    stage: 'closed',
    tone: 'resolved',
    headline: 'Closed',
    current: 3,
    assigned: false,
    waitingOnRequester: false,
    reopened: false,
    resumeAt: null,
    mergedInto: null,
    steps: [
      { key: 'received', label: 'Received', state: 'complete' },
      { key: 'in_progress', label: 'In progress', state: 'skipped' },
      { key: 'closed', label: 'Closed', state: 'complete' },
    ],
    ...overrides,
  });

  test('closed with nobody assigned: Closed, skipped steps marked, never Received', async () => {
    renderPage(basePayload({
      ticket: { status: 'Closed', statusTone: 'resolved', assignedAgent: { name: null, photoUrl: null }, assignedAt: null },
      timeline: [{ key: 'received' }, { key: 'closed', label: 'Closed' }],
      eta: { state: 'resolved', isComplete: true, sampleSize: 0 },
      progress: serverProgress(),
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Closed');
    expect(stepStates()).toEqual(['complete', 'skipped', 'complete']);
    expect(screen.getByText('In progress', { exact: false }).textContent).toMatch(/skipped/);
    expect(screen.getByText('This request is closed.')).toBeInTheDocument();
    expect(screen.queryByText('Not assigned yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Mark as urgent/ })).not.toBeInTheDocument();
  });

  test('an older payload without progress still reads a closed, unassigned ticket as Closed', async () => {
    renderPage(basePayload({
      ticket: { status: 'Closed', statusTone: 'neutral', assignedAgent: { name: null, photoUrl: null }, assignedAt: null },
      timeline: [{ key: 'received' }],
      eta: { state: 'resolved', sampleSize: 0 },
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Closed');
    expect(stepStates()).toEqual(['complete', 'skipped', 'complete']);
  });

  test('merged: says where the request continues and links there', async () => {
    renderPage(basePayload({
      ticket: { status: 'Closed', statusTone: 'resolved' },
      progress: serverProgress({
        stage: 'merged',
        headline: 'Merged',
        mergedInto: { displayRef: 'TP-10020', statusUrl: 'https://status.example.com/ticket-status/other' },
        steps: [
          { key: 'received', label: 'Received', state: 'complete' },
          { key: 'assigned', label: 'Assigned', state: 'complete' },
          { key: 'in_progress', label: 'In progress', state: 'complete' },
          { key: 'merged', label: 'Merged', state: 'complete' },
        ],
      }),
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Merged');
    // A server still sending four steps (mid-deploy): the Assigned one is dropped.
    expect(stepStates()).toEqual(['complete', 'complete', 'complete']);
    expect(screen.getByText('This request continues on TP-10020.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /See the status of TP-10020/ }))
      .toHaveAttribute('href', 'https://status.example.com/ticket-status/other');
    expect(screen.queryByRole('link', { name: /Mark as urgent/ })).not.toBeInTheDocument();
  });

  test('reopened: says so instead of quoting the old estimate', async () => {
    renderPage(basePayload({
      progress: serverProgress({
        stage: 'in_progress',
        tone: 'open',
        headline: 'Reopened',
        current: 1,
        assigned: true,
        reopened: true,
        steps: [
          { key: 'received', label: 'Received', state: 'complete' },
          { key: 'in_progress', label: 'In progress', state: 'current' },
          { key: 'resolved', label: 'Resolved', state: 'upcoming' },
        ],
      }),
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('Reopened');
    expect(screen.getByText('We reopened this request and are looking at it again.')).toBeInTheDocument();
    expect(screen.queryByText('How we estimate this')).not.toBeInTheDocument();
  });

  test('parked: On hold with the day it comes back', async () => {
    renderPage(basePayload({
      progress: serverProgress({
        stage: 'waiting',
        tone: 'waiting',
        headline: 'On hold',
        current: 1,
        assigned: true,
        resumeAt: '2026-10-20T16:00:00.000Z',
        steps: [
          { key: 'received', label: 'Received', state: 'complete' },
          { key: 'waiting', label: 'On hold', state: 'current' },
          { key: 'resolved', label: 'Resolved', state: 'upcoming' },
        ],
      }),
    }));
    expect(await screen.findByTestId('status-headline')).toHaveTextContent('On hold');
    expect(screen.getByText(/We plan to pick it up again by/)).toBeInTheDocument();
  });

  test('an expired link explains itself and offers no pointless retry', async () => {
    apiMock.get.mockImplementation(() => Promise.reject(
      Object.assign(new Error('This ticket status link has expired'), { status: 403 }),
    ));
    render(
      <MemoryRouter initialEntries={['/ticket-status/tok']}>
        <Routes><Route path="/ticket-status/:token" element={<PublicTicketStatus />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'This link is no longer active' })).toBeInTheDocument();
    expect(screen.getByText(/will carry a fresh link/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
  });

  test('request summary sits collapsed under "Your request" with links made clickable', async () => {
    renderPage(basePayload());
    const summary = await screen.findByText('Your request');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByRole('link', { hidden: true })).toHaveAttribute('href', 'https://example.com/dock-help');
  });

  test('page backdrop and a full-size header logo', async () => {
    renderPage(basePayload({ branding: { brandName: 'Example IT Help', accentColor: '#2563eb', logoDataUrl: 'data:image/png;base64,AAAA', logoAltText: 'Example' } }));
    const logo = await screen.findByRole('img', { name: 'Example' });
    expect(logo).toHaveClass('h-12', 'sm:h-16');
    // Portrait crop on phones, the wide scene from sm up.
    const backdrop = screen.getByTestId('status-page-backdrop');
    expect(backdrop.className).toContain("bg-[url('/brand/status/page-backdrop-portrait.webp')]");
    expect(backdrop.className).toContain("sm:bg-[url('/brand/status/page-backdrop.webp')]");
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByTestId('status-header')).toHaveTextContent('Request status');
  });

  test('trimBounds finds the drawn pixels inside a white margin', () => {
    // 4x4 RGBA, white everywhere except a navy 2x1 run at (1,2)-(2,2).
    const px = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    for (const x of [1, 2]) { const i = (2 * 4 + x) * 4; px[i] = 3; px[i + 1] = 29; px[i + 2] = 115; }
    expect(trimBounds(px, 4, 4)).toEqual({ x: 1, y: 2, w: 2, h: 1 });
    expect(trimBounds(new Uint8ClampedArray(16).fill(255), 2, 2)).toBeNull();
  });
});
