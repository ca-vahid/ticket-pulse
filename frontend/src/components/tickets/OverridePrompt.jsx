import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Sparkles, X } from 'lucide-react';
import { assignmentAPI } from '../../services/api';

/**
 * Correction feedback loop for the AI assignment pipeline: when a manual pick
 * overrides a completed AI decision (the assign/fs-update payload carries
 * `aiOverride: true`), ask — one click, skippable, never a gate — why, so the
 * assignment LLM can learn. Shared by AssigneePicker (desktop), the mobile
 * assign sheet, and the queue's bulk-assign bar (aggregated: one prompt, the
 * chosen reason recorded for every overridden ticket).
 */

export const OVERRIDE_REASONS = [
  ['wrong_skill', 'Wrong skill'],
  ['load_balancing', 'Load balancing'],
  ['availability', 'Availability'],
  ['other', 'Other'],
];

export function useOverridePrompt() {
  const [prompt, setPrompt] = useState(null); // { ticketIds: number[], techId } | null
  const [state, setState] = useState(null); // 'sent' | null

  const dismiss = useCallback(() => { setPrompt(null); setState(null); }, []);

  // Open the prompt for one or many tickets that were just manually assigned
  // over an AI decision (bulk assign applies one tech to every target).
  const openPrompt = useCallback((ticketIds, techId) => {
    const ids = (Array.isArray(ticketIds) ? ticketIds : [ticketIds]).filter((id) => id != null);
    if (ids.length === 0 || techId == null) return;
    setState(null);
    setPrompt({ ticketIds: ids, techId });
  }, []);

  // Single-assign convenience: inspect the {success, data} envelope the assign
  // endpoints resolve with (native assign and FS write-back share the shape).
  const maybePrompt = useCallback((res, ticketId, techId) => {
    if (techId != null && res?.data?.aiOverride) openPrompt([ticketId], techId);
  }, [openPrompt]);

  // Auto-dismiss — it's an optional nicety, never a gate on the assignment
  // (which already went through).
  useEffect(() => {
    if (!prompt || state === 'sent') return undefined;
    const timer = setTimeout(() => { setPrompt(null); setState(null); }, 15000);
    return () => clearTimeout(timer);
  }, [prompt, state]);

  const sendReason = useCallback(async (reasonCode) => {
    if (!prompt || state === 'sent') return;
    const { ticketIds, techId } = prompt;
    setState('sent');
    // Best-effort per ticket — the assignments themselves already succeeded.
    await Promise.allSettled(ticketIds.map((id) => (
      assignmentAPI.recordOverrideReason(id, { toTechnicianId: techId, reasonCode })
    )));
    setTimeout(() => { setPrompt(null); setState(null); }, 1800);
  }, [prompt, state]);

  return { prompt, state, openPrompt, maybePrompt, sendReason, dismiss };
}

export function OverridePromptToast({ prompt, state, onReason, onDismiss }) {
  if (!prompt) return null;
  const count = prompt.ticketIds.length;
  return createPortal(
    <div
      role="status"
      className="fixed bottom-4 right-4 z-[70] w-80 tp-card rounded-xl shadow-soft p-3 animate-slide-in-right"
    >
      {state === 'sent' ? (
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
          <Check className="w-4 h-4 flex-shrink-0" aria-hidden="true" /> Thanks — noted
        </p>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <span className="h-6 w-6 rounded-full bg-violet-100 text-violet-600 inline-flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-3 h-3" aria-hidden="true" />
            </span>
            <p className="flex-1 min-w-0 text-sm font-medium text-slate-700 leading-tight">
              {count > 1 ? `${count} of these were AI-routed — why the override?` : 'Why the override?'}
              <span className="block text-[11px] font-normal text-slate-400">helps the AI learn</span>
            </p>
            <button
              onClick={onDismiss}
              aria-label="Skip — don't record a reason"
              title="Skip"
              className="tp-focus-ring h-6 w-6 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-50 flex-shrink-0"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {OVERRIDE_REASONS.map(([code, label]) => (
              <button
                key={code}
                onClick={() => onReason(code)}
                className="tp-focus-ring px-2.5 py-1 rounded-full border border-violet-200 bg-violet-50/60 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
