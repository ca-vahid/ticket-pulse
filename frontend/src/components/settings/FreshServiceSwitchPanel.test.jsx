/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The container polls the Off job until its record is FINISHED: once the mode
// is Off the job reads done while the second adoption pass is still writing
// (no finishedAt yet), and that pass's late note must still show.

const api = vi.hoisted(() => ({
  getFreshService: vi.fn(), getFreshServiceOff: vi.fn(), setFreshServiceMode: vi.fn(), startFreshServiceOff: vi.fn(),
}));
vi.mock('../../services/api', () => ({ workspaceAPI: api }));

const { default: FreshServiceSwitchPanel } = await import('./FreshServiceSwitchPanel');

const WS = { id: 5, name: 'Project Accounting' };
const base = (mode, job) => ({ data: { workspace: WS, mode, record: { mode, history: [] }, shadow: null, preflight: null, job, canWrite: true } });

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('FreshServiceSwitchPanel polling', () => {
  test('keeps polling past "done" until finishedAt is set, then shows the late note', async () => {
    const running = { state: 'running', step: 'adopt', total: 2, done: 1, adopted: 1, failed: [] };
    const doneWriting = { state: 'done', step: 'done', total: 2, adopted: 2, failed: [], finishedAt: null };
    const finished = { ...doneWriting, finishedAt: '2026-11-25T20:00:00.000Z', note: '1 ticket that arrived during the switch could not be adopted (#900008); open it and choose Adopt to edit.' };
    api.getFreshService
      .mockResolvedValueOnce(base('shadow', running))
      .mockResolvedValue(base('off', finished));
    api.getFreshServiceOff
      .mockResolvedValueOnce({ data: doneWriting })
      .mockResolvedValueOnce({ data: finished });
    const onModeChanged = vi.fn();
    render(<MemoryRouter><FreshServiceSwitchPanel workspaceId={5} onModeChanged={onModeChanged} /></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('fs-off-progress')).toHaveAttribute('data-state', 'running');

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // → done, still writing
    expect(api.getFreshServiceOff).toHaveBeenCalledTimes(1);
    expect(onModeChanged).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // → finished
    expect(api.getFreshServiceOff).toHaveBeenCalledTimes(2);
    expect(onModeChanged).toHaveBeenCalledWith(5, 'off');
    expect(screen.getByTestId('fs-off-note-late')).toHaveTextContent('#900008');

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); // and then it stops
    expect(api.getFreshServiceOff).toHaveBeenCalledTimes(2);
  });
});
