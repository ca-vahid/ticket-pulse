/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TechCard from './TechCard';

vi.mock('../hooks/usePrefetch', () => ({ prefetchTechDetail: vi.fn() }));

afterEach(cleanup);

/**
 * Mobile TechCard rework (QA 08-08: "the icons are gigantic"): below `sm` the
 * card renders a compact summary band + inline six-stat strip instead of the
 * desktop icon tiles. Desktop keeps the original presentation (scoped with
 * hidden sm:* classes). jsdom has no CSS engine, so these tests assert the
 * responsive markup contract: both presentations exist, correctly scoped.
 */

const technician = {
  id: 42,
  name: 'Avery Chen',
  email: 'avery@example.com',
  photoUrl: null,
  totalTicketsToday: 7,
  selfPicked: 0,
  selfPickedToday: 2,
  appAssignedToday: 1,
  assignedToday: 3,
  closedToday: 4,
  rejectedThisPeriod: 1,
  rejected7d: 1,
  rejected30d: 2,
  rejectedLifetime: 5,
  csatCount: 2,
  csatAverage: 3.6, // FS /4 scale -> 4.5 on the /5 display scale
  openOnlyCount: 6,
  pendingCount: 2,
  openTicketCount: 8,
};

const quietTechnician = {
  ...technician,
  id: 43,
  totalTicketsToday: 0,
  selfPickedToday: 0,
  appAssignedToday: 0,
  assignedToday: 0,
  closedToday: 0,
  rejectedThisPeriod: 0,
  csatCount: 0,
  csatAverage: null,
  openOnlyCount: 0,
  pendingCount: 0,
};

function renderCard(tech = technician, props = {}) {
  return render(
    <MemoryRouter>
      <TechCard technician={tech} viewMode="daily" {...props} />
    </MemoryRouter>,
  );
}

describe('TechCard — mobile stat presentation (detailed style)', () => {
  test('renders the mobile summary band (open now + new today), scoped to <sm', () => {
    const { container } = renderCard();
    const mobileBlock = container.querySelector('.sm\\:hidden');
    expect(mobileBlock).toBeTruthy();
    expect(within(mobileBlock).getByText(/open now \+2 pend/)).toBeInTheDocument();
    expect(within(mobileBlock).getByText('new today')).toBeInTheDocument();
    expect(within(mobileBlock).getByText('6')).toBeInTheDocument(); // open now
    expect(within(mobileBlock).getByText('7')).toBeInTheDocument(); // total today
  });

  test('renders the six-stat strip with compact labels and values', () => {
    const { container } = renderCard();
    const mobileBlock = within(container.querySelector('.sm\\:hidden'));
    for (const label of ['Self', 'App', 'Coord', 'Done', 'Rej']) {
      expect(mobileBlock.getByText(label)).toBeInTheDocument();
    }
    // CSAT label carries the response count inline (tooltips don't exist on touch)
    expect(mobileBlock.getByText('CSAT (2)')).toBeInTheDocument();
    expect(mobileBlock.getByText('4.5')).toBeInTheDocument(); // 3.6 x 1.25
  });

  test('rejected stat is a tappable drilldown button with a >=44px hit box', () => {
    const { container } = renderCard();
    const mobileBlock = within(container.querySelector('.sm\\:hidden'));
    const rejButton = mobileBlock.getByTitle(/Rejected tickets/);
    expect(rejButton.tagName).toBe('BUTTON');
    expect(rejButton.className).toContain('min-h-[44px]');
  });

  test('zero-value stats render muted, not colored (calm quiet-day cards)', () => {
    const { container } = renderCard(quietTechnician);
    const mobileBlock = container.querySelector('.sm\\:hidden');
    // All six values are zero/none -> every value in the strip is slate-300
    const mutedValues = mobileBlock.querySelectorAll('.text-slate-300');
    expect(mutedValues.length).toBeGreaterThanOrEqual(6);
    // And no rejected button when there is nothing to drill into
    expect(within(mobileBlock).queryByRole('button')).toBeNull();
  });

  test('desktop presentation is still in the DOM, scoped to sm+', () => {
    const { container } = renderCard();
    // Big Open block
    const openBlock = container.querySelector('.hidden.sm\\:block');
    expect(openBlock).toBeTruthy();
    expect(within(openBlock).getByText('Open')).toBeInTheDocument();
    // Icon-tile metrics grid
    const tileGrid = container.querySelector('.hidden.sm\\:grid');
    expect(tileGrid).toBeTruthy();
    expect(within(tileGrid).getByText('Self')).toBeInTheDocument();
  });
});

describe('TechCard — mobile stat presentation (simple style)', () => {
  test('adds a mobile-only open-now segment to the total band', () => {
    renderCard(technician, { simple: true });
    const openNow = screen.getByTitle(/open tickets? right now/);
    expect(openNow.className).toContain('sm:hidden');
    expect(within(openNow).getByText('6')).toBeInTheDocument();
    expect(within(openNow).getByText(/open now \+2 pend/)).toBeInTheDocument();
  });

  test('keeps plain-language stat labels and surfaces CSAT N inline on mobile', () => {
    renderCard(technician, { simple: true });
    expect(screen.getByText('Picked up themselves')).toBeInTheDocument();
    expect(screen.getByText('Sent by the app')).toBeInTheDocument();
    expect(screen.getByText('Sent by a coordinator')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    // "(2)" response count is mobile-only so desktop Cards view is unchanged
    const csatLabel = screen.getByText(/CSAT score/);
    const countSpan = within(csatLabel).getByText('(2)');
    expect(countSpan.className).toContain('sm:hidden');
  });

  test('simple style shows no icon tiles at any width', () => {
    const { container } = renderCard(technician, { simple: true });
    expect(container.querySelector('.hidden.sm\\:grid')).toBeNull();
    expect(screen.queryByText('Coord')).toBeNull();
  });
});
