/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ContactsPanel, { validateContactForm } from './ContactsPanel';
import { settingsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getContacts: vi.fn(),
    addContact: vi.fn(),
    updateContact: vi.fn(),
    removeContact: vi.fn(),
  },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }),
}));

const CONTACTS = [
  {
    id: 900, requesterId: 41, name: 'Avery Stone', email: 'avery.stone@example.com', phone: '604-555-0100', jobTitle: 'Account manager',
    note: 'Printer vendor', addedBy: 'admin.one@example.com', addedAt: '2026-11-26T18:00:00Z', managedByFreshService: false, hiddenFromPickers: null,
  },
  {
    id: 901, requesterId: 42, name: 'Jordan Pike', email: 'jordan.pike@example.com', phone: null, jobTitle: null,
    note: null, addedBy: null, addedAt: '2026-11-20T18:00:00Z', managedByFreshService: true, hiddenFromPickers: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  settingsAPI.getContacts.mockResolvedValue({ data: { contacts: CONTACTS, total: 2, sandbox: false } });
  settingsAPI.addContact.mockResolvedValue({ data: { contact: { id: 902 }, existing: false, message: 'Riley Ward added to this workspace\'s contacts.' } });
  settingsAPI.updateContact.mockResolvedValue({ data: { contact: { id: 900 }, changed: ['note'] } });
  settingsAPI.removeContact.mockResolvedValue({ data: { removed: true, hidden: false } });
});
afterEach(cleanup);

describe('validateContactForm', () => {
  test('name and a real-looking e-mail are required when adding', () => {
    expect(validateContactForm({ name: '', email: '' })).toEqual({ name: 'Enter a name.', email: 'Enter an e-mail address.' });
    expect(validateContactForm({ name: 'Riley', email: 'riley@' }).email).toMatch(/does not look like/);
    expect(validateContactForm({ name: 'Riley Ward', email: 'riley.ward@example.com' })).toEqual({});
  });
  test('editing never checks the e-mail (it cannot change)', () => {
    expect(validateContactForm({ name: 'Riley Ward', email: '' }, { isEdit: true })).toEqual({});
  });
});

describe('ContactsPanel', () => {
  test('lists the workspace\'s contacts with e-mail, note and who added them', async () => {
    render(<ContactsPanel />);
    expect(await screen.findByText('Avery Stone')).toBeInTheDocument();
    expect(screen.getByText(/avery\.stone@example\.com · Account manager · 604-555-0100/)).toBeInTheDocument();
    expect(screen.getAllByText('Printer vendor').length).toBeGreaterThan(0);
    expect(screen.getByText('by admin.one@example.com')).toBeInTheDocument();
    expect(screen.getByText('Jordan Pike')).toBeInTheDocument();
    expect(screen.getByText(/People outside the directory you want to pick as requesters or recipients/)).toBeInTheDocument();
  });

  test('empty state', async () => {
    settingsAPI.getContacts.mockResolvedValue({ data: { contacts: [], total: 0, sandbox: false } });
    render(<ContactsPanel />);
    expect(await screen.findByTestId('contacts-empty')).toHaveTextContent('No contacts yet');
  });

  test('the add form checks name and e-mail before sending, then adds and reloads', async () => {
    render(<ContactsPanel />);
    await screen.findByText('Avery Stone');
    fireEvent.click(screen.getByRole('button', { name: /Add contact/ }));
    const form = screen.getByRole('form', { name: 'Add a contact' });
    fireEvent.click(within(form).getByRole('button', { name: 'Add contact' }));
    expect(within(form).getByText('Enter a name.')).toBeInTheDocument();
    expect(within(form).getByText('Enter an e-mail address.')).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Name/)).toHaveAttribute('aria-invalid', 'true');
    expect(settingsAPI.addContact).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Riley Ward' } });
    fireEvent.change(within(form).getByLabelText(/^E-mail/), { target: { value: 'riley.ward@' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add contact' }));
    expect(within(form).getByText(/does not look like an e-mail/)).toBeInTheDocument();
    expect(settingsAPI.addContact).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText(/^E-mail/), { target: { value: ' Riley.Ward@Example.com ' } });
    fireEvent.change(within(form).getByLabelText(/^Note/), { target: { value: 'Courier' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add contact' }));
    await waitFor(() => expect(settingsAPI.addContact).toHaveBeenCalledWith({
      name: 'Riley Ward', email: 'riley.ward@example.com', phone: '', jobTitle: '', note: 'Courier',
    }));
    expect(await screen.findByText(/Riley Ward added to this workspace's contacts/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add a contact' })).not.toBeInTheDocument();
    expect(settingsAPI.getContacts).toHaveBeenCalledTimes(2);
  });

  test('a server refusal (e.g. already a contact) shows in the form', async () => {
    settingsAPI.addContact.mockRejectedValue({ response: { data: { message: 'Avery Stone is already a contact in this workspace' } } });
    render(<ContactsPanel />);
    await screen.findByText('Avery Stone');
    fireEvent.click(screen.getByRole('button', { name: /Add contact/ }));
    const form = screen.getByRole('form', { name: 'Add a contact' });
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Avery Stone' } });
    fireEvent.change(within(form).getByLabelText(/^E-mail/), { target: { value: 'avery.stone@example.com' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add contact' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('already a contact');
  });

  test('remove asks in the row first; Keep cancels, Remove removes', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<ContactsPanel />);
    await screen.findByText('Avery Stone');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Avery Stone' }));
    const ask = screen.getByRole('group', { name: 'Remove Avery Stone?' });
    expect(ask).toHaveTextContent('Tickets they are on stay as they are');
    expect(within(ask).getByRole('button', { name: 'Keep' })).toHaveFocus();
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep' }));
    expect(screen.queryByRole('group', { name: 'Remove Avery Stone?' })).not.toBeInTheDocument();
    expect(settingsAPI.removeContact).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Avery Stone' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Remove Avery Stone?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(settingsAPI.removeContact).toHaveBeenCalledWith(900));
    expect(await screen.findByText(/Avery Stone removed from this workspace's contacts/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('edit: the e-mail is fixed, and a FreshService person sends the note only', async () => {
    render(<ContactsPanel />);
    await screen.findByText('Jordan Pike');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Jordan Pike' }));
    const form = screen.getByRole('form', { name: 'Edit Jordan Pike' });
    expect(within(form).queryByLabelText(/^E-mail/)).not.toBeInTheDocument();
    expect(within(form).getByText(/remove this contact and add the new one/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Name/)).toBeDisabled();
    expect(within(form).getByText(/FreshService keeps this person/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^Note/), { target: { value: 'Night shift' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(settingsAPI.updateContact).toHaveBeenCalledWith(901, { note: 'Night shift' }));
  });

  test('a sandbox workspace is read-only', async () => {
    settingsAPI.getContacts.mockResolvedValue({ data: { contacts: CONTACTS, total: 2, sandbox: true } });
    render(<ContactsPanel />);
    await screen.findByText('Avery Stone');
    expect(screen.getByText(/integration sandbox/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add contact/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Avery Stone' })).not.toBeInTheDocument();
  });
});
