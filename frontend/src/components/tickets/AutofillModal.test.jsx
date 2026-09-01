/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AutofillModal, { confidenceTier, matchByName } from './AutofillModal';
import { ticketsAPI } from '../../services/api';

// Mega 08-31 Phase AF — the Autofill intake modal: paste/drop screenshots,
// caps enforced client-side with live counters, submit → per-field review rows
// with confidence chips, and the 429/503 copy the agent actually sees.

vi.mock('../../services/api', () => ({
  ticketsAPI: { autofillExtract: vi.fn() },
}));
// Canvas isn't implemented in jsdom — the downscale is identity here.
vi.mock('../../utils/imageDownscale', () => ({
  downscaleAll: vi.fn(async (files) => Array.from(files)),
}));
vi.mock('./ImageMarkupModal', () => ({
  default: ({ file, onCancel }) => (
    <div data-testid="markup-modal">editing {file.name}<button type="button" onClick={onCancel}>close markup</button></div>
  ),
}));

const RESULT = {
  subject: 'Laptop won’t boot after Windows update',
  description: 'User reports a blue screen on boot since this morning’s update. Tried restarting twice.',
  requesterNameOrEmail: 'jane.doe@acme.com',
  categoryHint: 'Hardware',
  priorityHint: 3,
  typeHint: 'Incident',
  peopleMentioned: [{ name: 'Sam Manager', email: 'sam@acme.com', role: 'manager' }],
  sourceSummary: 'forwarded Outlook email + 2 screenshots',
  confidence: { subject: 0.92, description: 0.8, requester: 0.6, category: 0.3, priority: 0.55, type: 0.7 },
};
const okResponse = (data = RESULT) => ({ data: { success: true, data, meta: { provider: 'anthropic', model: 'claude-sonnet-5', imageCount: 2, textChars: 120 } } });
const httpError = (status, message) => Object.assign(new Error(message || `HTTP ${status}`), { response: { status, data: { message } } });

// Real bytes (not a faked .size) — the modal re-wraps pasted blobs under a
// stable name, so the caps must hold against what actually gets staged.
const imageFile = (name = 'shot.png', size = 1024) => new File([new Uint8Array(Math.round(size))], name, { type: 'image/png' });
const pasteImage = (editor, file) => {
  fireEvent.paste(editor, {
    clipboardData: {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
      getData: () => '',
    },
  });
};
// jsdom implements neither innerText nor execCommand — shim both (mirrors
// RichTextEditor.paste.test.jsx).
const shimEditor = (editor) => {
  Object.defineProperty(editor, 'innerText', { get: () => editor.textContent });
  document.execCommand = vi.fn((cmd, _ui, val) => {
    if (cmd === 'insertHTML') editor.innerHTML += val;
    return true;
  });
};
const typeText = (editor, text) => {
  editor.innerHTML = `<p>${text}</p>`;
  fireEvent.input(editor);
};

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:thumb');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete document.execCommand;
});

function renderModal(props = {}) {
  const onClose = vi.fn();
  const onApply = vi.fn();
  render(<AutofillModal open onClose={onClose} onApply={onApply} {...props} />);
  const editor = screen.getByRole('textbox', { name: 'Pasted source material' });
  shimEditor(editor);
  return { onClose, onApply, editor };
}
const submitButton = () => screen.getByRole('button', { name: /Read & propose fields/ });

describe('helpers', () => {
  test('confidenceTier buckets 0..1 into high / medium / low', () => {
    expect(confidenceTier(0.9)).toBe('high');
    expect(confidenceTier(0.75)).toBe('high');
    expect(confidenceTier(0.5)).toBe('medium');
    expect(confidenceTier(0.49)).toBe('low');
    expect(confidenceTier(undefined)).toBe('low');
  });
  test('matchByName is case-insensitive and returns the canonical name', () => {
    expect(matchByName(' hardware ', ['Hardware', 'Accounts'])).toBe('Hardware');
    expect(matchByName('Printers', ['Hardware'])).toBeNull();
    expect(matchByName(null, ['Hardware'])).toBeNull();
  });
});

describe('AutofillModal — compose zone', () => {
  test('is an accessible dialog: role, label, Escape closes', () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole('dialog', { name: 'Autofill from a paste' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('pasting an image stages a thumbnail, bumps the counter and drops a caret reference', () => {
    const { editor } = renderModal();
    expect(screen.getByText('0 / 6 images')).toBeInTheDocument();
    pasteImage(editor, imageFile('clip.png', 2048));
    expect(screen.getByRole('img', { name: 'screenshot-1.png' })).toBeInTheDocument();
    expect(screen.getByText('1 / 6 images')).toBeInTheDocument();
    expect(document.execCommand).toHaveBeenCalledWith('insertHTML', false, expect.stringContaining('screenshot-1.png'));
    // Redact-before-send copy is right next to the strip.
    expect(screen.getByText(/Blur or crop anything sensitive before sending/)).toBeInTheDocument();
    // Submit is now enabled (images alone are material).
    expect(submitButton()).not.toBeDisabled();
  });

  test('dropping image files onto the paste zone stages them too', () => {
    renderModal();
    const zone = screen.getByTestId('autofill-dropzone');
    fireEvent.drop(zone, { dataTransfer: { files: [imageFile('a.png'), imageFile('b.jpg')] } });
    expect(screen.getByText('2 / 6 images')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'screenshot-1.png' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'screenshot-2.png' })).toBeInTheDocument();
  });

  test('a screenshot over 5 MB is rejected with a message and nothing is staged', () => {
    const { editor } = renderModal();
    pasteImage(editor, imageFile('huge.png', 6 * 1024 * 1024));
    expect(screen.getByRole('alert')).toHaveTextContent(/each screenshot must be under 5\.0 MB/);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('0 / 6 images')).toBeInTheDocument();
  });

  test('the seventh image is refused — cap is 6', () => {
    const { editor } = renderModal();
    for (let i = 0; i < 7; i += 1) pasteImage(editor, imageFile(`s${i}.png`));
    expect(screen.getAllByRole('img')).toHaveLength(6);
    expect(screen.getByRole('alert')).toHaveTextContent(/Up to 6 screenshots/);
  });

  test('images over 20 MB in total are refused', () => {
    const { editor } = renderModal();
    for (let i = 0; i < 4; i += 1) pasteImage(editor, imageFile(`s${i}.png`, 4.9 * 1024 * 1024));
    pasteImage(editor, imageFile('last.png', 4.9 * 1024 * 1024));
    expect(screen.getAllByRole('img')).toHaveLength(4);
    expect(screen.getByRole('alert')).toHaveTextContent(/past 20.0 MB in total/);
  });

  test('clicking a thumbnail opens the markup editor for redaction before send', () => {
    const { editor } = renderModal();
    pasteImage(editor, imageFile('clip.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit screenshot-1.png' }));
    expect(screen.getByTestId('markup-modal')).toHaveTextContent('editing screenshot-1.png');
    fireEvent.click(screen.getByText('close markup'));
    expect(screen.queryByTestId('markup-modal')).not.toBeInTheDocument();
  });

  test('over the 20 000-character cap the counter turns red and submit is disabled', () => {
    const { editor } = renderModal();
    typeText(editor, 'x'.repeat(20001));
    expect(screen.getByText(/20,001 \/ 20,000 characters/)).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });
});

describe('AutofillModal — extract + review', () => {
  test('submit shows the loading state, then one row per field with confidence chips; low rows start unticked', async () => {
    let resolve;
    ticketsAPI.autofillExtract.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { editor } = renderModal();
    typeText(editor, 'Hi IT, my laptop bluescreens since the update. — Jane');
    pasteImage(editor, imageFile('clip.png'));
    fireEvent.click(submitButton());

    expect(await screen.findByText('Reading your paste…')).toBeInTheDocument();
    expect(ticketsAPI.autofillExtract).toHaveBeenCalledTimes(1);
    const [sentText, sentImages] = ticketsAPI.autofillExtract.mock.calls[0];
    expect(sentText).toContain('laptop bluescreens');
    expect(sentImages).toHaveLength(1);

    await act(async () => { resolve(okResponse()); });
    expect(await screen.findByTestId('autofill-source-summary')).toHaveTextContent('Looks like: forwarded Outlook email + 2 screenshots');

    const rows = within(screen.getByRole('list', { name: 'Proposed fields' })).getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(screen.getByTestId('autofill-row-subject-confidence')).toHaveTextContent('high');
    expect(screen.getByTestId('autofill-row-priority-confidence')).toHaveTextContent('medium');
    expect(screen.getByTestId('autofill-row-category-confidence')).toHaveTextContent('low');
    expect(screen.getByLabelText('Subject')).toBeChecked();
    expect(screen.getByLabelText('Priority')).toBeChecked();
    expect(screen.getByLabelText('Category')).not.toBeChecked();
    expect(screen.getByText('High (P3)')).toBeInTheDocument();
    expect(screen.getByTestId('autofill-people')).toHaveTextContent('Sam Manager <sam@acme.com> (manager)');
  });

  test('Apply hands back only the ticked fields plus the raw paste and the ORIGINAL files', async () => {
    ticketsAPI.autofillExtract.mockResolvedValue(okResponse());
    const { editor, onApply } = renderModal();
    typeText(editor, 'some paste');
    const original = imageFile('clip.png');
    pasteImage(editor, original);
    fireEvent.click(submitButton());
    await screen.findByTestId('autofill-source-summary');

    // Agent unticks Priority and ticks the low-confidence Category on purpose.
    fireEvent.click(screen.getByLabelText('Priority'));
    fireEvent.click(screen.getByLabelText('Category'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to form' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const payload = onApply.mock.calls[0][0];
    expect(payload.selected).toEqual({ subject: true, description: true, requester: true, category: true, type: true });
    expect(payload.result.subject).toBe(RESULT.subject);
    expect(payload.sourceText).toContain('some paste');
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toBe('screenshot-1.png');
  });

  test('locked fields and unmatched hints render as kept/skipped rows and stay unticked + disabled', async () => {
    ticketsAPI.autofillExtract.mockResolvedValue(okResponse({ ...RESULT, categoryHint: 'Printers', confidence: { ...RESULT.confidence, category: 0.95 } }));
    const { editor } = renderModal({ lockedFields: ['subject'], categoryNames: ['Hardware', 'Accounts'], typeNames: ['Incident'] });
    typeText(editor, 'paste');
    fireEvent.click(submitButton());
    await screen.findByTestId('autofill-source-summary');

    expect(screen.getByLabelText('Subject')).toBeDisabled();
    expect(screen.getByLabelText('Subject')).not.toBeChecked();
    expect(screen.getByText('You already filled this in — kept as is.')).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeDisabled();
    expect(screen.getByText('No matching category in this workspace — skipped.')).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toBeChecked();
  });

  test('Back returns to the paste with the material intact', async () => {
    ticketsAPI.autofillExtract.mockResolvedValue(okResponse());
    const { editor } = renderModal();
    typeText(editor, 'keep me');
    pasteImage(editor, imageFile('clip.png'));
    fireEvent.click(submitButton());
    await screen.findByTestId('autofill-source-summary');
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByRole('textbox', { name: 'Pasted source material' })).toBeInTheDocument();
    expect(screen.getByText('1 / 6 images')).toBeInTheDocument();
  });

  test('429 → "Slow down" copy, back on the compose step', async () => {
    ticketsAPI.autofillExtract.mockRejectedValue(httpError(429, 'Too many requests'));
    const { editor } = renderModal();
    typeText(editor, 'paste');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Slow down — try again in a minute.'));
    expect(screen.getByRole('textbox', { name: 'Pasted source material' })).toBeInTheDocument();
  });

  test('503 → points at Settings → AI Providers', async () => {
    ticketsAPI.autofillExtract.mockRejectedValue(httpError(503, 'No AI provider'));
    const { editor } = renderModal();
    typeText(editor, 'paste');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No AI provider configured for this workspace — Settings → AI Providers.'));
  });

  test('400 surfaces the server’s cap message', async () => {
    ticketsAPI.autofillExtract.mockRejectedValue(httpError(400, 'Text exceeds 20000 characters'));
    const { editor } = renderModal();
    typeText(editor, 'paste');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Text exceeds 20000 characters'));
  });
});
