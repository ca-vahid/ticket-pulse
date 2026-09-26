/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
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
