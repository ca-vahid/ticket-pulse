/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TicketFormSection } from './TicketOpsPanel';
import { settingsAPI, ticketsAPI } from '../../services/api';

// Mega 08-23 Phase TF (TF3) — Settings → Ticket Ops → New-ticket form:
// built-in rows (Hide not Delete; requester/subject un-hideable), required
// toggles where sensible, per-type defaults, reorder, the two prominent
// workspace defaults (source + group), Restore defaults.

vi.mock('../../services/api', () => ({
  workspaceAPI: {},
  settingsAPI: {
    getTicketForm: vi.fn(),
    updateTicketForm: vi.fn(),
    setDefaultGroup: vi.fn(),
  },
  ticketsAPI: { meta: vi.fn() },
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({
    types: [],
    activeTypes: [{ id: 1, name: 'Incident' }, { id: 2, name: 'Service Request' }],
    defaultType: { id: 1, name: 'Incident' },
    refresh: vi.fn(),
  }),
  invalidateTicketTypesCache: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

const FIELD = (key, label, extra = {}) => ({ key, label, visible: true, required: false, defaultValue: null, locked: false, ...extra });
const RESOLVED = {
  fields: [
    FIELD('requester', 'Requester', { locked: true, required: true }),
    FIELD('subject', 'Subject', { locked: true, required: true }),
    FIELD('description', 'Description'),
    FIELD('type', 'Type'),
    FIELD('priority', 'Priority'),
    FIELD('category', 'Category'),
    FIELD('subcategory', 'Subcategory'),
    FIELD('source', 'Source'),
    FIELD('group', 'Group'),
    FIELD('tags', 'Tags'),
    FIELD('cc', 'Cc'),
    FIELD('attachments', 'Attachments'),
  ].map((f, i) => ({ ...f, sortOrder: i })),
  defaultSource: 103,
  defaultGroup: null,
  defaults: { notifyRequester: true, aiClassify: true, assignMode: 'none' },
};
const GROUPS = [
  { id: 5, freshserviceId: null, name: 'Internal AP', origin: 'local' },
  { id: 6, freshserviceId: '9000', name: 'Service Desk', origin: 'freshservice' },
];

beforeEach(() => {
  vi.clearAllMocks();
  settingsAPI.getTicketForm.mockResolvedValue({ data: { data: RESOLVED } });
  settingsAPI.updateTicketForm.mockImplementation((body) => Promise.resolve({ data: { data: { ...RESOLVED, ...body } } }));
  settingsAPI.setDefaultGroup.mockResolvedValue({});
  ticketsAPI.meta.mockResolvedValue({ data: { groups: GROUPS } });
});

afterEach(cleanup);

async function renderLoaded() {
  render(<TicketFormSection />);
  await waitFor(() => expect(screen.getByText('Description')).toBeInTheDocument());
}

describe('TicketFormSection (Phase TF admin UI)', () => {
  test('requester and subject are locked — always shown, always required, no Hide toggle', async () => {
    await renderLoaded();
    expect(screen.getAllByText('Always shown · required')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Hide Requester' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide Subject' })).not.toBeInTheDocument();
    // Every other row IS hideable (Hide, never Delete — retire doctrine).
    expect(screen.getByRole('button', { name: 'Hide Description' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  test('hiding a field + Save PUTs fields with visible:false', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Group' }));
    fireEvent.click(screen.getByRole('button', { name: /Save form/ }));
    await waitFor(() => expect(settingsAPI.updateTicketForm).toHaveBeenCalled());
    const body = settingsAPI.updateTicketForm.mock.calls[0][0];
    expect(body.fields.find((f) => f.key === 'group')).toEqual(expect.objectContaining({ visible: false }));
    expect(body.fields.find((f) => f.key === 'subject')).toEqual(expect.objectContaining({ visible: true, required: true }));
  });

  test('the workspace default source select PUTs defaultSource', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Default source'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Save form/ }));
    await waitFor(() => expect(settingsAPI.updateTicketForm).toHaveBeenCalledWith(expect.objectContaining({ defaultSource: 3 })));
  });

  test('picking an INTERNAL default group writes through the existing workspace route (surface, not duplicate)', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Default group'), { target: { value: 'int:5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save form/ }));
    await waitFor(() => expect(settingsAPI.setDefaultGroup).toHaveBeenCalledWith(5));
    // The ticket-form row itself stores no FS group in this case.
    expect(settingsAPI.updateTicketForm).toHaveBeenCalledWith(expect.objectContaining({ defaultGroupId: null }));
  });

  test('picking a FRESHSERVICE default group stores it on the ticket-form config instead', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Default group'), { target: { value: 'fs:9000' } });
    fireEvent.click(screen.getByRole('button', { name: /Save form/ }));
    await waitFor(() => expect(settingsAPI.updateTicketForm).toHaveBeenCalledWith(expect.objectContaining({ defaultGroupId: '9000' })));
    expect(settingsAPI.setDefaultGroup).not.toHaveBeenCalled();
  });

  test('required toggle + priority default editor round-trip in the fields payload', async () => {
    await renderLoaded();
    const descRow = screen.getByText('Description').closest('div');
    fireEvent.click(within(descRow).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Default priority'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Save form/ }));
    await waitFor(() => expect(settingsAPI.updateTicketForm).toHaveBeenCalled());
    const body = settingsAPI.updateTicketForm.mock.calls[0][0];
    expect(body.fields.find((f) => f.key === 'description')).toEqual(expect.objectContaining({ required: true }));
    expect(body.fields.find((f) => f.key === 'priority')).toEqual(expect.objectContaining({ defaultValue: '3' }));
  });

  test('reorder arrows move a row and renumber sortOrder', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Move Description down' }));
    fireEvent.click(screen.getByRole('button', { name: /Save form/ }));
    await waitFor(() => expect(settingsAPI.updateTicketForm).toHaveBeenCalled());
    const keys = settingsAPI.updateTicketForm.mock.calls[0][0].fields
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((f) => f.key);
    expect(keys.indexOf('type')).toBe(2);
    expect(keys.indexOf('description')).toBe(3);
  });

  test('Restore defaults PUTs reset:true (workspace internal default group untouched)', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Restore defaults/ }));
    await waitFor(() => expect(settingsAPI.updateTicketForm).toHaveBeenCalledWith({ reset: true }));
    expect(settingsAPI.setDefaultGroup).not.toHaveBeenCalled();
  });

  test('the scope guard is stated: TP composer only, FreshService untouched', async () => {
    await renderLoaded();
    expect(screen.getByText(/FreshService's forms and fields are untouched/)).toBeInTheDocument();
  });
});
