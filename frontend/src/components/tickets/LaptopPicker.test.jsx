/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = {
  assetronStatus: vi.fn(),
  assetronFilterOptions: vi.fn(),
  assetronAssets: vi.fn(),
  requesterSearch: vi.fn(),
};
vi.mock('../../services/api', () => ({ ticketsAPI: new Proxy({}, { get: (_t, k) => (...a) => api[k](...a) }) }));

const { default: LaptopPicker, warrantyLabel } = await import('./LaptopPicker');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const LAPTOP = { id: '4c1e9d2a-1', make: 'Dell', model: 'Latitude 7650', serialNumber: '5CG4XYZ123', cpu: 'Intel Core Ultra 7 165U', ram: '32 GB', storage: '1 TB', screenSize: '16"', location: 'Vancouver', warrantyEndDate: '2029-05-02', touchScreen: false };

describe('LaptopPicker (Assetron)', () => {
  test('not connected → says so, no filters', async () => {
    api.assetronStatus.mockResolvedValue({ data: { configured: false } });
    render(<LaptopPicker recipient={null} onRecipient={() => {}} value={null} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Assetron is not connected yet/)).toBeTruthy());
    expect(api.assetronFilterOptions).not.toHaveBeenCalled();
  });

  test('filters come from filter-options (unknown keys too); search sends raw values; Pick returns the laptop', async () => {
    api.assetronStatus.mockResolvedValue({ data: { configured: true } });
    api.assetronFilterOptions.mockResolvedValue({ data: { ram: ['16 GB', '32 GB'], touchScreen: [true, false], dockType: ['USB-C'] } });
    api.assetronAssets.mockResolvedValue({ data: { items: [LAPTOP] } });
    const onChange = vi.fn();
    render(<LaptopPicker recipient={{ email: 'jsmith@bgc.ca', name: 'Jordan Smith' }} onRecipient={() => {}} value={null} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /RAM/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /Dock Type/ })).toBeTruthy();
    expect(screen.getByText('Jordan Smith')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /RAM/ }));
    fireEvent.click(screen.getByLabelText('32 GB'));
    fireEvent.click(screen.getByRole('button', { name: /Touch Screen|Touch screen/ }));
    fireEvent.click(screen.getByLabelText('No'));
    expect(api.assetronAssets).not.toHaveBeenCalled(); // search only on the button
    fireEvent.click(screen.getByRole('button', { name: /Search new laptops/ }));
    await waitFor(() => expect(api.assetronAssets).toHaveBeenCalledWith({ ram: '32 GB', touchScreen: 'false', pageSize: 50 }));
    await waitFor(() => expect(screen.getByText('Dell Latitude 7650')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Pick/ }));
    expect(onChange).toHaveBeenCalledWith(LAPTOP);
  });

  test('warranty reads as month and year; odd values pass through', () => {
    expect(warrantyLabel('2029-05-02')).toBe('May 2029');
    expect(warrantyLabel(null)).toBe('—');
    expect(warrantyLabel('soon')).toBe('soon');
  });

  test('an empty result says how to fix it', async () => {
    api.assetronStatus.mockResolvedValue({ data: { configured: true } });
    api.assetronFilterOptions.mockResolvedValue({ data: { ram: ['64 GB'] } });
    api.assetronAssets.mockResolvedValue({ data: { items: [] } });
    render(<LaptopPicker recipient={null} onRecipient={() => {}} value={null} onChange={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /Search new laptops/ }));
    fireEvent.click(screen.getByRole('button', { name: /Search new laptops/ }));
    await waitFor(() => expect(screen.getByText(/No new laptop matches/)).toBeTruthy());
  });
});
