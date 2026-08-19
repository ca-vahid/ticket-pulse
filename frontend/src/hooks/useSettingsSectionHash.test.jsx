/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import useSettingsSectionHash from './useSettingsSectionHash';

/**
 * QA 08-17 #3 (banner half): /settings#section deep links must work from
 * INSIDE Settings. The old code read the hash once in a useState initializer
 * and wrote clicks via history.replaceState — a banner link clicked while
 * already on /settings changed the URL but never the rendered section.
 */
function SettingsHarness() {
  const [activeSection, setActiveSection] = useSettingsSectionHash();
  const location = useLocation();
  return (
    <div>
      <div data-testid="active-section">{activeSection ?? 'none'}</div>
      <div data-testid="location-hash">{location.hash}</div>
      <button type="button" onClick={() => setActiveSection('sync')}>Go to Sync</button>
      {/* Banner-style deep link: same pathname, different hash. */}
      <Link to="/settings#notification-providers">View sync freshness</Link>
    </div>
  );
}

function renderAt(initialEntry) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/settings" element={<SettingsHarness />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useSettingsSectionHash', () => {
  afterEach(() => cleanup());

  test('initializes from the URL hash on mount (deep link from another page)', () => {
    renderAt('/settings#notification-providers');
    expect(screen.getByTestId('active-section')).toHaveTextContent('notification-providers');
  });

  test('no hash → null request (caller falls back to the first visible section)', () => {
    renderAt('/settings');
    expect(screen.getByTestId('active-section')).toHaveTextContent('none');
  });

  test('a banner deep link clicked while ALREADY on /settings switches the section', () => {
    renderAt('/settings#sync');
    expect(screen.getByTestId('active-section')).toHaveTextContent('sync');

    fireEvent.click(screen.getByRole('link', { name: 'View sync freshness' }));

    expect(screen.getByTestId('active-section')).toHaveTextContent('notification-providers');
    expect(screen.getByTestId('location-hash')).toHaveTextContent('#notification-providers');
  });

  test('nav clicks route through the router, so location.hash stays in sync', () => {
    renderAt('/settings#notification-providers');

    fireEvent.click(screen.getByRole('button', { name: 'Go to Sync' }));

    expect(screen.getByTestId('active-section')).toHaveTextContent('sync');
    expect(screen.getByTestId('location-hash')).toHaveTextContent('#sync');
  });
});
