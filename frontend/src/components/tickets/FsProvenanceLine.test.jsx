/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FsProvenanceLine, { adoptedDateLabel } from './FsProvenanceLine';
import { MirrorBadge, MirrorChip, freshserviceEnabledFrom, isImportedTicket, ticketFsUrl } from './ticketUi';
import { canDragTicket } from './TicketBoard';

// FreshService switch (25 Nov 2026): the imported / adopted line and the
// helpers every ticket surface gates on.

const FS_BORN = { id: 7, origin: 'freshservice', freshserviceTicketId: '239470', mirrorState: null, status: 'Closed' };
const ADOPTED = {
  id: 8, origin: 'ticketpulse', nativeNumber: 1500, freshserviceTicketId: '245123', mirrorState: 'adopted', status: 'Open',
  activities: [{ activityType: 'adopted_from_freshservice', performedAt: '2026-12-02T18:00:00.000Z' }],
};
const MIRRORED = { id: 9, origin: 'ticketpulse', nativeNumber: 1501, freshserviceTicketId: '245200', mirrorState: 'mirrored', status: 'Open' };

afterEach(() => cleanup());

describe('helpers', () => {
  test('the meta flag defaults to on for an old cached meta', () => {
    expect(freshserviceEnabledFrom(undefined)).toBe(true);
    expect(freshserviceEnabledFrom({})).toBe(true);
    expect(freshserviceEnabledFrom({ freshserviceEnabled: false })).toBe(false);
  });

  test('imported = FreshService-born while FreshService is off', () => {
    expect(isImportedTicket(FS_BORN, false)).toBe(true);
    expect(isImportedTicket(FS_BORN, true)).toBe(false);
    expect(isImportedTicket(ADOPTED, false)).toBe(false);
    expect(isImportedTicket(MIRRORED, false)).toBe(false);
  });

  test('no FreshService link while off; connected unchanged', () => {
    expect(ticketFsUrl(FS_BORN)).toMatch(/\/a\/tickets\/239470$/);
    expect(ticketFsUrl(FS_BORN, { fsEnabled: false })).toBeNull();
  });

  test('no mirror marker for an adopted ticket or while off; mirrored unchanged when connected', () => {
    const { container, rerender } = render(<MirrorChip ticket={ADOPTED} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<MirrorChip ticket={MIRRORED} fsEnabled={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<MirrorBadge ticket={ADOPTED} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<MirrorChip ticket={MIRRORED} />);
    expect(container).toHaveTextContent('Mirrored');
  });

  test('board: FreshService-born cards are not draggable while off', () => {
    expect(canDragTicket(FS_BORN, true)).toBe(true);
    expect(canDragTicket(FS_BORN, true, false)).toBe(false);
    expect(canDragTicket(ADOPTED, true, false)).toBe(true);
  });

  test('adoption date in Pacific, with the year only when it is not this year', () => {
    expect(adoptedDateLabel('2026-12-02T18:00:00.000Z', new Date('2026-12-10T00:00:00Z'))).toBe('2 Dec');
    expect(adoptedDateLabel('2026-12-02T18:00:00.000Z', new Date('2027-01-10T00:00:00Z'))).toBe('2 Dec 2026');
  });
});

describe('FsProvenanceLine', () => {
  test('connected FreshService-born: nothing', () => {
    const { container } = render(<FsProvenanceLine ticket={FS_BORN} fsEnabled />);
    expect(container).toBeEmptyDOMElement();
  });

  test('imported: one quiet line; Adopt to edit asks once, then adopts', async () => {
    const onAdopt = vi.fn(() => Promise.resolve());
    render(<FsProvenanceLine ticket={FS_BORN} fsEnabled={false} canAdopt onAdopt={onAdopt} />);
    expect(screen.getByTestId('fs-imported-line')).toHaveTextContent('Imported from FreshService #239470 · read-only');
    fireEvent.click(screen.getByRole('button', { name: 'Adopt to edit' }));
    expect(screen.getByText(/fully editable here\. FreshService’s copy is no longer updated\./)).toBeInTheDocument();
    expect(onAdopt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    await waitFor(() => expect(onAdopt).toHaveBeenCalledTimes(1));
  });

  test('imported without the right to adopt: the line only', () => {
    render(<FsProvenanceLine ticket={FS_BORN} fsEnabled={false} canAdopt={false} onAdopt={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Adopt to edit' })).not.toBeInTheDocument();
  });

  test('adopted while FreshService exists: a link to the old ticket', () => {
    render(<FsProvenanceLine ticket={ADOPTED} fsEnabled />);
    const link = screen.getByRole('link', { name: /Adopted from FreshService #245123 on 2 Dec/ });
    expect(link).toHaveAttribute('href', expect.stringMatching(/\/a\/tickets\/245123$/));
  });

  test('adopted while Off: plain text, never a dead link', () => {
    render(<FsProvenanceLine ticket={ADOPTED} fsEnabled={false} />);
    expect(screen.getByTestId('fs-adopted-line')).toHaveTextContent('Adopted from FreshService #245123 on 2 Dec');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('adopted with no activity loaded: the line without a date', () => {
    render(<FsProvenanceLine ticket={{ ...ADOPTED, activities: [] }} fsEnabled={false} />);
    expect(screen.getByTestId('fs-adopted-line')).toHaveTextContent(/^Adopted from FreshService #245123$/);
  });
});
