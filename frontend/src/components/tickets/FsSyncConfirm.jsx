import { useEffect } from 'react';
import { ArrowRight, Cloud, Loader2, X } from 'lucide-react';

/**
 * Confirmation dialog for FS-owned field edits. Deliberately looks DIFFERENT
 * from normal TP edits (dark slate header, FreshService cloud branding): the
 * user is authorizing a write to FreshService, which must succeed and verify
 * there before Ticket Pulse changes anything.
 */
export default function FsSyncConfirm({ fsRef, changes = [], busy = false, error = null, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="fs-sync-title">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={busy ? undefined : onCancel} aria-hidden="true" />
      <div className="relative w-full max-w-md tp-card rounded-2xl overflow-hidden shadow-soft animate-scaleIn">
        {/* FS-branded header — visually distinct from TP-native edits */}
        <div className="bg-slate-800 px-5 py-4 flex items-start gap-3">
          <span className="h-9 w-9 rounded-xl bg-sky-500/20 text-sky-300 flex items-center justify-center flex-shrink-0">
            <Cloud className="w-5 h-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="fs-sync-title" className="text-sm font-bold text-white">Sync change to FreshService</h2>
            <p className="text-xs text-slate-300 mt-0.5">
              FreshService owns <span className="font-mono font-semibold text-sky-300">#{fsRef}</span> — this writes there first.
              Ticket Pulse only updates after FreshService confirms.
            </p>
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            aria-label="Cancel"
            className="tp-focus-ring ml-auto p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4">
          <ul className="space-y-2">
            {changes.map((c) => (
              <li key={c.field} className="flex items-center gap-2 text-sm">
                <span className="w-20 flex-shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{c.field}</span>
                <span className="text-slate-500 truncate">{c.from ?? '—'}</span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" aria-hidden="true" />
                <span className="font-semibold text-slate-800 truncate">{c.to ?? '—'}</span>
              </li>
            ))}
          </ul>

          {error && (
            <div className="mt-3 p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700" role="alert">
              {error} — Ticket Pulse was not changed.
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={busy}
              className="tp-focus-ring px-3.5 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busy}
              className="tp-focus-ring inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Cloud className="w-4 h-4 text-sky-300" aria-hidden="true" />}
              {busy ? 'Writing to FreshService…' : 'Write to FreshService'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
