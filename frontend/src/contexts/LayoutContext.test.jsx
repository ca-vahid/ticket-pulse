/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ uiPreferencesAPI: { get: vi.fn(), set: vi.fn() }, getWorkspaceId: vi.fn(() => '1') }));
vi.mock('../services/api', () => apiMock);

import { LayoutProvider, LAYOUT_STORAGE_KEY, applyWidth, pageWidthClass, useLayoutWidth } from './LayoutContext';
import LayoutControl from '../components/nav/LayoutControl';

function Probe() {
  const { width } = useLayoutWidth();
  return <span data-testid="width">{width}</span>;
}

describe('LayoutContext (full-width train)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-layout');
    apiMock.uiPreferencesAPI.get.mockReset().mockResolvedValue({ data: { value: null } });
    apiMock.uiPreferencesAPI.set.mockReset().mockResolvedValue({});
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  test('defaults to full, stamps <html data-layout>, and the control switches + persists (local + server, debounced)', async () => {
    render(<LayoutProvider><Probe /><LayoutControl itemRole="radio" /></LayoutProvider>);
    expect(screen.getByTestId('width')).toHaveTextContent('full');
    expect(document.documentElement.getAttribute('data-layout')).toBe('full');
    fireEvent.click(screen.getByRole('radio', { name: /Classic/ }));
    expect(screen.getByTestId('width')).toHaveTextContent('classic');
    expect(document.documentElement.getAttribute('data-layout')).toBe('classic');
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('classic');
    expect(apiMock.uiPreferencesAPI.set).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(apiMock.uiPreferencesAPI.set).toHaveBeenCalledWith('ui.layoutWidth', 'classic');
  });

  test('a stored local choice wins; with no local choice the server preference seeds it', async () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, 'comfortable');
    apiMock.uiPreferencesAPI.get.mockResolvedValue({ data: { value: 'classic' } });
    const r = render(<LayoutProvider><Probe /></LayoutProvider>);
    expect(screen.getByTestId('width')).toHaveTextContent('comfortable');
    expect(apiMock.uiPreferencesAPI.get).not.toHaveBeenCalled();
    r.unmount();
    localStorage.clear();
    render(<LayoutProvider><Probe /></LayoutProvider>);
    await waitFor(() => expect(screen.getByTestId('width')).toHaveTextContent('classic'));
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('classic');
  });

  test('applyWidth swaps a page cap for the chosen width and keeps the rest of the classes', () => {
    expect(applyWidth('max-w-7xl mx-auto px-4 py-6 animate-fadeIn', 'full')).toBe('w-full max-w-none xl:px-6 2xl:px-8 px-4 py-6 animate-fadeIn');
    expect(applyWidth('max-w-[2200px] mx-auto px-4', 'comfortable')).toBe('w-full max-w-[1600px] mx-auto xl:px-6 px-4');
    expect(applyWidth('max-w-4xl mx-auto px-4', 'classic')).toBe('w-full max-w-7xl mx-auto px-4');
    expect(applyWidth('px-2 py-3', 'full')).toBe('w-full max-w-none xl:px-6 2xl:px-8 px-2 py-3');
    expect(pageWidthClass('full', 'py-3')).toContain('max-w-none');
    expect(pageWidthClass('bogus')).toContain('max-w-none'); // unknown → full
  });
});
