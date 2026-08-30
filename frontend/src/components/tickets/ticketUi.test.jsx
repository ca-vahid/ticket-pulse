/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  AgentFirstName, ExternalChip, FeaturedFieldChip, MirrorChip, OriginChip, PersonAvatar, PriorityDot, QueueStatePill, SlaChip, SlaTargetChip, StatusPill, formatDay, formatDayTime, initials, slaTargetState, timeAgo, timeAgoShort,
} from './ticketUi';

afterEach(cleanup);

describe('ticketUi helpers', () => {
  test('timeAgo formats recent and old values', () => {
    expect(timeAgo(new Date(Date.now() - 10 * 1000))).toBe('just now');
    expect(timeAgo(new Date(Date.now() - 5 * 60 * 1000))).toBe('5m ago');
    expect(timeAgo(new Date(Date.now() - 3 * 3600 * 1000))).toBe('3h ago');
    expect(timeAgo(null)).toBe('—');
  });

  test('timeAgoShort keeps counting past 7 days instead of returning a date (QA 08-24 #2)', () => {
    const ago = (ms) => new Date(Date.now() - ms);
    const DAY = 24 * 3600 * 1000;
    // Shares timeAgo's sub-week ladder…
    expect(timeAgoShort(ago(10 * 1000))).toBe('just now');
    expect(timeAgoShort(ago(5 * 60 * 1000))).toBe('5m ago');
    expect(timeAgoShort(ago(3 * 3600 * 1000))).toBe('3h ago');
    expect(timeAgoShort(ago(6 * DAY))).toBe('6d ago');
    // …and at the 7-day boundary timeAgo becomes a DATE while timeAgoShort stays relative.
    expect(timeAgo(ago(7 * DAY))).not.toMatch(/ago$/);
    expect(timeAgoShort(ago(7 * DAY))).toBe('1w ago');
    expect(timeAgoShort(ago(8 * DAY))).toBe('1w ago');
    expect(timeAgoShort(ago(13 * DAY))).toBe('1w ago');
    expect(timeAgoShort(ago(14 * DAY))).toBe('2w ago');
    expect(timeAgoShort(ago(29 * DAY))).toBe('4w ago');
    expect(timeAgoShort(ago(30 * DAY))).toBe('1mo ago');
    expect(timeAgoShort(ago(150 * DAY))).toBe('5mo ago');
    expect(timeAgoShort(ago(364 * DAY))).toBe('12mo ago');
    expect(timeAgoShort(ago(365 * DAY))).toBe('1y ago');
    expect(timeAgoShort(ago(2 * 365 * DAY + DAY))).toBe('2y ago');
    expect(timeAgoShort(null)).toBe('—');
    expect(timeAgoShort('not a date')).toBe('—');
  });

  test('formatDayTime/formatDay spell out the year only when the date is off-year (QA 08-04 #17a)', () => {
    // Midday mid-month so no timezone can nudge the date across a year edge.
    const thisYear = new Date();
    thisYear.setMonth(6, 15);
    thisYear.setHours(12, 0, 0, 0);
    const lastYear = new Date(thisYear);
    lastYear.setFullYear(thisYear.getFullYear() - 1);

    expect(formatDayTime(thisYear)).not.toContain(String(thisYear.getFullYear()));
    expect(formatDayTime(lastYear)).toContain(String(lastYear.getFullYear()));
    expect(formatDay(thisYear)).not.toContain(String(thisYear.getFullYear()));
    expect(formatDay(lastYear)).toContain(String(lastYear.getFullYear()));
    expect(formatDayTime(null)).toBe('—');
    expect(formatDay('not-a-date')).toBe('—');
  });

  test('initials collapses names', () => {
    expect(initials('Rita Requester')).toBe('RR');
    expect(initials('Cher')).toBe('C');
    expect(initials('')).toBe('?');
  });

  test('slaTargetState covers the SLA badge state machine', () => {
    const target = new Date('2026-07-28T13:00:00Z');
    const before = new Date('2026-07-28T09:00:00Z');
    const after = new Date('2026-07-29T13:00:00Z');
    // Met at/before target → met (green), never live.
    expect(slaTargetState({ target, metAt: before, isTerminal: true }).state).toBe('met');
    expect(slaTargetState({ target, metAt: target, isTerminal: false }).state).toBe('met');
    // Met after target → late (amber, historical), even while the ticket is open.
    expect(slaTargetState({ target, metAt: after, isTerminal: false }).state).toBe('late');
    expect(slaTargetState({ target, metAt: after, isTerminal: true }).state).toBe('late');
    // Terminal ticket, fulfillment time unknown → unknown (quiet), NEVER overdue.
    expect(slaTargetState({ target, metAt: null, isTerminal: true }).state).toBe('unknown');
    // Open ticket, not yet fulfilled → live (countdown/overdue chip applies).
    expect(slaTargetState({ target, metAt: null, isTerminal: false }).state).toBe('live');
    // No/invalid target → no row state at all.
    expect(slaTargetState({ target: null })).toBeNull();
    expect(slaTargetState({ target: 'not-a-date' })).toBeNull();
  });
});

describe('ticketUi components', () => {
  test('StatusPill renders known and unknown statuses', () => {
    render(<StatusPill status="Open" />);
    expect(screen.getByText('Open')).toBeInTheDocument();
    render(<StatusPill status="Weird" />);
    expect(screen.getByText('Weird')).toBeInTheDocument();
  });

  test('PriorityDot exposes an accessible priority label', () => {
    render(<PriorityDot priority={4} />);
    expect(screen.getByText('Urgent priority')).toBeInTheDocument();
  });

  test('PriorityDot withLabel shows the word; the title can be overridden for the read-only FS note (Phase QX)', () => {
    const { container } = render(<PriorityDot priority={3} withLabel title="Priority: High — synced from FreshService, read-only here" />);
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('title', 'Priority: High — synced from FreshService, read-only here');
  });

  // Queue State column (Mega 08-30 Phase QX): labelled pill per server state,
  // StatusPill geometry, tones in the StateChip family, "—" for null with the
  // incomplete-history caveat in the tooltip.
  test.each([
    ['new', 'New', 'bg-blue-50', 'text-blue-700'],
    ['response_due', 'Response due', 'bg-amber-50', 'text-amber-700'],
    ['requester_responded', 'Requester replied', 'bg-sky-50', 'text-sky-700'],
  ])('QueueStatePill %s renders a labelled pill', (state, label, bg, fg) => {
    render(<QueueStatePill state={state} />);
    const pill = screen.getByText(label).closest('span[title]');
    expect(pill).toHaveClass('rounded-full', 'text-[11px]', 'font-semibold', bg, fg);
    expect(pill.title).toContain(label);
    expect(pill.title).toMatch(/First-response history is incomplete/);
  });

  test('QueueStatePill null/unknown → quiet "—" carrying the caveat, never a guessed state', () => {
    render(<QueueStatePill state={null} />);
    const dash = screen.getByLabelText('No state');
    expect(dash).toHaveTextContent('—');
    // Dark mode (DM-B): the quiet dash rides the muted token at half strength.
    expect(dash).toHaveClass('text-muted-foreground/50');
    expect(dash.title).toMatch(/unknown/);
    expect(dash.title).toMatch(/First-response history is incomplete/);
    cleanup();
    render(<QueueStatePill state="overdue" />); // not a queue state — the SLA chip owns it
    expect(screen.getByLabelText('No state')).toBeInTheDocument();
  });

  test('OriginChip distinguishes TP-born from FS-born', () => {
    render(<OriginChip origin="ticketpulse" />);
    expect(screen.getByText('Ticket Pulse')).toBeInTheDocument();
    render(<OriginChip origin="freshservice" />);
    expect(screen.getByText('FreshService')).toBeInTheDocument();
  });

  test('MirrorChip only renders for TP-born tickets and reflects state', () => {
    const { container } = render(<MirrorChip ticket={{ origin: 'freshservice' }} />);
    expect(container).toBeEmptyDOMElement();

    render(<MirrorChip ticket={{ origin: 'ticketpulse', mirrorState: 'pending' }} />);
    expect(screen.getByText('Mirror pending')).toBeInTheDocument();

    render(<MirrorChip ticket={{ origin: 'ticketpulse', mirrorState: 'mirrored' }} />);
    expect(screen.getByText('Mirrored')).toBeInTheDocument();

    render(<MirrorChip ticket={{ origin: 'ticketpulse', mirrorState: 'error', mirrorError: 'boom' }} />);
    expect(screen.getByText('Mirror error')).toBeInTheDocument();
  });

  test('AgentFirstName is display-only: first name below xl, full name at xl+ and in the tooltip (QA 08-04 iPad)', () => {
    const { container } = render(<AgentFirstName name="Mehdi Rahimi" className="text-xs" />);
    const wrapper = container.firstChild;
    // Full name always survives in the tooltip — no data is lost on tablets.
    expect(wrapper).toHaveAttribute('title', 'Mehdi Rahimi');
    // Two CSS-swapped spans: tablet band shows the first name only, xl+ the full name.
    expect(screen.getByText('Mehdi')).toHaveClass('xl:hidden');
    expect(screen.getByText('Mehdi Rahimi')).toHaveClass('hidden', 'xl:inline');
    // Empty names render nothing rather than an empty chip.
    const empty = render(<AgentFirstName name="  " />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  test('ExternalChip wraps as a unit instead of compressing into neighbours (QA 08-04 #5)', () => {
    render(<ExternalChip />);
    const chip = screen.getByText('External');
    expect(chip).toHaveClass('shrink-0', 'whitespace-nowrap');
  });

  test('PersonAvatar falls back to initials, then to a generic glyph', () => {
    render(<PersonAvatar name="Terry Tech" />);
    expect(screen.getByText('TT')).toBeInTheDocument();
    const { container } = render(<PersonAvatar name={null} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  test('SlaTargetChip never shows a live Overdue badge on a closed ticket (bug: FS #234903)', () => {
    // Closed ticket, first-response target a week in the past, reply time
    // unknown (sparse FS data) → quiet "—" chip with an explanatory tooltip.
    const pastTarget = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    render(<SlaTargetChip target={pastTarget} metAt={null} status="Closed" kind="response" />);
    const quiet = screen.getByText('—');
    expect(quiet).toBeInTheDocument();
    expect(quiet).toHaveAttribute('title', expect.stringContaining('First response target was'));
    expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
  });

  test('SlaTargetChip freezes outcomes: Met, Met late, Done, Resolved late', () => {
    const target = '2026-07-28T13:00:00Z';
    render(<SlaTargetChip target={target} metAt="2026-07-28T09:00:00Z" status="Open" kind="response" />);
    expect(screen.getByText('Met')).toBeInTheDocument();
    render(<SlaTargetChip target={target} metAt="2026-07-30T09:00:00Z" status="Closed" kind="response" />);
    expect(screen.getByText('Met late')).toBeInTheDocument();
    render(<SlaTargetChip target={target} metAt="2026-07-27T09:00:00Z" status="Resolved" kind="resolution" />);
    expect(screen.getByText('Done')).toBeInTheDocument();
    render(<SlaTargetChip target={target} metAt="2026-07-29T21:00:00Z" status="Closed" kind="resolution" />);
    expect(screen.getByText('Resolved late')).toBeInTheDocument();
    expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
  });

  // Phase SLA (QA 08-17 #9) — calendar-aware workspaces explain the clock.
  test('SlaChip live countdown carries the business-hours tooltip only when calendarAware', () => {
    const futureTarget = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    render(<SlaChip value={futureTarget} calendarAware />);
    expect(screen.getByText(/left/)).toHaveAttribute('title', expect.stringContaining('Business-hours clock'));
    cleanup();
    render(<SlaChip value={futureTarget} />);
    expect(screen.getByText(/left/)).not.toHaveAttribute('title');
    cleanup();
    // Paused keeps its own explanation regardless of the calendar flag.
    render(<SlaChip value={futureTarget} paused calendarAware />);
    expect(screen.getByText('Paused')).toHaveAttribute('title', expect.stringContaining('paused while the ticket is pending'));
  });

  test('SlaTargetChip threads calendarAware to the live chip but not to frozen outcomes', () => {
    const futureTarget = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    render(<SlaTargetChip target={futureTarget} metAt={null} status="Open" kind="resolution" calendarAware />);
    expect(screen.getByText(/left/)).toHaveAttribute('title', expect.stringContaining('Business-hours clock'));
    cleanup();
    render(<SlaTargetChip target="2026-07-28T13:00:00Z" metAt="2026-07-28T09:00:00Z" status="Open" kind="response" calendarAware />);
    // Frozen outcome keeps its met/late tooltip — no clock-mode noise.
    expect(screen.getByText('Met')).toHaveAttribute('title', expect.stringContaining('before the'));
  });

  test('SlaTargetChip keeps the live countdown for open tickets past due', () => {
    const pastTarget = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    render(<SlaTargetChip target={pastTarget} metAt={null} status="Open" kind="response" />);
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
    // Pending pauses the clock instead of nagging.
    cleanup();
    render(<SlaTargetChip target={pastTarget} metAt={null} status="Pending" kind="response" />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  // Phase 2 — the featured custom-field chip on queue rows / peek.
  test('FeaturedFieldChip renders "Label: value", truncated ~24ch with full text in the tooltip', () => {
    const def = { key: 'client_name', label: 'Client Name' };
    render(<FeaturedFieldChip def={def} value="ACME" />);
    expect(screen.getByText('Client Name: ACME')).toBeInTheDocument();

    cleanup();
    render(<FeaturedFieldChip def={def} value="Coyote Landslide Geotechnical" />);
    const chip = screen.getByTestId('featured-field-chip');
    expect(chip).toHaveAttribute('title', 'Client Name: Coyote Landslide Geotechnical');
    expect(chip.textContent.length).toBeLessThanOrEqual(24);
    expect(chip.textContent.endsWith('…')).toBe(true);
  });

  test('FeaturedFieldChip: booleans render Yes/No; empty values render nothing', () => {
    const def = { key: 'expedite', label: 'Expedite' };
    render(<FeaturedFieldChip def={def} value={true} />);
    expect(screen.getByText('Expedite: Yes')).toBeInTheDocument();
    cleanup();
    const { container } = render(<FeaturedFieldChip def={def} value="" />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const none = render(<FeaturedFieldChip def={null} value="x" />);
    expect(none.container).toBeEmptyDOMElement();
  });
});
