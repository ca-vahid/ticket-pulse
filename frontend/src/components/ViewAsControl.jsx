import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, Search } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { PersonAvatar } from './tickets/ticketUi';

/**
 * View as (QA 10-08 #2). A super admin looks at Ticket Pulse the way a role,
 * or a named person, sees it. The server holds the view (session + token) and
 * enforces it; this file is the picker and the always-visible way back.
 *
 *   a role    your own identity with that role in ONE workspace — you can
 *             act, and what you do is recorded as you;
 *   a person  their access, their workspaces — nothing can be changed.
 */

const VIEW_AS_ROLES = [
  { id: 'readonly', label: 'Read-only', hint: 'Sees Dashboard, Analytics, Timeline, Knowledge and tickets. Changes nothing.' },
  { id: 'viewer', label: 'Standard', hint: 'Works tickets and approvals. Sees AI suggestions but cannot act on them.' },
  { id: 'reviewer', label: 'Reviewer', hint: 'Standard, plus approving or dismissing AI suggestions and Auto-help review.' },
  { id: 'admin', label: 'Workspace admin', hint: 'Everything in this workspace, without the super-admin sections.' },
  { id: 'agent', label: 'Agent', hint: 'A technician with no access row: tickets, approvals, availability, own profile.' },
];

// The API module is loaded on use: this file is imported by the app header,
// and the many test suites of the header replace that module with partial mocks.
const loadApi = () => import('../services/api');

/** Store the new token and start the app again on it: every screen re-reads who you are. */
async function restartOn(response) {
  const { setAuthToken } = await loadApi();
  if (response?.authToken) setAuthToken(response.authToken);
  window.location.assign('/');
}

export function ViewAsDialog({ open, onClose }) {
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const titleId = useId();
  const [mode, setMode] = useState('role');
  const [role, setRole] = useState('reviewer');
  const [people, setPeople] = useState(null);
  const [query, setQuery] = useState('');
  const [person, setPerson] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const firstRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    firstRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || mode !== 'person' || people || !currentWorkspace?.id) return;
    loadApi().then(({ workspaceAPI }) => workspaceAPI.getMembers(currentWorkspace.id))
      .then((res) => setPeople((res?.data || []).filter((m) => m.email && String(m.email).toLowerCase() !== String(user?.email || '').toLowerCase())))
      .catch(() => setPeople([]));
  }, [open, mode, people, currentWorkspace?.id, user?.email]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people || [])
      .filter((m) => !q || `${m.name || ''} ${m.email}`.toLowerCase().includes(q))
      .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)))
      .slice(0, 40);
  }, [people, query]);

  if (!open) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'role'
        ? { mode: 'role', role, workspaceId: currentWorkspace?.id }
        : { mode: 'person', email: person?.email, name: person?.name || undefined };
      const { authAPI } = await loadApi();
      await restartOn(await authAPI.viewAs(body));
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not start the view');
      setBusy(false);
    }
  };

  const ready = mode === 'role' ? Boolean(currentWorkspace?.id) : Boolean(person?.email);
  const tab = (id, label) => (
    <button
      type="button"
      ref={id === 'role' ? firstRef : undefined}
      aria-pressed={mode === id}
      onClick={() => setMode(id)}
      className={`tp-focus-ring rounded-md px-2.5 py-1 text-sm ${mode === id ? 'bg-primary/10 font-medium text-primary dark:bg-primary/20' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {label}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground/30 p-4 animate-fadeIn" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose?.(); }}
        className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-soft animate-scaleIn"
      >
        <h2 id={titleId} className="text-sm font-semibold text-foreground">View Ticket Pulse as…</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          See exactly what somebody else sees. A bar at the bottom of every page takes you back.
        </p>
        <div className="mt-3 flex items-center gap-1" role="group" aria-label="View as a role or a person">
          {tab('role', `A role in ${currentWorkspace?.name || 'this workspace'}`)}
          {tab('person', 'A person')}
        </div>

        {mode === 'role' ? (
          <fieldset className="mt-3 space-y-1.5">
            <legend className="sr-only">Role</legend>
            {VIEW_AS_ROLES.map((r) => (
              <label key={r.id} className={`flex cursor-pointer gap-2.5 rounded-lg border p-2.5 ${role === r.id ? 'border-primary bg-primary/[0.05] dark:bg-primary/10' : 'border-border hover:bg-muted/50'}`}>
                <input type="radio" name="view-as-role" value={r.id} checked={role === r.id} onChange={() => setRole(r.id)} className="mt-0.5 accent-[hsl(var(--primary))]" />
                <span>
                  <span className="block text-sm font-medium text-foreground">{r.label}</span>
                  <span className="block text-xs text-muted-foreground">{r.hint}</span>
                </span>
              </label>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">You stay yourself: anything you do in this view is recorded under your own name.</p>
          </fieldset>
        ) : (
          <div className="mt-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people in this workspace"
                aria-label="Search people"
                className="tp-focus-ring h-9 w-full rounded-md border border-input bg-background pl-8 pr-2.5 text-sm text-foreground"
              />
            </label>
            <ul className="settings-scrollbar mt-2 max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="People">
              {people === null && <li className="px-3 py-3 text-sm text-muted-foreground">Loading people…</li>}
              {people !== null && !shown.length && <li className="px-3 py-3 text-sm text-muted-foreground">Nobody matches.</li>}
              {shown.map((m) => {
                const picked = person?.email === m.email;
                return (
                  <li key={m.email}>
                    <button
                      type="button"
                      aria-pressed={picked}
                      onClick={() => setPerson(m)}
                      className={`tp-focus-ring flex w-full items-center gap-2.5 px-3 py-2 text-left ${picked ? 'bg-primary/[0.07] dark:bg-primary/15' : 'hover:bg-muted/50'}`}
                    >
                      <PersonAvatar name={m.name || m.email} photoUrl={m.photoUrl} size="h-7 w-7" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{m.name || m.email}</span>
                        <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {m.isSuperAdmin ? 'Super admin' : (VIEW_AS_ROLES.find((r) => r.id === m.accessRole)?.label || 'Agent')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="pt-2 text-xs text-muted-foreground">Read-only: while you view as a person nothing can be changed, so nothing is ever done in their name.</p>
          </div>
        )}

        {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="tp-focus-ring inline-flex h-9 items-center rounded-lg px-3 text-sm text-foreground/85 hover:bg-muted">Cancel</button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={start}
            className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            <Eye className="h-4 w-4" aria-hidden="true" />
            {busy ? 'Starting…' : 'Start viewing'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Shown on every page while a view is active: what you are seeing, and the way back. */
export default function ViewAsBanner() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const view = user?.viewAs;
  if (!view) return null;

  const exit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authAPI } = await loadApi();
      await restartOn(await authAPI.exitViewAs());
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not exit the view');
      setBusy(false);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[9998] flex justify-center px-3" role="status" aria-live="polite">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-sm text-amber-900 shadow-soft dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-100">
        <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Viewing as <strong className="font-semibold">{view.label}</strong>
          {view.mode === 'person' ? ' · read-only, nothing can be changed' : ' · what you do is recorded as you'}
        </span>
        {error && <span role="alert" className="text-red-700 dark:text-red-200">{error}</span>}
        <button
          type="button"
          onClick={exit}
          disabled={busy}
          className="tp-focus-ring rounded-md border border-amber-400 bg-card px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50 dark:border-amber-300/50"
        >
          {busy ? 'Leaving…' : `Back to ${view.byName || 'yourself'}`}
        </button>
      </div>
    </div>
  );
}
