/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = {
  assetronStatus: vi.fn(),
  assetronDevices: vi.fn(),
  requesterSearch: vi.fn(),
};
vi.mock('../../services/api', () => ({ ticketsAPI: new Proxy({}, { get: (_t, k) => (...a) => api[k](...a) }) }));

const { default: LaptopPicker, warrantyLabel } = await import('./LaptopPicker');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// Approval redesign D1 + E1 (29 Sep 2026): one load, filters with counts, sortable paged table.
const dev = (i, over = {}) => ({
  id: `d${i}`, make: 'Dell', model: 'Pro 14', serialNumber: `SN${String(i).padStart(3, '0')}`, cpu: 'Intel Core Ultra 5 235U',
  ram: '16 GB', storage: '512 GB', gpu: 'Intel Graphics', screenSize: '14"', touchScreen: false, location: 'Vancouver', warrantyEndDate: '2029-05-02', ...over,
});
const STOCK = [
  ...Array.from({ length: 30 }, (_, i) => dev(i + 1)),
  dev(31, { model: 'Pro 16', ram: '64 GB', storage: '2 TB', gpu: 'RTX 4070', screenSize: '16"', touchScreen: true, location: 'Calgary' }),
  dev(32, { model: 'Pro 16', ram: '32 GB', storage: '1 TB', location: 'Calgary' }),
];
const load = (items = STOCK) => {
  api.assetronStatus.mockResolvedValue({ data: { configured: true } });
  api.assetronDevices.mockResolvedValue({ data: { items, total: items.length, truncated: false } });
};
const renderPicker = (props = {}) => render(<LaptopPicker recipient={{ email: 'jsmith@bgc.ca', name: 'Jordan Smith' }} onRecipient={() => {}} value={null} onChange={() => {}} {...props} />);

describe('Assetron device finder', () => {
  test('not connected → says so and loads nothing', async () => {
    api.assetronStatus.mockResolvedValue({ data: { configured: false } });
    renderPicker();
    await waitFor(() => expect(screen.getByText(/Assetron is not connected yet/)).toBeTruthy());
    expect(api.assetronDevices).not.toHaveBeenCalled();
  });

  test('loads once, reports the count, and pages 25 at a time', async () => {
    load();
    const onLoaded = vi.fn();
    renderPicker({ onLoaded });
    await waitFor(() => expect(screen.getByTestId('device-count')).toHaveTextContent('32 of 32 new devices'));
    expect(onLoaded).toHaveBeenCalledWith(32);
    expect(screen.getByTestId('device-pager')).toHaveTextContent('Showing 1–25 of 32');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('device-pager')).toHaveTextContent('Showing 26–32 of 32');
    expect(api.assetronDevices).toHaveBeenCalledTimes(1);
  });

  test('filter values show counts; ticking one narrows the table and the other counts', async () => {
    load();
    renderPicker();
    const filters = await screen.findByRole('group', { name: 'Filters' });
    const calgary = within(filters).getByRole('checkbox', { name: /Calgary/ });
    expect(calgary.closest('label')).toHaveTextContent('Calgary2');
    fireEvent.click(calgary);
    expect(screen.getByTestId('device-count')).toHaveTextContent('2 of 32');
    expect(within(filters).getByRole('checkbox', { name: /64 GB/ }).closest('label')).toHaveTextContent('64 GB1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Office: Calgary' }));
    expect(screen.getByTestId('device-count')).toHaveTextContent('32 of 32');
  });

  test('search, touch filter and sorting by RAM as a size', async () => {
    load();
    renderPicker();
    await screen.findByTestId('device-count');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search devices' }), { target: { value: 'pro 16' } });
    expect(screen.getByTestId('device-count')).toHaveTextContent('2 of 32');
    fireEvent.click(screen.getByRole('radio', { name: 'Touch' }));
    expect(screen.getByTestId('device-count')).toHaveTextContent('1 of 32');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    fireEvent.click(screen.getByRole('button', { name: /^RAM/ }));
    fireEvent.click(screen.getByRole('button', { name: /^RAM/ }));
    const firstRow = screen.getAllByRole('row')[1];
    expect(firstRow).toHaveTextContent('64 GB');
  });

  test('clicking a row picks the device', async () => {
    load();
    const onChange = vi.fn();
    renderPicker({ onChange });
    await screen.findByTestId('device-count');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: /Choose Dell Pro 16 SN031/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'd31' }));
  });

  test('no new devices: says so', async () => {
    load([]);
    renderPicker();
    await waitFor(() => expect(screen.getByTestId('laptop-no-stock')).toBeTruthy());
    expect(screen.queryByRole('table')).toBeNull();
  });

  test('warranty reads as month and year; odd values pass through', () => {
    expect(warrantyLabel('2029-05-02')).toBe('May 2029');
    expect(warrantyLabel(null)).toBe('—');
    expect(warrantyLabel('soon')).toBe('soon');
  });
});
