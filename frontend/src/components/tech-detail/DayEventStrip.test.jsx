/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import DayEventStrip, {
  buildDayEvents, clusterEvents, computeAxis, layoutMarkers,
} from './DayEventStrip';

// ─────────────────────────────────────────────────────────────────────────────
// The no-hidden-events invariant: every event the day produced is individually
// accounted for on the strip — as its own dot, inside a same-type batch chip,
// or inside an "×N" overflow chip. Σ(data-evcount) === event count, always.
// ─────────────────────────────────────────────────────────────────────────────

// 10:00 AM Pacific on 2026-07-28 (17:00 UTC, PDT = UTC-7).
const TEN_AM_PT = '2026-07-28T17:00:00.000Z';
const DAY_ISO = '2026-07-28';

function ticket(id, overrides = {}) {
  return {
    id,
    subject: `Ticket ${id}`,
    status: 'Open',
    isSelfPicked: false,
    firstAssignedAt: TEN_AM_PT,
    createdAt: TEN_AM_PT,
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div>
      <p>Ticket detail page</p>
      <span data-testid="from-state">{location.state?.from || ''}</span>
    </div>
  );
}

function renderStrip(tickets, entry = '/technician/5?date=2026-07-28') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/technician/:id"
          element={<DayEventStrip ticketsOnDate={tickets} dayLabel="Jul 28" dayIso={DAY_ISO} />}
        />
        <Route path="/tickets/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function sumEvCounts(container) {
  return Array.from(container.querySelectorAll('[data-evcount]'))
    .reduce((sum, el) => sum + Number(el.getAttribute('data-evcount')), 0);
}

afterEach(() => cleanup());

describe('layoutMarkers (unit invariant)', () => {
  test('every marker lands in exactly one unit, for 1..30 identical timestamps', () => {
    const ts = new Date(TEN_AM_PT).getTime();
    for (let n = 1; n <= 30; n += 1) {
      // Alternate types so batch clustering (same-type ≥5) never kicks in and
      // pure x-collision stacking/overflow is what's under test.
      const events = Array.from({ length: n }, (_, i) => ({
        id: `e-${i}`,
        type: i % 2 === 0 ? 'self' : 'assigned',
        ts,
        ticket: { id: i + 1, subject: `T${i}` },
      }));
      const markers = clusterEvents(events);
      const placed = layoutMarkers(markers, computeAxis(events));
      const total = placed.reduce((s, u) => s + u.count, 0);
      expect(total).toBe(n);
      // Nothing may render outside the lane budget as an unstacked pile:
      // per column at most 4 units (chips included).
      expect(placed.every((u) => u.lanes <= 4)).toBe(true);
    }
  });
});

describe('DayEventStrip (rendered invariant)', () => {
  test('10 handled + 10 closed with identical timestamps are all accounted for', () => {
    // 10 arrivals at the exact same instant (alternating self/assigned so the
    // same-type batch rule stays out of the way) + 10 closes at one other
    // instant — the user-reported shape where dots used to hide each other.
    const tickets = Array.from({ length: 10 }, (_, i) => ticket(i + 1, {
      isSelfPicked: i % 2 === 0,
      status: 'Closed',
      closedAt: '2026-07-28T21:30:00.000Z', // 2:30 PM PT — all 10 closes collide too
    }));
    const { container } = renderStrip(tickets);
    // 10 arrival events + 10 close events = 20, every one represented.
    expect(sumEvCounts(container)).toBe(20);
    expect(screen.getByText(/20 events/)).toBeInTheDocument();
  });

  test('≥5 same-type events within 15 min render as one hoverable batch chip carrying its full count', () => {
    const tickets = Array.from({ length: 6 }, (_, i) => ticket(i + 1));
    const { container } = renderStrip(tickets);
    const chip = screen.getByRole('button', { name: /Assigned batch of 6/ });
    expect(chip).toHaveTextContent('×6');
    expect(sumEvCounts(container)).toBe(6);
    // Click pins the member popover listing ref + subject + time.
    fireEvent.click(chip);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ticket 1');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ticket 6');
  });

  test('legend chips filter a type out and the visible sum follows', () => {
    const tickets = [
      ticket(1, { isSelfPicked: true, firstAssignedAt: '2026-07-28T16:00:00.000Z' }),
      ticket(2, { firstAssignedAt: '2026-07-28T18:00:00.000Z' }),
      ticket(3, { firstAssignedAt: '2026-07-28T20:00:00.000Z' }),
    ];
    const { container } = renderStrip(tickets);
    expect(sumEvCounts(container)).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: /^Assigned: 2 events$/ }));
    expect(sumEvCounts(container)).toBe(1); // only the self-picked dot remains
    fireEvent.click(screen.getByRole('button', { name: /Assigned: 2 events \(hidden\)/ }));
    expect(sumEvCounts(container)).toBe(3);
  });

  test('Hourly view buckets counts per hour (counts, never durations) and keeps the sum', () => {
    const tickets = [
      ticket(1, { firstAssignedAt: '2026-07-28T16:10:00.000Z' }), // 9:10a PT
      ticket(2, { firstAssignedAt: '2026-07-28T16:40:00.000Z' }), // 9:40a PT
      ticket(3, { firstAssignedAt: '2026-07-28T22:05:00.000Z' }), // 3:05p PT
    ];
    const { container } = renderStrip(tickets);
    fireEvent.click(screen.getByRole('button', { name: 'Hourly' }));
    expect(screen.getByRole('group', { name: 'Hourly event histogram' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /9a to 10a: 2 assigned/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3p to 4p: 1 assigned/ })).toBeInTheDocument();
    expect(sumEvCounts(container)).toBe(3);
  });

  test('axis auto-extends for events before 8am / after 6pm (never clipped)', () => {
    const tickets = [
      ticket(1, { firstAssignedAt: '2026-07-28T13:30:00.000Z' }), // 6:30a PT
      ticket(2, { firstAssignedAt: '2026-07-29T03:30:00.000Z' }), // 8:30p PT
    ];
    const { container } = renderStrip(tickets);
    expect(sumEvCounts(container)).toBe(2);
    const events = buildDayEvents({ ticketsOnDate: tickets, dayIso: DAY_ISO });
    const axis = computeAxis(events);
    expect(axis.start).toBeLessThanOrEqual(6);
    expect(axis.end).toBeGreaterThanOrEqual(21);
  });

  test('dot click navigates to /tickets/:id carrying the return address', () => {
    renderStrip([ticket(42)]);
    fireEvent.click(screen.getByRole('button', { name: /TP-ID-42 at 10:00 AM/ }));
    expect(screen.getByText('Ticket detail page')).toBeInTheDocument();
    expect(screen.getByTestId('from-state')).toHaveTextContent('/technician/5?date=2026-07-28');
  });
});
