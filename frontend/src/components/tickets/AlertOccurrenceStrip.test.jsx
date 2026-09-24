/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const externalReferences = vi.fn();
vi.mock('../../services/api', () => ({ ticketsAPI: { externalReferences: (...a) => externalReferences(...a) } }));

const { default: AlertOccurrenceStrip } = await import('./AlertOccurrenceStrip');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AlertOccurrenceStrip (Sentinel monitoring alerts)', () => {
  test('renders nothing for an ordinary ticket and fetches nothing', () => {
    const { container } = render(<AlertOccurrenceStrip ticket={{ id: 1, occurrenceCount: 0 }} />);
    expect(container.innerHTML).toBe('');
    expect(externalReferences).not.toHaveBeenCalled();
  });

  test('shows the count and each Sentinel incident once, linked', async () => {
    externalReferences.mockResolvedValue({ data: [
      { system: 'sentinel', incidentId: 'a', incidentNumber: '48213', url: 'https://portal.azure.com/#a', time: new Date().toISOString() },
      { system: 'sentinel', incidentId: 'a', incidentNumber: '48213', url: 'https://portal.azure.com/#a' },
      { system: 'sentinel', incidentId: 'b', incidentNumber: '48260', url: null },
    ] });
    render(<AlertOccurrenceStrip ticket={{ id: 7, occurrenceCount: 29, lastOccurrenceAt: new Date().toISOString() }} />);
    expect(screen.getByText('Alert fired 29 times')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('link', { name: /Sentinel incident #48213/ })).toBeTruthy());
    expect(screen.getAllByText(/Sentinel incident #48213/)).toHaveLength(1);
    expect(screen.getByText(/Sentinel incident #48260/)).toBeTruthy();
    expect(externalReferences).toHaveBeenCalledWith(7);
  });

  test('long lists collapse to five with a "Show all" toggle', async () => {
    externalReferences.mockResolvedValue({ data: Array.from({ length: 8 }, (_, i) => ({ system: 'sentinel', incidentId: `i${i}`, incidentNumber: String(100 + i) })) });
    render(<AlertOccurrenceStrip ticket={{ id: 8, occurrenceCount: 8 }} />);
    await waitFor(() => expect(screen.getByText('Show all 8')).toBeTruthy());
    expect(screen.queryByText(/#107/)).toBeNull();
    fireEvent.click(screen.getByText('Show all 8'));
    expect(screen.getByText(/#107/)).toBeTruthy();
  });
});
