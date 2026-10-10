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

  test('waiting on a person points to Pending Response instead', () => {
    const onUse = vi.fn();
    render(<ParkDialog ticketRef="TP-1700" onSubmit={() => {}} onClose={() => {}} onUsePendingResponse={onUse} />);
    expect(screen.getByTestId('park-pending-pointer')).toHaveTextContent(/Waiting on the requester or on another person\? That isn’t a park/);
    fireEvent.click(screen.getByRole('button', { name: 'Use Pending Response' }));
    expect(onUse).toHaveBeenCalled();
  });

  test('the pointer stays as plain text where Pending Response cannot be set from here (FS-born, bulk)', () => {
    render(<ParkDialog bulkCount={2} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('park-pending-pointer')).toHaveTextContent(/Pending Response/);
    expect(screen.queryByRole('button', { name: 'Use Pending Response' })).toBeNull();
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

// QA 10-01 #6: "Waiting until a date" and "In progress, with an ETA" merged.
describe('ParkDialog — one choice for a date or an ETA', () => {
  // QA 10-09 #9: "Waiting on someone" left the dialog — one reason needs no
  // radio group, so the dialog opens straight on the date.
  test('no reason picker and no "waiting on" fields: the dialog opens on the date', () => {
    render(<ParkDialog ticketRef="TP-1741" requesterEmail="rita@x.com" onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByText('Waiting on someone')).toBeNull();
    expect(screen.queryByLabelText(/Waiting on \(name or e-mail\)/)).toBeNull();
    expect(screen.queryByText('In progress, with an ETA')).toBeNull();
    expect(screen.getByLabelText(/Until \/ ETA/)).toHaveFocus();
    expect(screen.getByRole('link', { name: 'Schedule it instead' })).toBeInTheDocument();
  });

  test('an older "waiting on someone" park keeps who it waits on when its date changes', () => {
    const onSubmit = vi.fn();
    const waitingOn = [{ name: 'Alexa' }, { email: 'kirsten@x.com', name: 'kirsten@x.com' }];
    render(<ParkDialog ticketRef="TP-1741" initial={{ kind: 'waiting_on', until: inDays(20), reason: 'List review', waitingOn }} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Until/), { target: { value: inDays(25) } });
    fireEvent.click(screen.getByRole('button', { name: /^Park$/ }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'waiting_on', until: inDays(25), reason: 'List review', waitingOn });
  });

  test('…and still shows as waiting on someone in the queue mark', () => {
    render(<ParkedMark until="2026-11-16T15:00:00Z" kind="waiting_on" />);
    expect(screen.getByTestId('parked-mark')).toHaveAttribute('title', 'Parked — Waiting on someone');
  });

  test('changing the date of an older ETA park opens on the merged choice and saves it as until_date', () => {
    const onSubmit = vi.fn();
    render(<ParkDialog ticketRef="TP-1741" initial={{ kind: 'eta', until: inDays(20), reason: 'Rollout' }} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Until/), { target: { value: inDays(21) } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Rollout moved' } });
    fireEvent.click(screen.getByRole('button', { name: /^Park$/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'until_date', until: inDays(21) }));
  });

  test('an older ETA park still reads as "In progress, with an ETA" on the ticket', () => {
    render(<ParkLine park={{ kind: 'eta', until: new Date(Date.now() + 5 * 86400e3).toISOString(), reason: 'Rollout' }} />);
    expect(screen.getByTestId('park-line')).toHaveTextContent('In progress, with an ETA');
  });
});
