/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  analyticsAPI: {
    getAiPickAccuracy: vi.fn(),
    getAiPickAccuracyExport: vi.fn(),
  },
}));

import { analyticsAPI } from '../../services/api';
import AiPickAccuracy, { buildPickTrendOptions, overrideHowText, rowsToCsv } from './AiPickAccuracy';

/**
 * Analytics → Automation Ops, "How often the AI's pick stands" (QA 10-13 #16).
 * Every rate carries its count; under 20 tickets there is no rate at all.
 */
const rate = (n, of) => ({ n, of, pct: of >= 20 ? Math.round((n / of) * 100) : null });
const RULES = { minRateSample: 20, openHoldHours: 24, quickChangeMinutes: 60 };

const SUGGEST = {
  mode: 'suggest',
  eligible: 119,
  tickets: 118,
  firstChoice: rate(31, 118),
  inList: rate(66, 118),
  changed: rate(52, 118),
  notYet: { tooEarly: 1, nobodyHasIt: 0, closedWithNoOwner: 0 },
  review: { of: 119, approvedAsIs: 0, changedInReview: 0, rejected: 0, notAnswered: 119 },
  taken: { pickedUp: 114, assignedBy: 2, unknown: 2 },
  categories: [
    { name: 'Proposal Setup', tickets: 60, firstChoice: rate(17, 60), inList: rate(36, 60), changed: rate(24, 60) },
    { name: 'Research & Development', tickets: 3, firstChoice: rate(0, 3), inList: rate(1, 3), changed: rate(2, 3) },
  ],
  weeks: [
    { week: '2026-09-14', tickets: 45, firstChoice: rate(17, 45), inList: rate(29, 45), changed: rate(16, 45) },
    { week: '2026-09-28', tickets: 19, firstChoice: rate(4, 19), inList: rate(10, 19), changed: rate(9, 19) },
  ],
  spread: [
    { name: 'Ada Byron', firstChoice: 60, didIt: 29 },
    { name: 'Ben Okri', firstChoice: 6, didIt: 32 },
  ],
  overrides: [
    { ticketId: 63042, displayRef: 'TP-1912', subject: 'Request for Williams', category: 'Proposal Setup', runAt: '2026-10-13T18:59:31.059Z', aiFirstChoice: 'Ada Byron', tookIt: 'Ben Okri', inList: true, how: 'picked_up', by: null, minutes: null, rebounded: false },
  ],
};

const AUTO = {
  mode: 'auto',
  eligible: 708,
  tickets: 671,
  firstChoice: rate(488, 671),
  inList: rate(574, 671),
  changed: rate(159, 671),
  notYet: { tooEarly: 35, nobodyHasIt: 0, closedWithNoOwner: 2 },
  changes: { handedBack: 70, movedByOther: 79, unknown: 10, withinHour: 126, later: 23, timeUnknown: 10, rebounded: 79, movedByTicketPulse: 37 },
  categories: [{ name: 'Software & Apps', tickets: 140, firstChoice: rate(102, 140), inList: rate(121, 140), changed: rate(37, 140) }],
  weeks: [{ week: '2026-09-14', tickets: 164, firstChoice: rate(133, 164), inList: rate(146, 164), changed: rate(29, 164) }],
  spread: [],
  overrides: [
    { ticketId: 63066, displayRef: 'TP-1917', subject: 'Get codex', category: 'Software & Apps', runAt: '2026-10-13T19:55:10.550Z', aiFirstChoice: 'Ada Byron', tookIt: 'Cy Twombly', inList: true, how: 'handed_back', by: 'Ada Byron', minutes: 9, rebounded: true },
  ],
};

const payload = (over = {}) => ({
  rules: RULES,
  setup: { enabled: true, autoAssign: false, suggestOnlyGroups: 0, shadowGroups: 0 },
  counts: {
    considered: 124, eligible: 119, judged: 118, excludedTotal: 5,
    excluded: { noise: 0, removed: 4, duplicates: 0, onboarding: 0, ownedBeforeAi: 1, namedNobody: 0, earlierPeriod: 0 },
    notYet: { tooEarly: 1, nobodyHasIt: 0, closedWithNoOwner: 0 },
  },
  leadMode: 'suggest',
  auto: null,
  suggest: SUGGEST,
  ...over,
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('AiPickAccuracy', () => {
  it('shows each rate with its count (the AI only suggested)', () => {
    render(<AiPickAccuracy data={payload()} />);
    expect(screen.getByRole('heading', { name: /How often the AI.s pick stands/ })).toBeInTheDocument();
    expect(screen.getByText(/118 tickets counted in this period/)).toBeInTheDocument();

    const first = screen.getByTestId('ai-pick-figure-aiPickFirstChoiceTook');
    expect(within(first).getByText('26%')).toBeInTheDocument();
    expect(within(first).getByText('31 of 118 tickets')).toBeInTheDocument();
    const listed = screen.getByTestId('ai-pick-figure-aiPickInListSuggest');
    expect(within(listed).getByText('56%')).toBeInTheDocument();
    expect(within(listed).getByText('66 of 118 tickets')).toBeInTheDocument();
    const off = screen.getByTestId('ai-pick-figure-aiPickOffList');
    expect(within(off).getByText('44%')).toBeInTheDocument();
    expect(within(off).getByText('52 of 118 tickets')).toBeInTheDocument();

    // The review queue's own answer, and how people came to have the ticket.
    expect(screen.getByText('Not answered: the ticket was taken directly')).toBeInTheDocument();
    expect(screen.getByText('Picked it up themselves')).toBeInTheDocument();
    expect(screen.getByTestId('ai-pick-not-yet')).toHaveTextContent('1 still open and with their owner for less than a day');
  });

  it('by category: a percentage with n of N from 20 tickets, only the count below that', () => {
    render(<AiPickAccuracy data={payload()} />);
    const table = screen.getByTestId('ai-pick-categories');
    const big = within(table).getByRole('row', { name: /Proposal Setup/ });
    expect(within(big).getByText('28%')).toBeInTheDocument();
    expect(within(big).getByText('17 of 60')).toBeInTheDocument();
    const small = within(table).getByRole('row', { name: /Research & Development/ });
    expect(within(small).queryByText(/%/)).toBeNull();
    expect(within(small).getByText('0 of 3')).toHaveAttribute('title', expect.stringMatching(/Not enough tickets yet/));
  });

  it('says "not enough tickets yet" instead of a rate when the period is small', () => {
    const tiny = { ...SUGGEST, tickets: 7, firstChoice: rate(3, 7), inList: rate(5, 7), changed: rate(2, 7), categories: [], weeks: [], overrides: [], spread: [] };
    render(<AiPickAccuracy data={payload({ suggest: tiny, counts: { ...payload().counts, judged: 7 } })} />);
    const first = screen.getByTestId('ai-pick-figure-aiPickFirstChoiceTook');
    expect(within(first).getByText('Not enough tickets yet')).toBeInTheDocument();
    expect(within(first).getByText('3 of 7 tickets (a rate needs 20)')).toBeInTheDocument();
    expect(within(first).queryByText(/%/)).toBeNull();
    expect(screen.getAllByText('Not enough tickets yet')).toHaveLength(3);
  });

  it('lists recent tickets not done by the first choice, linking to the ticket', () => {
    render(<AiPickAccuracy data={payload()} />);
    const table = screen.getByTestId('ai-pick-overrides');
    const link = within(table).getByRole('link', { name: 'TP-1912' });
    expect(link).toHaveAttribute('href', '/tickets/63042');
    const row = link.closest('tr');
    expect(within(row).getByText('Ada Byron')).toBeInTheDocument();
    expect(within(row).getByText('Ben Okri')).toBeInTheDocument();
    expect(within(row).getByText("On the AI's list")).toBeInTheDocument();
    expect(within(row).getByText('Picked it up')).toBeInTheDocument();
  });

  it('explains how it is counted and what was left out', () => {
    render(<AiPickAccuracy data={payload()} />);
    const how = screen.getByTestId('ai-pick-how-counted');
    expect(within(how).getByText('How this is counted')).toBeInTheDocument();
    expect(how).toHaveTextContent('A ticket is counted once, by the first AI run');
    expect(screen.getByTestId('ai-pick-left-out')).toHaveTextContent('124 tickets had an AI assignment run, 118 counted. Left out: 4 deleted or spam; 1 a person already had before the AI ran.');
  });

  it('the spread across the team is closed until asked for, and alphabetical', () => {
    render(<AiPickAccuracy data={payload()} />);
    expect(screen.queryByTestId('ai-pick-spread')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Spread across the team' }));
    const rows = within(screen.getByTestId('ai-pick-spread')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['Ada Byron6029', 'Ben Okri632']);
  });

  it('the AI assigned: first choice kept, changed by a person, how and how soon; tabs when both modes have tickets', () => {
    render(<AiPickAccuracy data={payload({ leadMode: 'auto', auto: AUTO, counts: { ...payload().counts, judged: 789 } })} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['The AI assigned 671', 'The AI only suggested 118']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

    const kept = screen.getByTestId('ai-pick-figure-aiPickFirstChoiceKept');
    expect(within(kept).getByText('73%')).toBeInTheDocument();
    expect(within(kept).getByText('488 of 671 tickets')).toBeInTheDocument();
    const changed = screen.getByTestId('ai-pick-figure-aiPickChangedByPerson');
    expect(within(changed).getByText('24%')).toBeInTheDocument();
    expect(screen.getByText('Handed back by the assignee')).toBeInTheDocument();
    expect(screen.getByText('Within 60 minutes')).toBeInTheDocument();
    expect(screen.getByText(/37 more tickets were moved by Ticket Pulse itself/)).toBeInTheDocument();
    expect(within(screen.getByTestId('ai-pick-overrides')).getByText('Handed back by Ada Byron after 9 min, then back to the AI for another pick')).toBeInTheDocument();

    fireEvent.click(tabs[1]);
    expect(screen.getByTestId('ai-pick-mode-suggest')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-pick-mode-auto')).toBeNull();
  });

  it('nothing to count: says so, with no rates', () => {
    render(<AiPickAccuracy data={payload({ suggest: null, leadMode: null, counts: { ...payload().counts, considered: 0, judged: 0 } })} />);
    expect(screen.getByTestId('ai-pick-empty')).toHaveTextContent('No tickets with an AI pick to count in this period.');
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('loads its own data for the page range, and passes the trend to the page chart block', async () => {
    analyticsAPI.getAiPickAccuracy.mockResolvedValue({ success: true, data: payload() });
    const ChartBlock = vi.fn(() => <div data-testid="chart" />);
    render(<AiPickAccuracy params={{ range: '30d', timezone: 'America/Los_Angeles' }} ChartBlock={ChartBlock} />);
    expect(screen.getByTestId('ai-pick-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('chart')).toBeInTheDocument());
    expect(analyticsAPI.getAiPickAccuracy).toHaveBeenCalledWith({ range: '30d', timezone: 'America/Los_Angeles' });
    const options = ChartBlock.mock.calls[0][0].options;
    expect(options.series.map((s) => s.name)).toEqual(['Tickets counted', 'First choice did it', 'In the list', 'Not on the list']);
  });

  it('a failed load offers a retry', async () => {
    analyticsAPI.getAiPickAccuracy.mockRejectedValueOnce(new Error('Network Error')).mockResolvedValue({ data: payload() });
    render(<AiPickAccuracy params={{ range: '30d' }} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network Error'));
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.getByTestId('ai-pick-mode-suggest')).toBeInTheDocument());
  });
});

describe('helpers', () => {
  it('the trend leaves a gap for a week with too few tickets, and keeps n of N for the tooltip', () => {
    const options = buildPickTrendOptions(SUGGEST.weeks, 'suggest', { blue: '#1', green: '#2', amber: '#3', ash: '#4' });
    expect(options.series[0].data).toEqual([45, 19]);
    expect(options.series[1].data).toEqual([{ y: 38, n: 17, of: 45 }, { y: null, n: 4, of: 19 }]);
    expect(options.series[1].color).toBe('#1');
    expect(options.yAxis[0]).toMatchObject({ min: 0, max: 100 });
  });

  it('plain words for how', () => {
    expect(overrideHowText({ how: 'moved_by_other', by: 'Dee Rees', minutes: 180 })).toBe('Moved by Dee Rees after 3 h');
    expect(overrideHowText({ how: 'handed_back', by: null, minutes: 0 })).toBe('Handed back within a minute');
    expect(overrideHowText({ how: 'assigned_by', by: 'Dee Rees' })).toBe('Assigned by Dee Rees');
    expect(overrideHowText({ how: 'unknown' })).toBe('How is not recorded');
  });

  it('CSV: quoted where needed, and a subject can never run as a formula', () => {
    expect(rowsToCsv([{ Ticket: 'TP-1', Subject: '=HYPERLINK("x")', Note: 'a, b' }]))
      .toBe('Ticket,Subject,Note\r\nTP-1,"\'=HYPERLINK(""x"")","a, b"');
    expect(rowsToCsv([])).toBe('');
  });
});
