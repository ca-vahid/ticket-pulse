/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ParkDialog, { ParkLine, ParkSuggestion, ParkedMark } from './ParkControls';

// Parked (plans/PARKED_BUILD_PLAN.md): the dialog, the line under the
// subject, the HR suggestion and the queue mark.
afterEach(cleanup);

const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

describe('ParkDialog', () => {
  test('a date and a reason are required; Park sends kind, date and reason', () => {
    const onSubmit = vi.fn();
    render(<ParkDialog ticketRef="TP-1700" onSubmit={onSubmit} onClose={() => {}} />);
    const park = screen.getByRole('button', { name: /^Park$/ });
    expect(park).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Until/), { target: { value: inDays(12) } });
    expect(park).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Transfer effective Oct 5' } });
    expect(park).toBeEnabled();
    fireEvent.click(park);
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'until_date', until: inDays(12), reason: 'Transfer effective Oct 5' });
  });

  test('more than six months out cannot be saved', () => {
    render(<ParkDialog ticketRef="TP-1700" onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Until/), { target: { value: inDays(200) } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: /^Park$/ })).toBeDisabled();
  });

  test('waiting on the requester points to Pending Response instead', () => {
    const onUse = vi.fn();
    render(<ParkDialog ticketRef="TP-1700" requesterEmail="rita@x.com" onSubmit={() => {}} onClose={() => {}} onUsePendingResponse={onUse} />);
    fireEvent.click(screen.getByLabelText(/Waiting on someone/));
    fireEvent.change(screen.getByLabelText(/Waiting on \(name or e-mail\)/), { target: { value: 'Rita@x.com' } });
    fireEvent.change(screen.getByLabelText(/Chase on/), { target: { value: inDays(5) } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Needs her answer' } });
    expect(screen.getByText(/isn’t a park/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Park$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use Pending Response' }));
    expect(onUse).toHaveBeenCalled();
  });

  test('bulk title counts the selection', () => {
    render(<ParkDialog bulkCount={3} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Park 3 tickets')).toBeInTheDocument();
  });
});

describe('ParkLine / ParkSuggestion / ParkedMark', () => {
  test('the line says until when, why and who, with Change date and Unpark', () => {
    const onUnpark = vi.fn();
    render(<ParkLine park={{ kind: 'waiting_on', until: '2026-10-05T15:00:00Z', reason: 'List review', parkedBy: 'Anton', waitingOn: [{ name: 'Alexa' }, { name: 'Kirsten' }] }} onExtend={() => {}} onUnpark={onUnpark} />);
    expect(screen.getByTestId('park-line')).toHaveTextContent(/Parked until Oct 5/);
    expect(screen.getByTestId('park-line')).toHaveTextContent(/Waiting on someone — Alexa, Kirsten/);
    expect(screen.getByTestId('park-line')).toHaveTextContent(/by Anton/);
    fireEvent.click(screen.getByRole('button', { name: 'Unpark' }));
    expect(onUnpark).toHaveBeenCalled();
  });

  test('the HR suggestion only shows when the date is usable', () => {
    const { rerender } = render(<ParkSuggestion suggestion={{ usable: false, reason: 'x', until: '2026-10-05T15:00:00Z' }} onUse={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByTestId('park-suggestion')).toBeNull();
    rerender(<ParkSuggestion suggestion={{ usable: true, reason: 'Transfer effective Oct 5 (from the HR notice)', until: '2026-10-05T15:00:00Z' }} onUse={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId('park-suggestion')).toHaveTextContent(/Transfer effective Oct 5/);
  });

  test('queue mark shows the wake date', () => {
    render(<ParkedMark until="2026-11-16T15:00:00Z" kind="until_date" />);
    expect(screen.getByTestId('parked-mark')).toHaveTextContent(/Nov 16/);
  });
});
