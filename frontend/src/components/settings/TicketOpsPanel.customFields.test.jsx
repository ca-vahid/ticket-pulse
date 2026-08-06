/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CustomFieldsSection } from './TicketOpsPanel';
import { settingsAPI } from '../../services/api';

// FR 08-05 #1 (Phase 1c) — Settings → Ticket Ops → Custom fields manager:
// source badges (Manual vs API-provisioned), the "new from API" highlight,
// inline label/type/options editing (PATCH), and deactivate/reactivate.

const NOW = Date.now();
const FIELDS = [
  { id: 1, key: 'cost_centre', label: 'Cost centre', type: 'text', options: [], source: 'manual', isActive: true, isFeatured: true, createdAt: new Date(NOW - 90 * 86400000).toISOString() },
  { id: 2, key: 'client_name', label: 'Client Name', type: 'text', options: [], source: 'api', isActive: true, isFeatured: false, createdAt: new Date(NOW - 86400000).toISOString() },
  { id: 3, key: 'power_app_record_id', label: 'Power App Record Id', type: 'number', options: [], source: 'api', isActive: true, isFeatured: false, createdAt: new Date(NOW - 30 * 86400000).toISOString() },
  { id: 4, key: 'old_field', label: 'Old field', type: 'text', options: [], source: 'manual', isActive: false, isFeatured: false, createdAt: new Date(NOW - 90 * 86400000).toISOString() },
];

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getCustomFields: vi.fn(() => Promise.resolve({ data: { data: FIELDS } })),
    createCustomField: vi.fn(() => Promise.resolve({})),
    updateCustomField: vi.fn(() => Promise.resolve({})),
    deleteCustomField: vi.fn(() => Promise.resolve({})),
  },
  ticketsAPI: {},
  workspaceAPI: {},
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, refresh: vi.fn() }),
  invalidateTicketTypesCache: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderLoaded() {
  render(<CustomFieldsSection />);
  await waitFor(() => expect(screen.getByText('Client Name')).toBeInTheDocument());
}

describe('CustomFieldsSection (Phase 1c manager)', () => {
  test('shows a source badge per definition: Manual vs API', async () => {
    await renderLoaded();
    expect(screen.getAllByText('Manual')).toHaveLength(2); // cost_centre + old_field
    expect(screen.getAllByText('API')).toHaveLength(2); // client_name + power_app_record_id
    // API badge explains provenance on hover.
    expect(screen.getAllByTitle(/Auto-provisioned by API intake/)[0]).toBeInTheDocument();
  });

  test('recent API-provisioned definitions get the "new from API" highlight; older ones do not', async () => {
    await renderLoaded();
    // client_name arrived yesterday → highlighted; power_app_record_id is 30 days old → not.
    expect(screen.getAllByText('new from API')).toHaveLength(1);
    expect(screen.getByText('Client Name').closest('li').className).toMatch(/bg-indigo-50/);
    expect(screen.getByText('Power App Record Id').closest('li').className).not.toMatch(/bg-indigo-50/);
  });

  test('Edit prefills the form (key locked) and PATCHes label/type/options', async () => {
    await renderLoaded();
    const row = screen.getByText('Power App Record Id').closest('li');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    const keyInput = screen.getByLabelText('Field key');
    expect(keyInput).toHaveValue('power_app_record_id');
    expect(keyInput).toBeDisabled(); // keys are permanent
    // Curate the API inference: number → text, and relabel.
    fireEvent.change(screen.getByLabelText('Field label'), { target: { value: 'PowerApp record' } });
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(settingsAPI.updateCustomField).toHaveBeenCalledWith(3, {
      label: 'PowerApp record', type: 'text', options: [],
    }));
  });

  test('editing to select sends the comma-separated options as an array', async () => {
    await renderLoaded();
    const row = screen.getByText('Cost centre').closest('li');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'select' } });
    fireEvent.change(screen.getByLabelText('Options'), { target: { value: 'A100, B200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(settingsAPI.updateCustomField).toHaveBeenCalledWith(1, {
      label: 'Cost centre', type: 'select', options: ['A100', 'B200'],
    }));
  });

  test('deactivate / reactivate toggle isActive; retired rows are marked', async () => {
    await renderLoaded();
    expect(screen.getByText('retired')).toBeInTheDocument();
    const activeRow = screen.getByText('Client Name').closest('li');
    fireEvent.click(within(activeRow).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(settingsAPI.updateCustomField).toHaveBeenCalledWith(2, { isActive: false }));

    const retiredRow = screen.getByText('Old field').closest('li');
    fireEvent.click(within(retiredRow).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(settingsAPI.updateCustomField).toHaveBeenCalledWith(4, { isActive: true }));
  });

  test('creating still sends the key alongside label/type', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /New field/ }));
    fireEvent.change(screen.getByLabelText('Field label'), { target: { value: 'Region' } });
    fireEvent.change(screen.getByLabelText('Field key'), { target: { value: 'region' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(settingsAPI.createCustomField).toHaveBeenCalledWith({
      key: 'region', label: 'Region', type: 'text', options: [],
    }));
  });
});

// Phase 2 — the "Featured" star: ONE definition per workspace surfaces as a
// chip on queue rows and in the peek. The server enforces single-featured;
// the UI mirrors that optimistically.
describe('CustomFieldsSection — featured toggle (Phase 2)', () => {
  test('the featured definition shows a pressed star; the rest are unpressed', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'Unfeature Cost centre' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Feature Client Name on queue rows' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('featuring another field PATCHes isFeatured and optimistically unfeatures the current one', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Feature Client Name on queue rows' }));
    // Optimistic single-select: Cost centre's star flips off immediately.
    expect(screen.getByRole('button', { name: 'Feature Cost centre on queue rows' })).toBeInTheDocument();
    await waitFor(() => expect(settingsAPI.updateCustomField).toHaveBeenCalledWith(2, { isFeatured: true }));
  });

  test('clicking the pressed star unfeatures it', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Unfeature Cost centre' }));
    await waitFor(() => expect(settingsAPI.updateCustomField).toHaveBeenCalledWith(1, { isFeatured: false }));
  });
});
