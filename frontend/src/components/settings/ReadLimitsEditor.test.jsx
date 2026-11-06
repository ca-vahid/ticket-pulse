/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReadLimitsEditor } from './ApiKeysPanel';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: { oauthClientCategoryOptions: vi.fn() },
}));

// Simorgh IT read-search (6 Nov 2026): per-client hidden categories and the
// private-notes switch, picked from the workspace's categories.
const OPTIONS = [
  { id: 132, name: 'Onboarding & Offboarding', parentId: null },
  { id: 10, name: 'Onboarding', parentId: 132 },
  { id: 2, name: 'Offboarding', parentId: 132 },
  { id: 52, name: 'Account & Access', parentId: null },
];

afterEach(cleanup);

describe('ReadLimitsEditor', () => {
  test('ticks subcategories and the notes switch, and saves both', async () => {
    ticketsAPI.oauthClientCategoryOptions.mockResolvedValue({ data: OPTIONS });
    const onSave = vi.fn().mockResolvedValue();
    render(<ReadLimitsEditor client={{ id: 10, readExcludeCategoryIds: [], readPrivateNotes: true }} onSave={onSave} onCancel={() => {}} />);
    fireEvent.click(await screen.findByLabelText('Onboarding'));
    fireEvent.click(screen.getByLabelText(/May read private notes/));
    fireEvent.click(screen.getByRole('button', { name: 'Save read limits' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ readExcludeCategoryIds: [10], readPrivateNotes: false }));
  });

  test('a hidden parent folds its subcategories away and says so', async () => {
    ticketsAPI.oauthClientCategoryOptions.mockResolvedValue({ data: OPTIONS });
    render(<ReadLimitsEditor client={{ id: 10, readExcludeCategoryIds: [132], readPrivateNotes: true }} onSave={vi.fn()} onCancel={() => {}} />);
    expect(await screen.findByText('all 2 subcategories hidden')).toBeInTheDocument();
    expect(screen.queryByLabelText('Offboarding')).not.toBeInTheDocument();
  });
});
