import { useCallback, useEffect, useState } from 'react';
import {
  GitBranch, Link2, Loader2, Plus, X,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { StatusPill } from './ticketUi';

/**
 * Parent / child ticket relationships (QA 07-16 #4, Option A). A parent banner
 * on the child and a Children card on the parent. Children are real, separately
 * assignable tickets; the link is Ticket-Pulse-authoritative and mirrored to
 * FreshService as a cosmetic note. Rendered in the ticket sidebar.
 */
export default function TicketFamilyCard({ ticketId, canWrite = false, onNavigate, refreshToken }) {
  const [family, setFamily] = useState(null); // { parent, children }
  const [adding, setAdding] = useState(false);
  const [childRef, setChildRef] = useState('');
  const [parentRef, setParentRef] = useState('');
  const [showParentInput, setShowParentInput] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await ticketsAPI.family(ticketId);
      setFamily(res?.data?.data || res?.data || { parent: null, children: [] });
    } catch { setFamily({ parent: null, children: [] }); }
  }, [ticketId]);

  useEffect(() => { load(); }, [load, refreshToken]);

  // Add a child: the backend resolves the typed ref and sets THIS ticket as
  // its parent, returning our refreshed family.
  const addChild = async () => {
    const ref = childRef.trim();
    if (!ref) return;
    setBusy(true); setError(null);
    try {
      const res = await ticketsAPI.addChild(ticketId, ref);
      setFamily(res?.data?.data || res?.data || family);
      setChildRef(''); setAdding(false);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setBusy(false);
  };

  const setParent = async () => {
    const ref = parentRef.trim();
    if (!ref) return;
    setBusy(true); setError(null);
    try {
      await ticketsAPI.setParent(ticketId, ref);
      setParentRef(''); setShowParentInput(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setBusy(false);
  };

  const removeParent = async () => {
    setBusy(true); setError(null);
    try { await ticketsAPI.removeParent(ticketId); await load(); }
    catch (err) { setError(err.response?.data?.message || err.message); }
    setBusy(false);
  };

  const removeChild = async (childId) => {
    setBusy(true); setError(null);
    try { await ticketsAPI.removeParent(childId); await load(); }
    catch (err) { setError(err.response?.data?.message || err.message); }
    setBusy(false);
  };

  if (family === null) return null;
  const { parent, children } = family;
  if (!parent && children.length === 0 && !canWrite) return null;

  return (
    <div className="tp-card rounded-xl p-3.5">
      <div className="mb-2 flex items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5 text-violet-500" aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Parent / child</span>
      </div>

      {error && <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700" role="alert">{error}</div>}

      {/* Parent */}
      <div className="mb-2">
        {parent ? (
          <div className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50/50 px-2.5 py-1.5">
            <span className="text-[11px] text-violet-600">Child of</span>
            <button onClick={() => onNavigate?.(parent.id)} className="tp-focus-ring rounded font-mono text-xs font-bold text-violet-700 hover:underline">{parent.displayRef}</button>
            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{parent.subject}</span>
            {canWrite && (
              <button onClick={removeParent} disabled={busy} aria-label="Remove parent" className="tp-focus-ring rounded p-0.5 text-slate-400 hover:text-red-500">
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        ) : canWrite && (
          showParentInput ? (
            <div className="flex items-center gap-1.5">
              <input value={parentRef} onChange={(e) => setParentRef(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setParent(); }} placeholder="Parent ref (TP-1042 / #231164)" aria-label="Parent ticket ref" className="tp-focus-ring min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
              <button onClick={setParent} disabled={busy || !parentRef.trim()} className="tp-focus-ring rounded-lg bg-violet-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50">{busy ? '…' : 'Set'}</button>
              <button onClick={() => { setShowParentInput(false); setParentRef(''); }} className="tp-focus-ring rounded p-1 text-slate-400 hover:text-slate-600"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
            </div>
          ) : (
            <button onClick={() => setShowParentInput(true)} className="tp-focus-ring inline-flex items-center gap-1 text-[11px] font-medium text-violet-600 hover:text-violet-700">
              <Link2 className="h-3 w-3" aria-hidden="true" /> Set a parent ticket
            </button>
          )
        )}
      </div>

      {/* Children */}
      {children.length > 0 && (
        <ul className="space-y-1">
          <li className="text-[11px] font-semibold text-slate-400">Children ({children.length})</li>
          {children.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5">
              <button onClick={() => onNavigate?.(c.id)} className="tp-focus-ring rounded font-mono text-xs font-bold text-blue-700 hover:underline">{c.displayRef}</button>
              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{c.subject}</span>
              {c.assignee?.name && <span className="hidden truncate text-[10px] text-slate-400 sm:inline">{c.assignee.name}</span>}
              <StatusPill status={c.status} />
              {canWrite && (
                <button onClick={() => removeChild(c.id)} disabled={busy} aria-label="Unlink child" className="tp-focus-ring rounded p-0.5 text-slate-400 hover:text-red-500">
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Add child */}
      {canWrite && (
        adding ? (
          <div className="mt-2 flex items-center gap-1.5">
            <input value={childRef} onChange={(e) => setChildRef(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addChild(); }} placeholder="Child ref (TP-1042 / #231164)" aria-label="Child ticket ref" className="tp-focus-ring min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
            <button onClick={addChild} disabled={busy || !childRef.trim()} className="tp-focus-ring rounded-lg bg-blue-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : 'Add'}</button>
            <button onClick={() => { setAdding(false); setChildRef(''); }} className="tp-focus-ring rounded p-1 text-slate-400 hover:text-slate-600"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="tp-focus-ring mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700">
            <Plus className="h-3 w-3" aria-hidden="true" /> Add a child ticket
          </button>
        )
      )}
    </div>
  );
}
