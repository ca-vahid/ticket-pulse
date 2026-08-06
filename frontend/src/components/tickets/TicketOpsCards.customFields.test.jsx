/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomFieldsCard } from './TicketOpsCards';
import { ticketsAPI } from '../../services/api';

// FR 08-05 #1 (Phase 1c) — the ticket-detail custom-fields card: every
// populated key renders (retired/deleted definitions become read-only chips),
// URL values render as clickable external links, and the dirty-state save
// behavior is preserved (orphaned keys never enter the PATCH payload).

const DEFINITIONS = [
  { id: 1, key: 'client_name', label: 'Client Name', type: 'text', options: [] },
  { id: 2, key: 'share_point_item_link', label: 'Share Point Item Link', type: 'text', options: [] },
];

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    customFieldDefinitions: vi.fn(() => Promise.resolve({ data: DEFINITIONS })),
    setCustomFields: vi.fn(() => Promise.resolve({})),
    links: vi.fn(() => Promise.resolve({ data: [] })),
    related: vi.fn(() => Promise.resolve({ data: {} })),
    macros: vi.fn(() => Promise.resolve({ data: [] })),
  },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const SP_LINK = 'https://example.sharepoint.com/sites/ProjectProposalSetup/Lists/DispForm.aspx?ID=1260';

describe('CustomFieldsCard (Phase 1c)', () => {
  test('URL values render as clickable external links opening in a new tab', async () => {
    render(<CustomFieldsCard ticketId={501} values={{ client_name: 'ACME Inc', share_point_item_link: SP_LINK }} canWrite />);
    await waitFor(() => expect(screen.getByDisplayValue('ACME Inc')).toBeInTheDocument());

    const link = screen.getByRole('link', { name: /Share Point Item Link/ });
    expect(link).toHaveAttribute('href', SP_LINK);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    // Truncated display drops the protocol; full URL stays on the tooltip.
    expect(link).toHaveAttribute('title', SP_LINK);
  });

  test('a URL field can still be edited: the pencil swaps the link for an input', async () => {
    render(<CustomFieldsCard ticketId={501} values={{ share_point_item_link: SP_LINK }} canWrite />);
    await waitFor(() => expect(screen.getByRole('link', { name: /Share Point Item Link/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit Share Point Item Link' }));
    expect(screen.getByLabelText('Share Point Item Link')).toHaveValue(SP_LINK);
  });

  test('keys whose definition is retired/missing render as read-only chips with the tooltip', async () => {
    render(<CustomFieldsCard ticketId={501} values={{ client_name: 'ACME Inc', legacy_code: 'X-99' }} canWrite />);
    await waitFor(() => expect(screen.getByDisplayValue('ACME Inc')).toBeInTheDocument());

    // Orphan key renders with a prettified label + value chip, not an input.
    expect(screen.getByText('Legacy Code')).toBeInTheDocument();
    expect(screen.getByText('X-99')).toBeInTheDocument();
    expect(screen.queryByLabelText('Legacy Code')).not.toBeInTheDocument();
    expect(screen.getByText('definition retired')).toBeInTheDocument();
    expect(screen.getByText('X-99').closest('[title]')).toHaveAttribute('title', expect.stringMatching(/retired/));
  });

  test('an orphaned URL value still renders as a link', async () => {
    render(<CustomFieldsCard ticketId={501} values={{ power_app_form_link: 'https://apps.powerapps.com/play/abc' }} canWrite />);
    await waitFor(() => expect(screen.getByText('definition retired')).toBeInTheDocument());
    const link = screen.getByRole('link', { name: /Power App Form Link/ });
    expect(link).toHaveAttribute('href', 'https://apps.powerapps.com/play/abc');
  });

  test('the card renders for orphan values even when the workspace has no definitions', async () => {
    ticketsAPI.customFieldDefinitions.mockResolvedValueOnce({ data: [] });
    render(<CustomFieldsCard ticketId={501} values={{ legacy_code: 'X-99' }} canWrite />);
    await waitFor(() => expect(screen.getByText('Legacy Code')).toBeInTheDocument());
  });

  test('dirty save sends only defined keys — orphaned values never enter the PATCH', async () => {
    render(<CustomFieldsCard ticketId={501} values={{ client_name: 'ACME Inc', legacy_code: 'X-99' }} canWrite />);
    await waitFor(() => expect(screen.getByDisplayValue('ACME Inc')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Client Name'), { target: { value: 'ACME Inc (Quebec)' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(ticketsAPI.setCustomFields).toHaveBeenCalledWith(501, {
      client_name: 'ACME Inc (Quebec)',
    }));
    // Orphan key stays out of the payload entirely.
    const payload = ticketsAPI.setCustomFields.mock.calls[0][1];
    expect('legacy_code' in payload).toBe(false);
  });
});
