/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// 30 Sep 2026: Knowledge → Settings → Prompts and E-mail signature.
const api = {
  listPrompts: vi.fn(),
  previewPrompt: vi.fn(async (key, body) => ({ data: { fullPrompt: `FULL(${key}): ${body}` } })),
  createPrompt: vi.fn(async () => ({ data: { id: 41 } })),
  publishPrompt: vi.fn(async () => ({ data: {} })),
  getPrompt: vi.fn(),
  restorePrompt: vi.fn(),
  deletePrompt: vi.fn(),
  useDefaultPrompt: vi.fn(),
};
vi.mock('../../services/api', () => ({ get knowledgeAPI() { return api; } }));
vi.mock('../assignment/PromptManager', () => ({ PromptDiffModal: () => <div data-testid="diff-modal" /> }));
vi.mock('../tickets/RichTextEditor', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange({ html: e.target.value, text: e.target.value.replace(/<[^>]+>/g, '') })} />
  ),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

const { default: AutoHelpPromptsSettings } = await import('./AutoHelpPromptsSettings');
const { default: AutoHelpSignatureSettings } = await import('./AutoHelpSignatureSettings');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const PROMPTS = [
  { key: 'answer', title: 'Answer writing', hint: 'Voice.', defaultBody: 'Write for the requester.', activeBody: 'Be warm.', published: { id: 7, version: 2, publishedAt: null }, versions: [{ id: 7, version: 2, status: 'published', body: 'Be warm.', createdAt: '2026-09-30T10:00:00Z' }, { id: 6, version: 1, status: 'archived', body: 'Old.', createdAt: '2026-09-29T10:00:00Z' }], fullPrompt: 'FULL' },
  { key: 'route', title: 'Playbook choice', hint: 'Choice.', defaultBody: 'Pick.', activeBody: 'Pick.', published: null, versions: [], fullPrompt: 'FULL route' },
  { key: 'check', title: 'Answer check', hint: 'Check.', defaultBody: 'Be strict.', activeBody: 'Be strict.', published: null, versions: [], fullPrompt: 'FULL check' },
];

describe('Prompts', () => {
  test('shows the live guidance, the full prompt and the versions; save and publish makes a new live version', async () => {
    api.listPrompts.mockResolvedValue({ data: PROMPTS });
    render(<MemoryRouter><AutoHelpPromptsSettings canManage /></MemoryRouter>);
    const box = await screen.findByTestId('auto-help-prompts');
    const editor = within(box).getByLabelText('Guidance you can edit');
    expect(editor).toHaveValue('Be warm.');
    expect(within(box).getByTestId('prompt-versions')).toHaveTextContent('v2Live');
    fireEvent.change(editor, { target: { value: 'Be warm and brief.' } });
    await waitFor(() => expect(within(box).getByTestId('full-prompt')).toHaveTextContent('FULL(answer): Be warm and brief.'));
    fireEvent.change(within(box).getByLabelText('Version note'), { target: { value: 'shorter' } });
    fireEvent.click(within(box).getByRole('button', { name: /Save and publish/ }));
    await waitFor(() => expect(api.publishPrompt).toHaveBeenCalledWith(41));
    expect(api.createPrompt).toHaveBeenCalledWith({ key: 'answer', body: 'Be warm and brief.', notes: 'shorter' });
  });

  test('switching prompts shows each one; compare opens the diff window; read-only for non-managers', async () => {
    api.listPrompts.mockResolvedValue({ data: PROMPTS });
    render(<MemoryRouter><AutoHelpPromptsSettings canManage={false} /></MemoryRouter>);
    const box = await screen.findByTestId('auto-help-prompts');
    fireEvent.click(within(box).getByRole('tab', { name: 'Playbook choice' }));
    expect(within(box).getByLabelText('Guidance you can edit')).toHaveValue('Pick.');
    expect(within(box).getByText(/Live: the built-in default/)).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: /Save and publish/ })).not.toBeInTheDocument();
    fireEvent.click(within(box).getByRole('tab', { name: 'Answer writing' }));
    fireEvent.click(within(box).getAllByRole('button', { name: 'Compare' })[0]);
    expect(await screen.findByTestId('diff-modal')).toBeInTheDocument();
  });
});

describe('E-mail signature', () => {
  const settings = { signatureEnabled: true, signatureHtml: '<p>IT Desk</p>', signatureText: 'IT Desk', signatureSpacing: 'tight', signatureWith: 'replace' };

  test('previews the signature and saves the pasted text, spacing and the agent rule', async () => {
    const save = vi.fn(async () => true);
    render(<AutoHelpSignatureSettings settings={settings} canManage busy={false} save={save} />);
    expect(screen.getByTestId('auto-help-signature-preview')).toHaveTextContent('IT Desk');
    fireEvent.change(screen.getByLabelText('Auto-help signature editor'), { target: { value: '<p>IT Service Desk</p>' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Relaxed' }));
    fireEvent.click(screen.getByRole('radio', { name: /Add their own signature after this one/ }));
    expect(screen.getByTestId('auto-help-signature-preview')).toHaveTextContent('then the sending agent’s own signature');
    fireEvent.click(screen.getByRole('button', { name: 'Save signature' }));
    expect(save).toHaveBeenCalledWith({ signatureHtml: '<p>IT Service Desk</p>', signatureText: 'IT Service Desk', signatureSpacing: 'relaxed', signatureWith: 'both' });
  });

  test('switching it on or off saves at once', () => {
    const save = vi.fn(async () => true);
    render(<AutoHelpSignatureSettings settings={{ ...settings, signatureEnabled: false }} canManage busy={false} save={save} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Add a signature to Auto-help answers' }));
    expect(save).toHaveBeenCalledWith({ signatureEnabled: true });
  });
});
