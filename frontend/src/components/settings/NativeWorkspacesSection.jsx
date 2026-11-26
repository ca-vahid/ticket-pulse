import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, Layers, Loader, Plus, XCircle } from 'lucide-react';
import { workspaceAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';

/**
 * Settings → Workspaces: workspaces that live only in Ticket Pulse (QA 11-24
 * item 4). Everything above this section comes from FreshService; these have
 * no FreshService link (freshservice_workspace_id 0), native ticketing on, and
 * no FreshService sync or fallback copy.
 *
 * Super admins get "New workspace": name, time zone, internal e-mail domains
 * (empty = copy IT's). The server picks a free short name from the name, seeds
 * statuses, a "General" group and IT's ticket types, gives the creator admin
 * access and writes it to Access history (POST /workspaces/native).
 */

const COMMON_ZONES = [
  'America/Vancouver', 'America/Edmonton', 'America/Denver', 'America/Winnipeg', 'America/Chicago',
  'America/Toronto', 'America/New_York', 'America/Halifax', 'America/St_Johns', 'America/Santiago',
  'Europe/London', 'Australia/Brisbane',
];

/** Rough preview of the server's short name (the server decides, and avoids clashes). */
export function previewSlug(name) {
  return String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
}

const isNative = (ws) => String(ws?.freshserviceWorkspaceId ?? '') === '0';

export default function NativeWorkspacesSection({ canCreate = false }) {
  const { refreshWorkspaces, switchWorkspace } = useWorkspace();
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', defaultTimezone: 'America/Vancouver', domains: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await workspaceAPI.getAll();
      setList((res?.data || []).filter(isNative));
    } catch {
      setList([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const slug = useMemo(() => previewSlug(form.name), [form.name]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Give the workspace a name.'); return; }
    setSaving(true);
    setError(null);
    setCreated(null);
    try {
      const domains = form.domains.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean);
      const res = await workspaceAPI.createNative({
        name: form.name.trim(),
        defaultTimezone: form.defaultTimezone.trim() || 'America/Vancouver',
        ...(domains.length ? { internalDomains: domains } : {}),
      });
      const ws = res?.data || null;
      setCreated(ws);
      setOpen(false);
      setForm({ name: '', defaultTimezone: 'America/Vancouver', domains: '' });
      await Promise.all([load(), refreshWorkspaces?.()]);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'The workspace could not be created.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="native-workspaces-heading" className="space-y-3" data-testid="native-workspaces">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="native-workspaces-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Layers className="h-4 w-4 text-primary" aria-hidden="true" />
            Ticket Pulse workspaces
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Workspaces that live only in Ticket Pulse: tickets are created here, with no FreshService sync or fallback copy.
          </p>
        </div>
        {canCreate && !open && (
          <button
            type="button"
            onClick={() => { setOpen(true); setError(null); setCreated(null); }}
            className="tp-focus-ring inline-flex flex-none items-center gap-1.5 self-start rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New workspace
          </button>
        )}
      </div>

      {created && (
        <div className="flex flex-wrap items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200" role="status">
          <CheckCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            &ldquo;{created.name}&rdquo; is ready, with you as its admin. Ticket links look like /{created.linkName || created.slug}/TP-10000.
            Add members, categories and a mailbox in its Settings.
          </span>
          {switchWorkspace && (
            <button type="button" onClick={() => switchWorkspace(created.id)} className="tp-focus-ring rounded font-semibold underline">
              Open it
            </button>
          )}
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-muted/40 p-4" aria-label="New workspace">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-muted-foreground">
              Name
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={100}
                required
                autoFocus
                className="tp-focus-ring mt-1 block w-full rounded-lg border border-input bg-card px-3 py-2 text-sm font-normal text-foreground"
                placeholder="e.g. Facilities"
              />
              <span className="mt-1 block font-normal text-muted-foreground">
                Short name: {slug ? `/${slug}` : '—'} (a number is added if it is taken)
              </span>
            </label>
            <label className="block text-xs font-semibold text-muted-foreground">
              Time zone
              <input
                value={form.defaultTimezone}
                onChange={(e) => setForm((f) => ({ ...f, defaultTimezone: e.target.value }))}
                list="native-ws-zones"
                className="tp-focus-ring mt-1 block w-full rounded-lg border border-input bg-card px-3 py-2 text-sm font-normal text-foreground"
              />
              <datalist id="native-ws-zones">
                {COMMON_ZONES.map((z) => <option key={z} value={z} />)}
              </datalist>
            </label>
            <label className="block text-xs font-semibold text-muted-foreground sm:col-span-2">
              Internal e-mail domains
              <input
                value={form.domains}
                onChange={(e) => setForm((f) => ({ ...f, domains: e.target.value }))}
                className="tp-focus-ring mt-1 block w-full rounded-lg border border-input bg-card px-3 py-2 text-sm font-normal text-foreground"
                placeholder="Leave empty to copy the IT workspace's list"
              />
              <span className="mt-1 block font-normal text-muted-foreground">Requesters outside these domains are marked External.</span>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Native ticketing is on. It starts with the four standard statuses, a &ldquo;General&rdquo; group for new tickets and the IT workspace&rsquo;s ticket types.
          </p>
          {error && (
            <p className="flex items-start gap-2 text-sm text-red-700 dark:text-red-200" role="alert">
              <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              {saving ? <Loader className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
              {saving ? 'Creating…' : 'Create workspace'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setError(null); }} className="tp-focus-ring rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </form>
      )}

      {list && list.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card">
          {list.map((ws) => (
            <li key={ws.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <span className="font-medium text-foreground">{ws.name}</span>
              <span className="text-xs text-muted-foreground">Ticket links: /{ws.linkName || ws.slug}/TP-…</span>
              <span className="text-xs text-muted-foreground">{ws.defaultTimezone}</span>
              {/* FreshService switch (25 Nov 2026): these were never on FreshService. */}
              <span className="text-xs text-muted-foreground/75" data-testid="fs-never-connected-line">Never connected to FreshService — nothing to switch</span>
            </li>
          ))}
        </ul>
      )}
      {list && list.length === 0 && !open && (
        <p className="text-sm text-muted-foreground">None yet.{canCreate ? ' Use New workspace to make one.' : ''}</p>
      )}
    </section>
  );
}
