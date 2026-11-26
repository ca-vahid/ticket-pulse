/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FileText, Lightbulb } from 'lucide-react';
import LightTabBar, { tabAccessibleName } from './LightTabBar';

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
  let calls;
  beforeEach(() => {
    calls = [];
    window.HTMLElement.prototype.scrollIntoView = vi.fn(function scrollIntoView(opts) { calls.push({ id: this.id, opts }); });
    delete document.documentElement.dataset.motion;
  });
  afterEach(() => { delete window.HTMLElement.prototype.scrollIntoView; delete document.documentElement.dataset.motion; });

  test('on open at once, on change smoothly; never smooth when motion is reduced', () => {
    const { rerender } = render(<LightTabBar tabs={TABS} activeId="my-time" onSelect={() => {}} ariaLabel="Sections" idPrefix="av" />);
    expect(calls).toEqual([{ id: 'av-tab-my-time', opts: { inline: 'nearest', block: 'nearest', behavior: 'auto' } }]);
    rerender(<LightTabBar tabs={TABS} activeId="calendar" onSelect={() => {}} ariaLabel="Sections" idPrefix="av" />);
    expect(calls.at(-1)).toEqual({ id: 'av-tab-calendar', opts: { inline: 'nearest', block: 'nearest', behavior: 'smooth' } });
    document.documentElement.dataset.motion = 'reduce';
    rerender(<LightTabBar tabs={TABS} activeId="overview" onSelect={() => {}} ariaLabel="Sections" idPrefix="av" />);
    expect(calls.at(-1)).toEqual({ id: 'av-tab-overview', opts: { inline: 'nearest', block: 'nearest', behavior: 'auto' } });
  });
});
