/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FancySelect from './FancySelect';

afterEach(cleanup);

const OPTIONS = [
  { value: 'Open', label: 'Open', dot: 'bg-blue-500' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Resolved', label: 'Resolved', disabled: true },
  { value: 'int:4', label: 'Service Desk', group: 'Internal groups' },
];

describe('FancySelect (16 Sep 2026)', () => {
  test('shows the current label, opens an animated listbox and reports the picked value as a string', () => {
    const onChange = vi.fn();
    render(<FancySelect value="Open" onChange={onChange} options={OPTIONS} aria-label="Ticket status" />);
    const btn = screen.getByRole('combobox', { name: 'Ticket status' });
    expect(btn).toHaveTextContent('Open');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(btn);
    const list = screen.getByRole('listbox', { name: 'Ticket status' });
    expect(list.className).toMatch(/animate-popIn/);
    expect(screen.getByText('Internal groups')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Pending' }));
    expect(onChange).toHaveBeenCalledWith('Pending');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('keyboard: ArrowDown opens, arrows skip disabled rows, Enter picks, Escape closes', () => {
    const onChange = vi.fn();
    render(<FancySelect value="Open" onChange={onChange} options={OPTIONS} aria-label="Ticket status" />);
    const btn = screen.getByRole('combobox', { name: 'Ticket status' });
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: 'ArrowDown' }); // Open → Pending
    fireEvent.keyDown(btn, { key: 'ArrowDown' }); // skips Resolved (disabled) → Service Desk
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('int:4');
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('disabled never opens; picking the current value is a no-op', () => {
    const onChange = vi.fn();
    const { rerender } = render(<FancySelect value="Open" onChange={onChange} options={OPTIONS} aria-label="S" disabled />);
    fireEvent.click(screen.getByRole('combobox', { name: 'S' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    rerender(<FancySelect value="Open" onChange={onChange} options={OPTIONS} aria-label="S" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'S' }));
    fireEvent.click(screen.getByRole('option', { name: 'Open' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('menu is at least trigger-wide, grows to fit long labels and stays inside the viewport (QA 09-28)', () => {
    const long = [{ value: '', label: 'All categories' }, { value: 's1', label: 'Service Desk & Routing → Non-actionable Notifications', group: 'Subcategories' }];
    const onChange = vi.fn();
    render(<FancySelect value="" onChange={onChange} options={long} aria-label="Article category" />);
    const btn = screen.getByRole('combobox', { name: 'Article category' });
    btn.getBoundingClientRect = () => ({ left: 900, right: 1124, top: 100, bottom: 140, width: 224, height: 40 });
    const prevW = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    fireEvent.click(btn);
    const list = screen.getByRole('listbox');
    expect(list.style.minWidth).toBe('224px');
    expect(list.style.width).toBe('max-content');
    expect(list.style.maxWidth).toBe('372px'); // 1280 - 900 - 8, under the 440 px cap
    const opt = screen.getByRole('option', { name: /Non-actionable Notifications/ });
    expect(opt.querySelector('span[title]')).toHaveAttribute('title', 'Service Desk & Routing → Non-actionable Notifications');
    // type-ahead still works on the wider menu
    fireEvent.keyDown(btn, { key: 's' });
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('s1');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: prevW });
  });

  test('menu never shrinks below the trigger even when the viewport is tight', () => {
    render(<FancySelect value="Open" onChange={() => {}} options={OPTIONS} aria-label="S" />);
    const btn = screen.getByRole('combobox', { name: 'S' });
    btn.getBoundingClientRect = () => ({ left: 300, right: 700, top: 100, bottom: 140, width: 400, height: 40 });
    const prevW = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
    fireEvent.click(btn);
    expect(screen.getByRole('listbox').style.maxWidth).toBe('400px');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: prevW });
  });
});

// 7 Oct 2026: in the Availability settings drawer (layer 80) the list opened
// at layer 60, behind the drawer — "nothing drops down". The list must sit
// above every drawer and dialog in the app.
describe('FancySelect inside a drawer', () => {
  test('its list is layered above the drawer it is opened from', async () => {
    const { Drawer } = await import('../availability/admin/adminUi');
    render(
      <Drawer open title="Edit Vacation" onClose={() => {}} onSave={() => {}}>
        <FancySelect value="day" onChange={() => {}} options={[{ value: 'day', label: 'Days' }, { value: 'hour', label: 'Hours' }]} aria-label="Booked in" />
      </Drawer>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Booked in' }));
    const layer = (el) => Number((el.className.match(/z-\[(\d+)\]/) || [])[1] || 0);
    const list = screen.getByRole('listbox', { name: 'Booked in' });
    const drawer = screen.getByRole('dialog').parentElement;
    expect(layer(drawer)).toBeGreaterThan(0);
    expect(layer(list)).toBeGreaterThan(layer(drawer));
    expect(screen.getByRole('option', { name: 'Hours' })).toBeInTheDocument();
  });
});
