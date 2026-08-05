/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { OverridePromptToast, useOverridePrompt } from './OverridePrompt';

const recordOverrideReason = vi.fn().mockResolvedValue({});
vi.mock('../../services/api', () => ({
  assignmentAPI: { recordOverrideReason: (...a) => recordOverrideReason(...a) },
}));

afterEach(() => { cleanup(); recordOverrideReason.mockClear(); vi.useRealTimers(); });

describe('useOverridePrompt', () => {
  test('maybePrompt opens only when the envelope carries aiOverride and a tech was picked', () => {
    const { result } = renderHook(() => useOverridePrompt());

    act(() => result.current.maybePrompt({ success: true, data: { aiOverride: false } }, 1, 7));
    expect(result.current.prompt).toBeNull();

    // Flag absent entirely (e.g. the manual pick matched the AI's own pick).
    act(() => result.current.maybePrompt({ success: true, data: {} }, 1, 7));
    expect(result.current.prompt).toBeNull();

    // Unassignments never prompt, whatever the payload says.
    act(() => result.current.maybePrompt({ success: true, data: { aiOverride: true } }, 1, null));
    expect(result.current.prompt).toBeNull();

    act(() => result.current.maybePrompt({ success: true, data: { aiOverride: true } }, 1, 7));
    expect(result.current.prompt).toEqual({ ticketIds: [1], techId: 7 });
  });

  test('sendReason records the reason for EVERY overridden ticket (bulk aggregation)', async () => {
    const { result } = renderHook(() => useOverridePrompt());
    act(() => result.current.openPrompt([11, 12, 13], 7));
    expect(result.current.prompt).toEqual({ ticketIds: [11, 12, 13], techId: 7 });

    await act(async () => { await result.current.sendReason('load_balancing'); });

    expect(recordOverrideReason).toHaveBeenCalledTimes(3);
    expect(recordOverrideReason).toHaveBeenCalledWith(11, { toTechnicianId: 7, reasonCode: 'load_balancing' });
    expect(recordOverrideReason).toHaveBeenCalledWith(12, { toTechnicianId: 7, reasonCode: 'load_balancing' });
    expect(recordOverrideReason).toHaveBeenCalledWith(13, { toTechnicianId: 7, reasonCode: 'load_balancing' });
    expect(result.current.state).toBe('sent');
  });

  test('a failed reason POST is best-effort — the prompt still settles as sent', async () => {
    recordOverrideReason.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useOverridePrompt());
    act(() => result.current.openPrompt([21, 22], 7));

    await act(async () => { await result.current.sendReason('other'); });

    expect(recordOverrideReason).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe('sent');
  });

  test('auto-dismisses after 15s when no reason is chosen', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOverridePrompt());
    act(() => result.current.openPrompt([1], 7));
    expect(result.current.prompt).not.toBeNull();

    act(() => { vi.advanceTimersByTime(15000); });

    expect(result.current.prompt).toBeNull();
    expect(recordOverrideReason).not.toHaveBeenCalled();
  });
});

describe('OverridePromptToast', () => {
  test('single override: standard wording, chip click reports the reason code', () => {
    const onReason = vi.fn();
    render(<OverridePromptToast prompt={{ ticketIds: [1], techId: 7 }} state={null} onReason={onReason} onDismiss={() => {}} />);

    expect(screen.getByText('Why the override?')).toBeInTheDocument();
    expect(screen.getByText('helps the AI learn')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wrong skill' }));
    expect(onReason).toHaveBeenCalledWith('wrong_skill');
  });

  test('aggregated wording when several tickets were AI-routed (bulk assign)', () => {
    render(<OverridePromptToast prompt={{ ticketIds: [1, 2, 3], techId: 7 }} state={null} onReason={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('3 of these were AI-routed — why the override?')).toBeInTheDocument();
  });

  test('skip button dismisses; sent state thanks and hides the chips; null prompt renders nothing', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <OverridePromptToast prompt={{ ticketIds: [1], techId: 7 }} state={null} onReason={() => {}} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(onDismiss).toHaveBeenCalled();

    rerender(<OverridePromptToast prompt={{ ticketIds: [1], techId: 7 }} state="sent" onReason={() => {}} onDismiss={onDismiss} />);
    expect(screen.getByText(/Thanks — noted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wrong skill' })).not.toBeInTheDocument();

    rerender(<OverridePromptToast prompt={null} state={null} onReason={() => {}} onDismiss={onDismiss} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
