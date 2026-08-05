/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TechCardCompact from './TechCardCompact';
import { getDateStyling, isDateToday } from '../utils/holidays';

vi.mock('../hooks/usePrefetch', () => ({ prefetchTechDetail: vi.fn() }));

afterEach(cleanup);

const fmtLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** 7 consecutive days with today in the middle (index 3). */
function weekAroundToday() {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + (i - 3));
    return { date: fmtLocal(d), total: i, self: 0, assigned: i, closed: 0 };
  });
}

const technician = {
  id: 7,
  name: 'Avery Chen',
  email: 'avery@example.com',
  photoUrl: null,
  dailyBreakdown: weekAroundToday(),
  weeklyTotalCreated: 9,
  weeklySelfPicked: 1,
  weeklyAppAssigned: 4,
  weeklyAssigned: 4,
  weeklyClosed: 3,
};

function renderCard(extraProps = {}) {
  return render(
    <MemoryRouter>
      <TechCardCompact technician={technician} viewMode="weekly" {...extraProps} />
    </MemoryRouter>,
  );
}

describe('isDateToday / getDateStyling.isToday', () => {
  test('today is flagged, other days are not', () => {
    expect(isDateToday(new Date())).toBe(true);
    expect(isDateToday('2000-01-01')).toBe(false);
    expect(getDateStyling(new Date(), { variant: 'box' }).isToday).toBe(true);
    expect(getDateStyling('2000-01-01', { variant: 'box' }).isToday).toBe(false);
  });
});

describe('TechCardCompact — today tile ring (weekly heatmap)', () => {
  test.each([
    ['normal view', {}],
    ['simple view', { simple: true, topLoad: true }],
  ])('%s: exactly today\'s tile gets the violet ring', (_label, props) => {
    const { container } = renderCard(props);
    const ringed = container.querySelectorAll('.ring-violet-500');
    expect(ringed).toHaveLength(1);
    expect(ringed[0].className).toContain('ring-2');
    expect(ringed[0].className).toContain('ring-offset-1');
    // The ringed tile lives inside the tile whose tooltip is marked "Today".
    const todayTile = ringed[0].closest('[title]');
    expect(todayTile?.getAttribute('title')).toMatch(/^Today\n/);
  });

  test('simple view renders the caption as a status pill', () => {
    renderCard({ simple: true, topLoad: true });
    const pill = screen.getByText('Heaviest load on the team');
    expect(pill).toHaveClass('rounded-full', 'border', 'bg-violet-50');
  });

  test('normal view has no caption pill', () => {
    renderCard();
    expect(screen.queryByText('Heaviest load on the team')).not.toBeInTheDocument();
    expect(screen.queryByText('Steady week')).not.toBeInTheDocument();
  });
});
