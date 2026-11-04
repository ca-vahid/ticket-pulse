/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MailSubjectSection } from './TicketOpsPanel';
import { settingsAPI } from '../../services/api';

// 3 Nov 2026: where the ticket number goes in e-mail subjects, per workspace.
vi.mock('../../services/api', () => ({
  settingsAPI: { getMailSubject: vi.fn(), updateMailSubject: vi.fn() },
  workspaceAPI: {},
  ticketsAPI: {},
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, refresh: vi.fn() }),
  invalidateTicketTypesCache: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  settingsAPI.getMailSubject.mockResolvedValue({ data: { data: { refPosition: 'after' } } });
  settingsAPI.updateMailSubject.mockImplementation((d) => Promise.resolve({ data: { data: d } }));
});
afterEach(cleanup);

describe('MailSubjectSection', () => {
  test('shows the saved choice with a sample subject for each', async () => {
    render(<MailSubjectSection />);
    await waitFor(() => expect(screen.getByLabelText(/After the subject/)).toBeChecked());
    expect(screen.getByText('Re: [TP-1560] Adding Aissa to Rental Vehicle Queries')).toBeInTheDocument();
    expect(screen.getByText('Re: Adding Aissa to Rental Vehicle Queries [TP-1560]')).toBeInTheDocument();
  });

  test('picking Before saves it straight away', async () => {
    render(<MailSubjectSection />);
    await waitFor(() => expect(screen.getByLabelText(/Before the subject/)).not.toBeChecked());
    fireEvent.click(screen.getByLabelText(/Before the subject/));
    await waitFor(() => expect(settingsAPI.updateMailSubject).toHaveBeenCalledWith({ refPosition: 'before' }));
    await waitFor(() => expect(screen.getByLabelText(/Before the subject/)).toBeChecked());
    expect(screen.getByText(/Saved/)).toBeInTheDocument();
  });
});
