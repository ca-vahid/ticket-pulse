import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { StatusPill } from './ticketUi';
import { CANONICAL_STATUS_NAMES, statusToneFromDefs } from './statusDefs';
import { ticketsAPI } from '../../services/api';

/**
 * Inline status dropdown for queue rows (QA 07-06 #2). Origin-aware confirm:
 *  - TP-born: a lightweight "are you sure" step inside the menu, then the
 *    normal status API.
 *  - FS-born: hands off to the page's FsSyncConfirm flow (fail-first if
 *    FreshService rejects, exactly like assignee/category write-backs).
 *
 * Status vocabulary (Phase 8b): TP-born tickets offer the workspace registry
 * (`statusDefs` from the queue meta — custom statuses included); FS-born
 * tickets (`fsChange` set, which is also how this picker knows the origin)
 * keep the canonical 4 — FreshService doesn't understand custom labels until
 * the 8c mapping. Defs absent (meta still loading) → canonical 4.
 */
export default function StatusPicker({
  ticketId,
  value,
  fsChange = null, // (nextStatus) => Promise — FS-born write-back w/ confirm modal
  onChanged, // (nextStatus, prevStatus) => void after success
  disabled = false,
  statusDefs = null, // workspace registry defs [{name, baseStatus, color, ...}]
}) {
  const options = fsChange || !statusDefs?.length
    ? CANONICAL_STATUS_NAMES
    : statusDefs.map((d) => d.name);
  const toneOf = (name) => statusToneFromDefs(statusDefs, name);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(null); // status awaiting TP confirm
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const [panelPos, setPanelPos] = useState(null);

  const place = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const PANEL_W = 176;
    const left = Math.min(rect.left, window.innerWidth - PANEL_W - 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 230 && rect.top > spaceBelow) setPanelPos({ left, bottom: window.innerHeight - rect.top + 4 });
    else setPanelPos({ left, top: rect.bottom + 4 });
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const onMove = () => place();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => { if (!open) { setConfirming(null); setPanelPos(null); } }, [open]);

  const apply = async (next) => {
    if (busy) return;
    setBusy(true);
    try {
      if (fsChange) await fsChange(next);
      else await ticketsAPI.setStatus(ticketId, next);
      setOpen(false);
      onChanged?.(next, value);
    } catch { /* cancelled or failed — refresh shows the true state */ }
    setBusy(false);
  };

  const pick = (next) => {
    if (next === value) { setOpen(false); return; }
    if (fsChange) {
      // FS-born: the FsSyncConfirm modal IS the confirmation.
      setOpen(false);
      apply(next);
    } else {
      setConfirming(next);
    }
  };

  return (
    <span ref={rootRef} className="relative inline-flex max-w-full min-w-0" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Status: ${value} — change`}
        className="tp-focus-ring group inline-flex max-w-full min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 border border-transparent hover:border-slate-200 hover:bg-white transition-colors disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" aria-hidden="true" /> : <StatusPill status={value} size="sm" tone={toneOf(value)} />}
        {!disabled && <ChevronDown className={`w-3 h-3 text-slate-300 group-hover:text-slate-400 ${open ? 'rotate-180' : ''} transition-transform`} aria-hidden="true" />}
      </button>

      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          aria-label="Change status"
          className="fixed z-[60] w-44 tp-card rounded-xl shadow-soft p-1.5 animate-scaleIn"
          style={panelPos}
          onClick={(e) => e.stopPropagation()}
        >
          {confirming ? (
            <div className="p-1">
              <p className="text-xs text-slate-600 mb-2">Change status to <strong className="text-slate-800">{confirming}</strong>?</p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => apply(confirming)}
                  disabled={busy}
                  className="tp-focus-ring flex-1 px-2 py-1.5 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" aria-hidden="true" /> : 'Confirm'}
                </button>
                <button
                  onClick={() => setConfirming(null)}
                  className="tp-focus-ring px-2 py-1.5 rounded-md text-slate-500 text-xs font-medium hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            options.map((status) => (
              <button
                key={status}
                role="option"
                aria-selected={status === value}
                onClick={() => pick(status)}
                className={`tp-focus-ring w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-slate-50 ${status === value ? 'bg-blue-50/70' : ''}`}
              >
                <StatusPill status={status} size="sm" tone={toneOf(status)} />
                {status === value && <Check className="w-3.5 h-3.5 text-blue-600 ml-auto" aria-hidden="true" />}
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
