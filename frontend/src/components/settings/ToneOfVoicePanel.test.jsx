/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }));
const requesterSearch = vi.hoisted(() => vi.fn());

vi.mock('../../services/api', () => ({
  default: apiMock,
  ticketsAPI: { requesterSearch },
}));

import ToneOfVoicePanel from './ToneOfVoicePanel';
import { LlmDiagnosticsList } from './NotificationWorkflowsPanel';

const body = (data) => Promise.resolve({ success: true, data });
const SETTINGS = {
  defaultVoice: 'friendly',
  seriousToneText: 'Default text.',
  defaultSeriousToneText: 'Default text.',
  seriousToneTextIsDefault: true,
  seriousWhenFrustrated: true,
};
let contacts;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  contacts = [{ id: 1, email: 'pat@example.com', name: 'Pat Doe', note: 'asked for it' }];
  apiMock.get.mockImplementation((url) => (url === '/tone/settings' ? body(SETTINGS) : body(contacts)));
  apiMock.put.mockImplementation((_url, data) => body({ ...SETTINGS, ...data }));
  apiMock.post.mockImplementation((url, data) => {
    if (url === '/tone/contacts') {
      contacts = [...contacts, { id: 2, email: data.email, name: data.name, note: data.note }];
      return body(contacts[contacts.length - 1]);
    }
    return body({ voice: 'professional', workspaceVoice: 'friendly', override: { reason: 'straight_talk_list', text: 'x' }, illustration: { before: 'Hi!', after: 'Hello.' } });
  });
  apiMock.delete.mockImplementation(() => body({ removed: 1 }));
  requesterSearch.mockResolvedValue({ success: true, data: { requesters: [{ id: 9, name: 'Sam Lee', email: 'sam@example.com', jobTitle: 'Engineer' }], directory: [] } });
});

describe('ToneOfVoicePanel', () => {
  test('shows the Straight-Talk List with names and its explainer', async () => {
    render(<ToneOfVoicePanel />);
    expect(await screen.findByText('Pat Doe')).toBeInTheDocument();
    expect(screen.getByText('Straight-Talk List')).toBeInTheDocument();
    expect(screen.getByText(/always get a plain, professional reply/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Friendly/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('adds a person found by search, with a note', async () => {
    render(<ToneOfVoicePanel />);
    await screen.findByText('Pat Doe');
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'sam' } });
    fireEvent.click(await screen.findByRole('option', { name: /Sam Lee/ }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'prefers formal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/tone/contacts', { email: 'sam@example.com', name: 'Sam Lee', note: 'prefers formal' }));
    const list = await screen.findByRole('list', { name: 'Straight-Talk List' });
    expect(await within(list).findByText('Sam Lee')).toBeInTheDocument();
  });

  test('removes a person', async () => {
    render(<ToneOfVoicePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Pat Doe' }));
    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith('/tone/contacts/1'));
    await waitFor(() => expect(screen.queryByText('Pat Doe')).not.toBeInTheDocument());
  });

  test('saves the voice and the frustration toggle; resets the text', async () => {
    render(<ToneOfVoicePanel />);
    await screen.findByText('Pat Doe');
    fireEvent.click(screen.getByRole('radio', { name: /^Professional/ }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/tone/settings', { defaultVoice: 'professional' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /seems frustrated/ }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/tone/settings', { seriousWhenFrustrated: false }));
    fireEvent.change(screen.getByLabelText('Professional tone text'), { target: { value: 'Keep it formal.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/tone/settings', { seriousToneText: 'Keep it formal.' }));
  });

  test('checks a person', async () => {
    render(<ToneOfVoicePanel />);
    await screen.findByText('Pat Doe');
    // A person picker (avatar + name), not a bare e-mail box; picking runs the check.
    requesterSearch.mockResolvedValue({ data: { requesters: [{ name: 'Pat Doe', email: 'pat@example.com' }], directory: [] } });
    fireEvent.change(screen.getByLabelText('Person to check'), { target: { value: 'pat' } });
    fireEvent.click(await screen.findByRole('option', { name: /Pat Doe/ }));
    expect(await screen.findByTestId('tone-check-person')).toHaveTextContent('Pat Doe');
    const result = await screen.findByTestId('tone-check-result');
    expect(result).toHaveTextContent('Professional tone — on the Straight-Talk List');
    expect(apiMock.post).toHaveBeenCalledWith('/tone/preview', { email: 'pat@example.com' });
  });
});

describe('run audit tone line', () => {
  test('says why the professional tone was used', () => {
    render(<LlmDiagnosticsList diagnostics={[{ nodeId: 'llm', llm: { promptPolicy: { source: 'backend_default_system_prompt', toneOverride: { reason: 'frustrated' } }, guardPolicy: { mode: 'professional_tiered_policy', toneMode: 'professional' } } }]} />);
    expect(screen.getByTestId('llm-tone-override')).toHaveTextContent('Professional tone used — requester seemed frustrated');
  });
});
