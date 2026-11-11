/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MailboxAliases, { aliasProblem } from './MailboxAliases';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: { updateMailbox: vi.fn(), getMailboxAliasSuggestions: vi.fn() },
}));

const mailbox = { id: 6, address: 'ar-tickets@example.com', mode: 'ingest', aliases: ['receivables@example.com'] };

describe('MailboxAliases ("Also known as" on a mailbox card)', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('lists each address on its own row with a Remove control; no chips', async () => {
    ticketsAPI.getMailboxAliasSuggestions.mockResolvedValue({ data: [] });
    ticketsAPI.updateMailbox.mockResolvedValue({ data: {} });
    const onChanged = vi.fn();
    render(<MailboxAliases mailbox={mailbox} onChanged={onChanged} />);
    expect(screen.getByText('Also known as')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Other addresses of ar-tickets@example.com' });
    expect(list).toHaveTextContent('receivables@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Remove receivables@example.com' }));
    await waitFor(() => expect(ticketsAPI.updateMailbox).toHaveBeenCalledWith(6, { aliases: [] }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('adds a typed address, lowercased, and clears the field', async () => {
    ticketsAPI.getMailboxAliasSuggestions.mockResolvedValue({ data: [] });
    ticketsAPI.updateMailbox.mockResolvedValue({ data: {} });
    render(<MailboxAliases mailbox={mailbox} onChanged={vi.fn()} />);
    const input = screen.getByLabelText('Add another address of ar-tickets@example.com');
    fireEvent.change(input, { target: { value: '  Billing@Example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(ticketsAPI.updateMailbox).toHaveBeenCalledWith(6, { aliases: ['receivables@example.com', 'billing@example.com'] }));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  test('refuses what is not an e-mail address, the mailbox itself and a repeat, without calling the server', async () => {
    ticketsAPI.getMailboxAliasSuggestions.mockResolvedValue({ data: [] });
    render(<MailboxAliases mailbox={mailbox} onChanged={vi.fn()} />);
    const input = screen.getByLabelText('Add another address of ar-tickets@example.com');
    for (const [value, message] of [
      ['receivables', '"receivables" is not an e-mail address.'],
      ['ar-tickets@example.com', 'That is this mailbox’s own address.'],
      ['receivables@example.com', 'That address is already listed.'],
    ]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    expect(ticketsAPI.updateMailbox).not.toHaveBeenCalled();
  });

  test('shows the server’s reason when it refuses an address', async () => {
    ticketsAPI.getMailboxAliasSuggestions.mockResolvedValue({ data: [] });
    ticketsAPI.updateMailbox.mockRejectedValue({ response: { data: { message: 'alex@example.com is a person on this team, not another address of the mailbox' } } });
    render(<MailboxAliases mailbox={mailbox} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Add another address of ar-tickets@example.com'), { target: { value: 'alex@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('is a person on this team');
  });

  test('offers suggestions as a quiet one-click "Add <address>" line, without the ones already listed', async () => {
    ticketsAPI.getMailboxAliasSuggestions.mockResolvedValue({ data: [{ address: 'receivables@example.com', count: 51 }, { address: 'billing@example.com', count: 14 }] });
    ticketsAPI.updateMailbox.mockResolvedValue({ data: {} });
    render(<MailboxAliases mailbox={mailbox} onChanged={vi.fn()} />);
    const add = await screen.findByRole('button', { name: 'Add billing@example.com' });
    expect(screen.queryByRole('button', { name: 'Add receivables@example.com' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mailbox-alias-suggestions-6')).toHaveTextContent('(14 e-mails)');
    fireEvent.click(add);
    await waitFor(() => expect(ticketsAPI.updateMailbox).toHaveBeenCalledWith(6, { aliases: ['receivables@example.com', 'billing@example.com'] }));
  });

  test('a failed suggestions call offers none and breaks nothing', async () => {
    ticketsAPI.getMailboxAliasSuggestions.mockRejectedValue(new Error('offline'));
    render(<MailboxAliases mailbox={{ ...mailbox, aliases: [] }} onChanged={vi.fn()} />);
    await waitFor(() => expect(ticketsAPI.getMailboxAliasSuggestions).toHaveBeenCalledWith(6));
    expect(screen.queryByTestId('mailbox-alias-suggestions-6')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  test('aliasProblem: the cap', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `team${i}@example.com`);
    expect(aliasProblem('one-more@example.com', { mailboxAddress: 'x@example.com', aliases: ten })).toMatch(/at most 10/);
    expect(aliasProblem('fine@example.com', { mailboxAddress: 'x@example.com', aliases: [] })).toBeNull();
  });
});
