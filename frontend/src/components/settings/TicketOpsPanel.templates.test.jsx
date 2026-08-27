/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CreateTemplatesSection } from './TicketOpsPanel';
import { settingsAPI } from '../../services/api';

// Mega 08-26 Phase TT (QA 08-26 #2) — Settings → Ticket Ops → Create-form
// templates: a LABELED subject input whose value reaches the POST body,
// type / category / subcategory pickers, a pencil per row that prefills every
// field and PATCHes the edit, and rows that show subject + type/category chips.

const QA_SUBJECT = '{A2XXXX - NAME OF PROPOSAL} is now active in BST';
const TEMPLATES = [
  {
    id: 3, name: 'Internal Proposals', subject: QA_SUBJECT, description: null, priority: null,
    ticketType: null, internalCategoryId: null, internalSubcategoryId: null, isActive: true, sortOrder: 0,
  },
  {
    id: 4, name: 'New starter', subject: 'New starter — laptop + accounts', description: 'Start date:\nManager:',
    priority: 3, ticketType: 'Service Request', internalCategoryId: 10, internalSubcategoryId: 11, isActive: true, sortOrder: 1,
  },
  {
    id: 5, name: 'Retired preset', subject: null, description: null, priority: null,
    ticketType: null, internalCategoryId: null, internalSubcategoryId: null, isActive: false, sortOrder: 2,
  },
];
const CATEGORY_TREE = [
  { id: 10, name: 'Accounts', subcategories: [{ id: 11, name: 'Onboarding' }, { id: 12, name: 'Offboarding' }] },
  { id: 20, name: 'Hardware', subcategories: [] },
];

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getTicketTemplates: vi.fn(() => Promise.resolve({ data: { data: TEMPLATES } })),
    createTicketTemplate: vi.fn(() => Promise.resolve({ data: {} })),
    updateTicketTemplate: vi.fn(() => Promise.resolve({ data: {} })),
    deleteTicketTemplate: vi.fn(() => Promise.resolve({ data: {} })),
  },
  ticketsAPI: {
    meta: vi.fn(() => Promise.resolve({ data: { categoryTree: CATEGORY_TREE } })),
  },
  workspaceAPI: {},
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({
    types: [
      { id: 1, name: 'Incident', color: 'red', isActive: true },
      { id: 2, name: 'Service Request', color: 'blue', isActive: true },
    ],
    activeTypes: [
      { id: 1, name: 'Incident', color: 'red', isActive: true },
      { id: 2, name: 'Service Request', color: 'blue', isActive: true },
    ],
    defaultType: { id: 1, name: 'Incident' },
    refresh: vi.fn(),
  }),
  invalidateTicketTypesCache: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 5 } }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderLoaded() {
  render(<CreateTemplatesSection />);
  await waitFor(() => expect(screen.getByText('Internal Proposals')).toBeInTheDocument());
  // Category chips need the tree — wait for it so chip assertions are stable.
  await waitFor(() => expect(screen.getByText(/Accounts › Onboarding/)).toBeInTheDocument());
}

const rowOf = (name) => screen.getByText(name).closest('li');

describe('CreateTemplatesSection (Phase TT)', () => {
  test('rows show the stored subject plus type / category / priority chips', async () => {
    await renderLoaded();
    const proposals = rowOf('Internal Proposals');
    expect(within(proposals).getByText(QA_SUBJECT)).toBeInTheDocument();
    expect(within(proposals).getByTitle(`Subject: ${QA_SUBJECT}`)).toBeInTheDocument();

    const starter = rowOf('New starter');
    expect(within(starter).getByText('New starter — laptop + accounts')).toBeInTheDocument();
    expect(within(starter).getByTitle('Ticket type applied by this template')).toHaveTextContent('Service Request');
    expect(within(starter).getByTitle('Category applied by this template')).toHaveTextContent('Accounts › Onboarding');
    expect(within(starter).getByTitle('Priority applied by this template')).toHaveTextContent('High');

    // A template with no subject says so instead of showing a bare dash.
    const retired = rowOf('Retired preset');
    expect(within(retired).getByText('no subject')).toBeInTheDocument();
    expect(within(retired).getByText('disabled')).toBeInTheDocument();
  });

  test('New template: the subject input is labeled and its value is in the POST body with type/category', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('New template'));
    const form = screen.getByTestId('template-form');

    // Visible labels, not just placeholders (QA typed the subject into an unlabeled box).
    expect(within(form).getByText('Subject')).toBeInTheDocument();
    expect(within(form).getByText('Template name')).toBeInTheDocument();
    expect(within(form).getByText('Type')).toBeInTheDocument();
    expect(within(form).getByText('Category')).toBeInTheDocument();
    expect(within(form).getByText('Subcategory')).toBeInTheDocument();

    fireEvent.change(within(form).getByLabelText('Template name'), { target: { value: 'Internal Proposals v2' } });
    fireEvent.change(within(form).getByLabelText('Subject'), { target: { value: QA_SUBJECT } });
    fireEvent.change(within(form).getByLabelText('Description scaffold'), { target: { value: 'Proposal:\nClient:' } });
    fireEvent.change(within(form).getByLabelText('Priority'), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText('Ticket type'), { target: { value: 'Service Request' } });
    fireEvent.change(within(form).getByLabelText('Category'), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Subcategory'), { target: { value: '12' } });
    fireEvent.click(within(form).getByText('Create'));

    await waitFor(() => expect(settingsAPI.createTicketTemplate).toHaveBeenCalledTimes(1));
    expect(settingsAPI.createTicketTemplate).toHaveBeenCalledWith({
      name: 'Internal Proposals v2',
      subject: QA_SUBJECT,
      description: 'Proposal:\nClient:',
      priority: 2,
      ticketType: 'Service Request',
      internalCategoryId: 10,
      internalSubcategoryId: 12,
    });
    expect(settingsAPI.updateTicketTemplate).not.toHaveBeenCalled();
    // The form closes and the list reloads.
    await waitFor(() => expect(screen.queryByTestId('template-form')).not.toBeInTheDocument());
    expect(settingsAPI.getTicketTemplates).toHaveBeenCalledTimes(2);
  });

  test('subcategory picker follows the chosen category and resets when the category changes', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('New template'));
    const form = screen.getByTestId('template-form');
    const sub = within(form).getByLabelText('Subcategory');
    expect(sub).toBeDisabled();

    fireEvent.change(within(form).getByLabelText('Category'), { target: { value: '10' } });
    expect(sub).not.toBeDisabled();
    expect(within(sub).getByRole('option', { name: 'Offboarding' })).toBeInTheDocument();
    fireEvent.change(sub, { target: { value: '11' } });
    expect(sub).toHaveValue('11');

    // Hardware has no subcategories → picker disabled again and the stale pick is dropped.
    fireEvent.change(within(form).getByLabelText('Category'), { target: { value: '20' } });
    expect(sub).toBeDisabled();
    expect(sub).toHaveValue('');
    expect(within(sub).getByRole('option', { name: 'No subcategories' })).toBeInTheDocument();
  });

  test('pencil prefills EVERY field of the row and Save PATCHes the edited payload', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByLabelText('Edit template New starter'));
    const form = screen.getByTestId('template-form');
    expect(within(form).getByText(/Editing “New starter”/)).toBeInTheDocument();
    expect(within(form).getByLabelText('Template name')).toHaveValue('New starter');
    expect(within(form).getByLabelText('Subject')).toHaveValue('New starter — laptop + accounts');
    expect(within(form).getByLabelText('Description scaffold')).toHaveValue('Start date:\nManager:');
    expect(within(form).getByLabelText('Priority')).toHaveValue('3');
    expect(within(form).getByLabelText('Ticket type')).toHaveValue('Service Request');
    expect(within(form).getByLabelText('Category')).toHaveValue('10');
    expect(within(form).getByLabelText('Subcategory')).toHaveValue('11');

    fireEvent.change(within(form).getByLabelText('Subject'), { target: { value: 'New starter — laptop, phone + accounts' } });
    fireEvent.change(within(form).getByLabelText('Priority'), { target: { value: '' } });
    fireEvent.change(within(form).getByLabelText('Ticket type'), { target: { value: 'Incident' } });
    fireEvent.click(within(form).getByText('Save'));

    await waitFor(() => expect(settingsAPI.updateTicketTemplate).toHaveBeenCalledTimes(1));
    expect(settingsAPI.updateTicketTemplate).toHaveBeenCalledWith(4, {
      name: 'New starter',
      subject: 'New starter — laptop, phone + accounts',
      description: 'Start date:\nManager:',
      priority: null,
      ticketType: 'Incident',
      internalCategoryId: 10,
      internalSubcategoryId: 11,
    });
    expect(settingsAPI.createTicketTemplate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('template-form')).not.toBeInTheDocument());
  });

  test('editing QA’s template (subject only) keeps the subject and can add a type; Cancel discards', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByLabelText('Edit template Internal Proposals'));
    let form = screen.getByTestId('template-form');
    expect(within(form).getByLabelText('Subject')).toHaveValue(QA_SUBJECT);
    expect(within(form).getByLabelText('Ticket type')).toHaveValue('');
    fireEvent.change(within(form).getByLabelText('Ticket type'), { target: { value: 'Service Request' } });
    fireEvent.click(within(form).getByText('Cancel'));
    expect(screen.queryByTestId('template-form')).not.toBeInTheDocument();
    expect(settingsAPI.updateTicketTemplate).not.toHaveBeenCalled();

    // Re-opening starts from the stored row, not the discarded draft.
    fireEvent.click(screen.getByLabelText('Edit template Internal Proposals'));
    form = screen.getByTestId('template-form');
    expect(within(form).getByLabelText('Ticket type')).toHaveValue('');
    fireEvent.change(within(form).getByLabelText('Ticket type'), { target: { value: 'Service Request' } });
    fireEvent.click(within(form).getByText('Save'));
    await waitFor(() => expect(settingsAPI.updateTicketTemplate).toHaveBeenCalledWith(3, expect.objectContaining({
      subject: QA_SUBJECT,
      ticketType: 'Service Request',
    })));
  });

  test('a duplicate-name rejection from the API is shown inline', async () => {
    settingsAPI.createTicketTemplate.mockRejectedValueOnce({
      response: { data: { code: 'template_name_taken', message: 'A template named "Internal Proposals" already exists in this workspace — pick another name' } },
    });
    await renderLoaded();
    fireEvent.click(screen.getByText('New template'));
    const form = screen.getByTestId('template-form');
    fireEvent.change(within(form).getByLabelText('Template name'), { target: { value: 'Internal Proposals' } });
    fireEvent.click(within(form).getByText('Create'));
    await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent(/already exists/));
    // Form stays open so the name can be fixed.
    expect(screen.getByTestId('template-form')).toBeInTheDocument();
  });

  test('Enable/Disable still toggles isActive only', async () => {
    await renderLoaded();
    fireEvent.click(within(rowOf('Retired preset')).getByText('Enable'));
    await waitFor(() => expect(settingsAPI.updateTicketTemplate).toHaveBeenCalledWith(5, { isActive: true }));
  });
});
