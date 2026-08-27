/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PromptManager from './PromptManager';
import { DIFF_MAX_CELLS, DIFF_MAX_LINES, countLines, isDiffTooLarge } from './promptDiff';
import { assignmentAPI } from '../../services/api';

// Mega 08-26 Phase PD (QA 08-25 #1 — "compare this version with live" hangs):
// the hand-rolled O(L·M) LCS + a contentEditable per row is gone. The modal now
// (1) size-guards oversized pairs behind a raw side-by-side + "Compute anyway",
// (2) renders Monaco's <DiffEditor> with original/modified, (3) fetches each
// version ONCE across identity churn, and (4) shows a visible error when a
// version fetch rejects instead of a silent all-red diff.

const { diffEditorMock } = vi.hoisted(() => ({ diffEditorMock: vi.fn() }));
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props) => {
    diffEditorMock(props);
    return (
      <div
        data-testid="monaco-diff"
        data-original={props.original}
        data-modified={props.modified}
        data-side-by-side={String(props.options?.renderSideBySide)}
        data-hide-unchanged={String(props.options?.hideUnchangedRegions?.enabled)}
        data-language={props.language}
      />
    );
  },
  default: () => null,
}));
vi.mock('react-markdown', () => ({ default: ({ children }) => <div data-testid="md">{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getPrompts: vi.fn(),
    getPrompt: vi.fn(),
    getTools: vi.fn(() => Promise.resolve({ data: [] })),
    createPrompt: vi.fn(),
    publishPrompt: vi.fn(),
    restorePrompt: vi.fn(),
    deletePrompt: vi.fn(),
  },
}));

const PUBLISHED = {
  id: 31, version: 31, status: 'published', notes: 'live',
  systemPrompt: ['# Assignment prompt', 'Route hardware to Desktop Support.', 'Route access requests to Identity.', 'Escalate outages.'].join('\n'),
  createdAt: '2026-08-01T00:00:00Z',
};
const DRAFT = {
  id: 32, version: 32, status: 'draft', notes: 'LLM rewrite',
  systemPrompt: PUBLISHED.systemPrompt.split('\n').map((line) => `${line} .`).join('\n'),
  createdAt: '2026-08-20T00:00:00Z',
};
const VERSIONS = [DRAFT, PUBLISHED];

const makeLines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

beforeEach(() => {
  assignmentAPI.getPrompts.mockResolvedValue({ data: { versions: VERSIONS, published: PUBLISHED } });
  assignmentAPI.getPrompt.mockImplementation((id) => Promise.resolve({ data: VERSIONS.find((v) => v.id === Number(id)) || null }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderLoaded() {
  render(<PromptManager />);
  await waitFor(() => expect(screen.getByText('Version History')).toBeInTheDocument());
}

const compareButtons = () => screen.getAllByTitle('Compare this version with live');
const dialog = () => screen.getByRole('dialog', { name: /Prompt Diff/ });

describe('promptDiff size guard (PD1)', () => {
  test('countLines handles empty, LF and CRLF input', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('a\r\nb')).toBe(2);
  });

  test('flags either side past the line cap or a pair past the cell cap', () => {
    expect(isDiffTooLarge(makeLines(10), makeLines(12))).toBe(false);
    expect(isDiffTooLarge(makeLines(DIFF_MAX_LINES), makeLines(DIFF_MAX_LINES))).toBe(true); // 1500² > 2e6
    expect(isDiffTooLarge(makeLines(DIFF_MAX_LINES + 1), '')).toBe(true);
    expect(isDiffTooLarge(makeLines(1400), makeLines(1400))).toBe(false); // 1.96e6 cells, under both caps
    expect(isDiffTooLarge(makeLines(1000), makeLines(1200))).toBe(false); // 1.2e6
    expect(isDiffTooLarge(makeLines(1000), makeLines(DIFF_MAX_CELLS / 1000 + 1))).toBe(true);
  });

  test('2×3000 lines is decided instantly (no DP matrix)', () => {
    const big = makeLines(3000, 'prompt');
    const started = performance.now();
    expect(isDiffTooLarge(big, `${big}\nextra`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('PromptDiffModal on Monaco (PD2)', () => {
  test('"Compare this version with live" mounts a DiffEditor with the live prompt as original and the version as modified', async () => {
    await renderLoaded();
    fireEvent.click(compareButtons()[0]); // v32 row (versions are newest-first)
    const diff = await within(dialog()).findByTestId('monaco-diff');
    expect(diff.dataset.original).toBe(PUBLISHED.systemPrompt);
    expect(diff.dataset.modified).toBe(DRAFT.systemPrompt);
    expect(diff.dataset.language).toBe('markdown');
    expect(diff.dataset.hideUnchanged).toBe('true');
    expect(diff.dataset.sideBySide).toBe('true');
    // Base/compare selectors reflect the pair.
    expect(within(dialog()).getByLabelText('Base')).toHaveValue(`version:${PUBLISHED.id}`);
    expect(within(dialog()).getByLabelText('Compare')).toHaveValue(`version:${DRAFT.id}`);
    // No contenteditable hosts anywhere — the per-row editors are gone.
    expect(dialog().querySelectorAll('[contenteditable]')).toHaveLength(0);
  });

  test('Split / Unified toggle maps to Monaco renderSideBySide without remounting', async () => {
    await renderLoaded();
    fireEvent.click(compareButtons()[0]);
    const diff = await within(dialog()).findByTestId('monaco-diff');
    expect(diff.dataset.sideBySide).toBe('true');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Unified' }));
    expect(within(dialog()).getByTestId('monaco-diff').dataset.sideBySide).toBe('false');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Split' }));
    expect(within(dialog()).getByTestId('monaco-diff').dataset.sideBySide).toBe('true');
  });

  test('"Diff editor vs live" compares the editor draft (current) against the live prompt', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Diff editor vs live/ }));
    const diff = await within(dialog()).findByTestId('monaco-diff');
    expect(within(dialog()).getByLabelText('Base')).toHaveValue(`version:${PUBLISHED.id}`);
    expect(within(dialog()).getByLabelText('Compare')).toHaveValue('current');
    // The editor was seeded with the published prompt, so both sides match.
    expect(diff.dataset.original).toBe(PUBLISHED.systemPrompt);
    expect(diff.dataset.modified).toBe(PUBLISHED.systemPrompt);
    // The live prompt never needs a fetch — it came with GET /prompts.
    expect(assignmentAPI.getPrompt).not.toHaveBeenCalled();
  });

  test('Apply to editor loads the compare side into the main editor and closes the modal', async () => {
    await renderLoaded();
    fireEvent.click(compareButtons()[0]);
    await within(dialog()).findByTestId('monaco-diff');
    fireEvent.click(within(dialog()).getByRole('button', { name: /Apply to editor/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Prompt Diff/ })).not.toBeInTheDocument());
    expect(screen.getAllByPlaceholderText('Enter the assignment system prompt here...')[0]).toHaveValue(DRAFT.systemPrompt);
    expect(screen.getByText('Loaded diff edits into editor')).toBeInTheDocument();
  });
});

describe('size guard in the modal (PD1)', () => {
  test('2×3000-line pair renders the raw side-by-side fallback instantly; Compute anyway mounts Monaco', async () => {
    const bigLive = { ...PUBLISHED, systemPrompt: makeLines(3000, 'live') };
    const bigDraft = { ...DRAFT, systemPrompt: makeLines(3000, 'draft') };
    assignmentAPI.getPrompts.mockResolvedValue({ data: { versions: [bigDraft, bigLive], published: bigLive } });
    assignmentAPI.getPrompt.mockResolvedValue({ data: bigDraft });
    await renderLoaded();

    const started = performance.now();
    fireEvent.click(compareButtons()[0]);
    const guard = await within(dialog()).findByTestId('diff-size-guard');
    expect(performance.now() - started).toBeLessThan(1500);
    expect(guard).toHaveTextContent(/too large for a line-by-line diff/);
    expect(guard).toHaveTextContent(/3,000 vs 3,000 lines/);
    expect(within(dialog()).queryByTestId('monaco-diff')).not.toBeInTheDocument();
    // Raw text is shown on both sides.
    const pres = guard.querySelectorAll('pre');
    expect(pres).toHaveLength(2);
    expect(pres[0].textContent).toContain('live 3000');
    expect(pres[1].textContent).toContain('draft 3000');

    fireEvent.click(within(guard).getByRole('button', { name: /Compute anyway/ }));
    const diff = await within(dialog()).findByTestId('monaco-diff');
    expect(diff.dataset.original).toBe(bigLive.systemPrompt);
    expect(diff.dataset.modified).toBe(bigDraft.systemPrompt);
    expect(within(dialog()).queryByTestId('diff-size-guard')).not.toBeInTheDocument();
  });

  test('a normal-size pair never shows the guard', async () => {
    await renderLoaded();
    fireEvent.click(compareButtons()[0]);
    await within(dialog()).findByTestId('monaco-diff');
    expect(within(dialog()).queryByTestId('diff-size-guard')).not.toBeInTheDocument();
  });
});

describe('fetch-once + error state (PD3)', () => {
  test('a version is fetched exactly once across selector churn, mode toggles and reopen', async () => {
    await renderLoaded();
    fireEvent.click(compareButtons()[0]);
    await within(dialog()).findByTestId('monaco-diff');
    expect(assignmentAPI.getPrompt).toHaveBeenCalledTimes(1);
    expect(assignmentAPI.getPrompt).toHaveBeenCalledWith(DRAFT.id);

    // Identity churn: toggle modes, flip the selectors away and back.
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Unified' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Split' }));
    fireEvent.change(within(dialog()).getByLabelText('Compare'), { target: { value: 'current' } });
    await within(dialog()).findByTestId('monaco-diff');
    fireEvent.change(within(dialog()).getByLabelText('Compare'), { target: { value: `version:${DRAFT.id}` } });
    await waitFor(() => expect(within(dialog()).getByTestId('monaco-diff').dataset.modified).toBe(DRAFT.systemPrompt));
    fireEvent.change(within(dialog()).getByLabelText('Base'), { target: { value: `version:${DRAFT.id}` } });
    await waitFor(() => expect(within(dialog()).getByTestId('monaco-diff').dataset.original).toBe(DRAFT.systemPrompt));
    expect(assignmentAPI.getPrompt).toHaveBeenCalledTimes(1);

    // Close, reopen the same version: the parent cache serves it.
    fireEvent.click(within(dialog()).getByRole('button', { name: /Close/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Prompt Diff/ })).not.toBeInTheDocument());
    fireEvent.click(compareButtons()[0]);
    await within(dialog()).findByTestId('monaco-diff');
    expect(assignmentAPI.getPrompt).toHaveBeenCalledTimes(1);
  });

  test('concurrent requests for the same version share one GET (in-flight dedupe)', async () => {
    let release;
    assignmentAPI.getPrompt.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ data: DRAFT }); }));
    await renderLoaded();
    fireEvent.click(compareButtons()[0]);
    // While the first GET is pending, make the base ALSO point at v32 → second resolve for the same id.
    fireEvent.change(await within(dialog()).findByLabelText('Base'), { target: { value: `version:${DRAFT.id}` } });
    expect(assignmentAPI.getPrompt).toHaveBeenCalledTimes(1);
    release();
    await within(dialog()).findByTestId('monaco-diff');
    expect(assignmentAPI.getPrompt).toHaveBeenCalledTimes(1);
  });

  test('a rejected version fetch shows "Could not load version N" instead of a silent all-red diff', async () => {
    assignmentAPI.getPrompt.mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
    await renderLoaded();
    fireEvent.click(compareButtons()[0]);
    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load version 32/);
    expect(within(dialog()).queryByTestId('monaco-diff')).not.toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /Apply to editor/ })).toBeDisabled();

    // Switching to a loadable pair recovers.
    fireEvent.change(within(dialog()).getByLabelText('Compare'), { target: { value: 'current' } });
    await within(dialog()).findByTestId('monaco-diff');
    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a 404 (null body) on the version is also a visible error', async () => {
    assignmentAPI.getPrompt.mockResolvedValue({ data: null });
    await renderLoaded();
    fireEvent.click(compareButtons()[0]);
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(/Could not load version 32/);
  });
});
