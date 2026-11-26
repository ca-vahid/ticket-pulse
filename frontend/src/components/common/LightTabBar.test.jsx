/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FileText, Lightbulb } from 'lucide-react';
import LightTabBar, { tabAccessibleName, tabScrollLeft } from './LightTabBar';

afterEach(cleanup);

describe('LightTabBar badge (audit, 26 Sep 2026)', () => {
  test('the count is part of the tab accessible name; the visual badge is hidden from the reader', () => {
    render(
      <LightTabBar
        tabs={[{ id: 'articles', label: 'Articles', icon: FileText }, { id: 'gaps', label: 'Gaps', icon: Lightbulb, badge: 3 }]}
        activeId="articles"
        onSelect={() => {}}
        ariaLabel="Knowledge sections"
      />,
    );
    expect(screen.getByRole('tab', { name: 'Gaps, 3 new' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Articles' })).toBeInTheDocument();
    expect(screen.getByText('3')).toHaveAttribute('aria-hidden', 'true');
  });

  test('tabAccessibleName: no badge / zero gives the label; badgeLabel replaces "new"', () => {
    expect(tabAccessibleName({ label: 'Waiting' })).toBe('Waiting');
    expect(tabAccessibleName({ label: 'Waiting', badge: 0 })).toBe('Waiting');
    expect(tabAccessibleName({ label: 'Waiting', badge: 2, badgeLabel: 'waiting' })).toBe('Waiting, 2 waiting');
  });
});

// QA 11-25: on a phone the row scrolls sideways; the selected tab is brought into view.
describe('LightTabBar keeps the selected tab in view', () => {
  const TABS = [
    { id: 'overview', label: 'Overview', icon: FileText },
    { id: 'calendar', label: 'Wallchart', icon: FileText },
    { id: 'my-time', label: 'My time', icon: Lightbulb },
  ];
  // A 300 px row scrolled to 0; the tabs sit at 0–120, 120–240 and 240–360 (the last one cut off).
  const BOX = { overview: [0, 120], calendar: [120, 240], 'my-time': [240, 360] };
  let calls;
  let rect;
  beforeEach(() => {
    calls = [];
    delete document.documentElement.dataset.motion;
    rect = vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function box() {
      if (this.getAttribute('role') === 'tablist') return { left: 0, right: 300, top: 0, bottom: 44 };
      const id = String(this.id).replace('av-tab-', '');
      const [l, r] = BOX[id] || [0, 0];
      return { left: l, right: r, top: 0, bottom: 44 };
    });
    window.HTMLElement.prototype.scrollTo = vi.fn(function scrollTo(opts) { calls.push(opts); });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    rect.mockRestore();
    delete window.HTMLElement.prototype.scrollTo;
    delete window.HTMLElement.prototype.scrollIntoView;
    delete document.documentElement.dataset.motion;
  });

  test('tabScrollLeft: the tab\'s start less the snap padding (a snap point), only when the tab is not fully visible', () => {
    // A stubbed 300 px row scrolled 100 px, with 16 px scroll-padding.
    const row = { scrollLeft: 100, clientLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 300 }) };
    const tab = (l, r) => ({ getBoundingClientRect: () => ({ left: l, right: r }) });
    expect(tabScrollLeft(row, tab(20, 140), 16)).toBeNull(); // fully visible
    expect(tabScrollLeft(row, tab(0, 120), 16)).toBeNull(); // flush with the edge, still visible
    expect(tabScrollLeft(row, tab(250, 370), 16)).toBe(334); // cut off on the right: 100 + 250 − 16
    expect(tabScrollLeft(row, tab(-60, 60), 16)).toBe(24); // cut off on the left: 100 − 60 − 16
    expect(tabScrollLeft(row, tab(-120, -10), 16)).toBe(0); // never below 0
  });

  test('only the row scrolls sideways: at once on open, smoothly on change, never smoothly when motion is reduced', () => {
    const { rerender } = render(<LightTabBar tabs={TABS} activeId="my-time" onSelect={() => {}} ariaLabel="Sections" idPrefix="av" />);
    // My time starts at 240 in a row scrolled to 0 (jsdom gives no scroll-padding): its snap start.
    expect(calls).toEqual([{ left: 240, behavior: 'auto' }]);
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    BOX.calendar = [-40, 80]; // the row has moved: Wallchart is now cut off on the left
    rerender(<LightTabBar tabs={TABS} activeId="calendar" onSelect={() => {}} ariaLabel="Sections" idPrefix="av" />);
    expect(calls.at(-1)).toEqual({ left: 0, behavior: 'smooth' });
    document.documentElement.dataset.motion = 'reduce';
    rerender(<LightTabBar tabs={TABS} activeId="my-time" onSelect={() => {}} ariaLabel="Sections" idPrefix="av" />);
    expect(calls.at(-1)).toEqual({ left: 240, behavior: 'auto' });
    // A tab already in view: nothing moves.
    const before = calls.length;
    BOX.overview = [10, 120];
    rerender(<LightTabBar tabs={TABS} activeId="overview" onSelect={() => {}} ariaLabel="Sections" idPrefix="av" />);
    expect(calls).toHaveLength(before);
  });
});
