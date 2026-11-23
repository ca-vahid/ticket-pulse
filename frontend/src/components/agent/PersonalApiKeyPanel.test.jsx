/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Personal API keys (4.4.05): the person's own section on their profile.

const api = vi.hoisted(() => ({
  mine: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
  guide: vi.fn(),
}));
vi.mock('../../services/api', () => ({ personalApiKeysAPI: api }));

import PersonalApiKeyPanel, { SECRET_WARNING } from './PersonalApiKeyPanel';

const HOUR = 3600e3;
const KEY = {
  id: 7,
  name: 'Reply assistant',
  prefix: 'tpu_ab12',
  abilities: ['read', 'reply'],
  expiresAt: new Date(Date.now() + 90 * 24 * HOUR).toISOString(),
  createdAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  lastUsedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  lastUsedIp: '10.1.2.3',
  useCount: 12,
  ipAllowlist: [],
  status: 'active',
};
const GUIDE = '# Ticket Pulse API guide for Dana Fox\n\nSend the header `Authorization: Bearer <YOUR_KEY>`.\n';

const mineWith = (over = {}) => ({ success: true, data: { enabled: true, canCreate: true, reason: null, maxKeys: 1, keys: [], ...over } });

let writeText;
beforeEach(() => {
  vi.clearAllMocks();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  api.guide.mockResolvedValue({ success: true, data: { markdown: GUIDE, filename: 'ticket-pulse-api-guide.md' } });
  vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('no browser dialogs'); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Your API key — visibility', () => {
  test('a person not on the API access list sees nothing at all', async () => {
    api.mine.mockResolvedValue({ success: true, data: { enabled: false, canCreate: false, reason: 'Ask an admin to give you API access.', keys: [] } });
    const { container } = render(<PersonalApiKeyPanel />);
    await waitFor(() => expect(api.mine).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(api.guide).not.toHaveBeenCalled();
  });

  test('off the list but still holding a key: the key and the reason show, no guide, no create', async () => {
    api.mine.mockResolvedValue({ success: true, data: { enabled: false, canCreate: false, reason: "Your access is read-only, so you can't make an API key.", keys: [KEY] } });
    render(<PersonalApiKeyPanel />);
    expect(await screen.findByTestId('personal-key-row')).toHaveTextContent('Reply assistant');
    expect(screen.getByText("Your access is read-only, so you can't make an API key.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-guide')).not.toBeInTheDocument();
    expect(api.guide).not.toHaveBeenCalled();
  });

  test('a failed read hides the section too', async () => {
    api.mine.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const { container } = render(<PersonalApiKeyPanel />);
    await waitFor(() => expect(api.mine).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Your API key — no key', () => {
  test('one sentence and "Create a key"; the guide is offered', async () => {
    api.mine.mockResolvedValue(mineWith());
    render(<PersonalApiKeyPanel />);
    const empty = await screen.findByTestId('personal-key-empty');
    expect(empty).toHaveTextContent('You have no key.');
    expect(within(empty).getByRole('button', { name: 'Create a key' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your AI assistant guide' })).toBeInTheDocument();
  });

  test('when the person may not create one, the reason shows instead of the button', async () => {
    api.mine.mockResolvedValue(mineWith({ canCreate: false, reason: 'Read-only members cannot make a key.' }));
    render(<PersonalApiKeyPanel />);
    expect(await screen.findByText('Read-only members cannot make a key.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create a key' })).not.toBeInTheDocument();
  });

  test('an expired key leaves the slot free and says when it ended', async () => {
    api.mine.mockResolvedValue(mineWith({ keys: [{ ...KEY, status: 'expired', expiresAt: '2026-11-01T19:00:00.000Z' }] }));
    render(<PersonalApiKeyPanel />);
    expect(await screen.findByRole('button', { name: 'Create a key' })).toBeInTheDocument();
    expect(screen.queryByTestId('personal-key-row')).not.toBeInTheDocument();
    expect(screen.getByText('Your key “Reply assistant” expired Nov 1, 2026.')).toBeInTheDocument();
  });

  test("the form uses the server's ability words and expiry choices when it sends them", async () => {
    api.mine.mockResolvedValue(mineWith({
      expiryOptions: [30, 90, 180, 365],
      defaultExpiryDays: 180,
      abilities: [
        { id: 'read', label: 'Read tickets and conversations', description: 'What you can see in the app.', locked: true },
        { id: 'reply', label: 'Reply to requesters and add notes', description: 'As you.', locked: false },
      ],
    }));
    render(<PersonalApiKeyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a key' }));
    const form = screen.getByRole('form', { name: 'Create a key' });
    expect(within(form).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(form).getByText('What you can see in the app.')).toBeInTheDocument();
    expect(within(form).getByLabelText('Expires after')).toHaveValue('180');
  });
});

describe('Your API key — create and the secret shown once', () => {
  test('the form: Read always on, 90 days by default, IPs one per line; the secret shows once with Copy and the warning', async () => {
    api.mine.mockResolvedValueOnce(mineWith()).mockResolvedValue(mineWith({ keys: [{ ...KEY, lastUsedAt: null, lastUsedIp: null }] }));
    api.create.mockResolvedValue({ success: true, data: { key: { ...KEY, lastUsedAt: null }, secret: 'tpu_secret_value_123' } });
    render(<PersonalApiKeyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a key' }));

    const form = screen.getByRole('form', { name: 'Create a key' });
    const read = within(form).getByRole('checkbox', { name: /Read tickets and conversations/ });
    expect(read).toBeChecked();
    expect(read).toBeDisabled();
    expect(within(form).getByRole('checkbox', { name: /Reply to requesters and add notes/ })).not.toBeChecked();
    expect(within(form).getByRole('checkbox', { name: /Update tickets/ })).not.toBeChecked();
    expect(within(form).getByRole('checkbox', { name: /Tasks and time/ })).not.toBeChecked();
    const expiry = within(form).getByLabelText('Expires after');
    expect(expiry).toHaveValue('90');
    expect([...expiry.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['30 days', '90 days', '180 days', '365 days']);
    const create = within(form).getByRole('button', { name: 'Create key' });
    expect(create).toBeDisabled(); // no name yet

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: '  Reply assistant ' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: /Reply to requesters/ }));
    fireEvent.change(expiry, { target: { value: '30' } });
    fireEvent.change(within(form).getByLabelText(/IP addresses/), { target: { value: '10.1.2.3\n\n 203.0.113.0/24 \n' } });
    fireEvent.click(create);

    await waitFor(() => expect(api.create).toHaveBeenCalledWith({
      name: 'Reply assistant',
      abilities: ['read', 'reply'],
      expiresInDays: 30,
      ipAllowlist: ['10.1.2.3', '203.0.113.0/24'],
    }));
    const secret = await screen.findByTestId('personal-key-secret');
    expect(secret).toHaveTextContent('tpu_secret_value_123');
    expect(secret).toHaveTextContent(SECRET_WARNING);
    expect(SECRET_WARNING).toBe('This key acts as you. Anyone who has it can reply to requesters in your name. Keep it secret; revoke it if it leaks.');

    fireEvent.click(within(secret).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('tpu_secret_value_123'));
    expect(await within(secret).findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    // Done drops it for good: the key row stays, the secret is nowhere.
    fireEvent.click(within(secret).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('personal-key-secret')).not.toBeInTheDocument();
    expect(screen.queryByText('tpu_secret_value_123')).not.toBeInTheDocument();
    expect(screen.getByTestId('personal-key-row')).toHaveTextContent('Reply assistant');
  });

  test('a refused create shows the server sentence and keeps the form', async () => {
    api.mine.mockResolvedValue(mineWith());
    api.create.mockRejectedValue(Object.assign(new Error('You already have a key. Rotate it instead.'), { status: 409 }));
    render(<PersonalApiKeyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a key' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a key. Rotate it instead.');
    expect(screen.getByRole('form', { name: 'Create a key' })).toBeInTheDocument();
  });
});

describe('Your API key — the key row', () => {
  test('name, what it can do in words, expiry and "2 hours ago from 10.1.2.3"; no second create', async () => {
    api.mine.mockResolvedValue(mineWith({ keys: [{ ...KEY, ipAllowlist: ['10.1.2.3'] }] }));
    render(<PersonalApiKeyPanel />);
    const row = await screen.findByTestId('personal-key-row');
    expect(row).toHaveTextContent('Reply assistant');
    expect(row).toHaveTextContent('Read tickets · Reply and add notes');
    expect(row).toHaveTextContent(/Expires .+ \(in 90 days\)/);
    expect(row).toHaveTextContent('Last used 2 hours ago from 10.1.2.3');
    expect(row).toHaveTextContent('Works only from 10.1.2.3');
    expect(screen.queryByRole('button', { name: 'Create a key' })).not.toBeInTheDocument();
  });

  test('Rotate asks in the page, then shows the new secret once', async () => {
    api.mine.mockResolvedValue(mineWith({ keys: [KEY] }));
    api.rotate.mockResolvedValue({ success: true, data: { key: { ...KEY, id: 8 }, secret: 'tpu_rotated_456' } });
    render(<PersonalApiKeyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    const ask = screen.getByRole('alertdialog', { name: 'Rotate this key?' });
    expect(ask).toHaveTextContent('The current secret stops working at once');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(api.rotate).not.toHaveBeenCalled();

    // Cancel first: nothing happens.
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.rotate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Rotate key' }));
    await waitFor(() => expect(api.rotate).toHaveBeenCalledWith(7));
    expect(await screen.findByTestId('personal-key-secret')).toHaveTextContent('tpu_rotated_456');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  test('Revoke asks in the page, then the slot is free again', async () => {
    api.mine.mockResolvedValueOnce(mineWith({ keys: [KEY] })).mockResolvedValue(mineWith({ keys: [{ ...KEY, status: 'revoked' }] }));
    api.revoke.mockResolvedValue({ success: true });
    render(<PersonalApiKeyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const ask = screen.getByRole('alertdialog', { name: 'Revoke this key?' });
    expect(ask).toHaveTextContent("Revoke “Reply assistant”? It stops working at once and anything using it fails. This can't be undone.");
    expect(window.confirm).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Revoke key' }));
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith(7));
    expect(await screen.findByRole('status')).toHaveTextContent('“Reply assistant” is revoked.');
    expect(await screen.findByRole('button', { name: 'Create a key' })).toBeInTheDocument();
  });

  test('a key an admin switched off says so and offers Revoke only', async () => {
    api.mine.mockResolvedValue(mineWith({ keys: [{ ...KEY, status: 'disabled' }] }));
    render(<PersonalApiKeyPanel />);
    const row = await screen.findByTestId('personal-key-row');
    expect(row).toHaveTextContent('An admin switched this key off.');
    expect(within(row).queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});

describe('Your AI assistant guide', () => {
  test('fetches the guide; Copy puts the Markdown on the clipboard', async () => {
    api.mine.mockResolvedValue(mineWith());
    render(<PersonalApiKeyPanel />);
    const guide = await screen.findByTestId('assistant-guide');
    expect(guide).toHaveTextContent('Give this to your AI assistant so it writes replies the app can format; the app adds your signature.');
    const copy = within(guide).getByRole('button', { name: 'Copy' });
    await waitFor(() => expect(copy).toBeEnabled());
    expect(api.guide).toHaveBeenCalledTimes(1);
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(GUIDE));
    expect(await within(guide).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  test('Download saves a .md file with the server-given name', async () => {
    api.mine.mockResolvedValue(mineWith());
    const createObjectURL = vi.fn(() => 'blob:guide');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    let clicked = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { clicked = { href: this.href, download: this.download }; });
    render(<PersonalApiKeyPanel />);
    const guide = await screen.findByTestId('assistant-guide');
    const download = within(guide).getByRole('button', { name: 'Download (.md)' });
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('text/markdown;charset=utf-8');
    expect(await blob.text()).toBe(GUIDE);
    expect(clicked).toEqual({ href: 'blob:guide', download: 'ticket-pulse-api-guide.md' });
  });

  test('a failed guide read says so and offers a retry', async () => {
    api.mine.mockResolvedValue(mineWith());
    api.guide.mockRejectedValueOnce(new Error('boom'));
    render(<PersonalApiKeyPanel />);
    const guide = await screen.findByTestId('assistant-guide');
    expect(await within(guide).findByRole('alert')).toHaveTextContent('Could not load the guide.');
    expect(within(guide).getByRole('button', { name: 'Copy' })).toBeDisabled();
    fireEvent.click(within(guide).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(guide).getByRole('button', { name: 'Copy' })).toBeEnabled());
  });
});
