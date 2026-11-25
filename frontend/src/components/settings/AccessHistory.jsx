import { useCallback, useEffect, useState } from 'react';
import { Activity, History, KeyRound, Search, ShieldAlert } from 'lucide-react';
import { workspaceAPI } from '../../services/api';

/**
 * Access history (20 Nov 2026): who changed whose role, the super-admin list,
 * and every API key / OAuth client change, newest first. Kept for good, unlike
 * the server log that used to be the only trace.
 */

const ROLE_LABEL = { admin: 'Admin', reviewer: 'Reviewer', viewer: 'Viewer', readonly: 'Read-only', observer: 'Observer' };
const role = (r) => ROLE_LABEL[r] || r || 'none';
const who = (email) => (email ? String(email).split('@')[0] : 'someone');
const FS_MODE_WORD = { connected: 'Connected', shadow: 'Shadow', off: 'Off' };

const CREDENTIAL_VERB = {
  created: 'created', updated: 'changed', enabled: 'switched back on', rotated: 'gave a new secret to',
  revoked: 'revoked', deleted: 'deleted',
};

/** One readable sentence per event. Exported for tests. */
export function describeAccessEvent(e) {
  const actor = who(e.actorEmail);
  const target = e.targetLabel || e.targetEmail || 'someone';
  switch (e.action) {
  case 'role_granted': return `${actor} gave ${target} the ${role(e.newValue)} role`;
  case 'role_changed': return `${actor} changed ${target} from ${role(e.oldValue)} to ${role(e.newValue)}`;
  case 'access_revoked': return `${actor} removed ${target}'s access (was ${role(e.oldValue)})`;
  case 'workspace_created': return `${actor} created the workspace "${e.targetLabel || 'unnamed'}"`;
  // FreshService switch (25 Nov 2026).
  case 'freshservice_mode_changed': return `${actor} set FreshService to ${FS_MODE_WORD[e.newValue] || e.newValue || 'a new mode'}${e.oldValue ? ` (was ${FS_MODE_WORD[e.oldValue] || e.oldValue})` : ''}`;
  case 'freshservice_tickets_adopted': {
    const n = Number(e.newValue ?? e.details?.adopted) || 0;
    const failed = Number(e.details?.failed) || 0;
    const tail = failed > 0 ? `; ${failed} could not be adopted` : '';
    const stillOn = e.details?.switchedOff === false ? ' (FreshService stayed on)' : '';
    return `${actor} adopted ${n} open FreshService ticket${n === 1 ? '' : 's'} while switching FreshService off${tail}${stillOn}`;
  }
  case 'dashboard_view_changed': return `${actor} turned Dashboard view ${e.newValue === 'on' ? 'on' : 'off'} for ${target}`;
  case 'admin_list_changed': {
    const added = e.details?.added || [];
    const removed = e.details?.removed || [];
    const parts = [added.length ? `added ${added.join(', ')}` : null, removed.length ? `removed ${removed.join(', ')}` : null].filter(Boolean);
    return `${actor} changed the super admin list${parts.length ? `: ${parts.join('; ')}` : ''}`;
  }
  default: {
    const m = /^(api_key|oauth_client)_(\w+)$/.exec(e.action || '');
    if (m) {
      const kind = m[1] === 'api_key' ? 'API key' : 'OAuth client';
      return `${actor} ${CREDENTIAL_VERB[m[2]] || m[2]} ${kind} "${e.targetLabel || 'unnamed'}"`;
    }
    return `${actor}: ${e.action}`;
  }
  }
}

/** The fine print under a credential event: access, IP lock, what changed. */
export function credentialDetail(e) {
  const d = e.details || {};
  if (!d.kind) return null;
  const bits = [];
  if (Array.isArray(d.scopes) && /_(created|rotated|enabled)$/.test(e.action)) bits.push(d.scopes.join(', ') || 'no scopes');
  if (Array.isArray(d.ipAllowlist) && /_(created|rotated|enabled)$/.test(e.action)) bits.push(d.ipAllowlist.length ? `IP ${d.ipAllowlist.join(', ')}` : 'no IP lock');
  if (d.changed && Object.keys(d.changed).length) {
    bits.push(Object.entries(d.changed).map(([k, v]) => (k === 'isEnabled' ? (v.to ? 'switched on' : 'switched off') : `${k} changed`)).join(', '));
  }
  if (d.prefix) bits.push(d.prefix);
  return bits.join(' · ') || null;
}

const isAlerting = (a) => /_(created|rotated|enabled)$/.test(a || '') || a === 'admin_list_changed' || a === 'role_granted' || a === 'role_changed';

function whenLabel(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}

export default function AccessHistory({ workspaceId }) {
  const [items, setItems] = useState(null);
  const [nextBefore, setNextBefore] = useState(null);
  const [person, setPerson] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (before = null) => {
    setError(null);
    try {
      const res = await workspaceAPI.getAccessHistory(workspaceId, { person: query || undefined, before: before || undefined, limit: 50 });
      const data = res?.data || {};
      setItems((prev) => (before ? [...(prev || []), ...(data.items || [])] : (data.items || [])));
      setNextBefore(data.nextBefore || null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load the access history');
      if (!before) setItems([]);
    }
  }, [workspaceId, query]);

  useEffect(() => { setItems(null); load(); }, [load]);

  return (
    <section className="tp-card rounded-xl p-4 mt-6" aria-labelledby="access-history-title">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <History className="w-4 h-4 text-primary" aria-hidden="true" />
        <h3 id="access-history-title" className="text-sm font-bold text-foreground">Access history</h3>
        <form
          className="ml-auto flex items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); setQuery(person.trim()); }}
        >
          <label htmlFor="access-history-person" className="sr-only">Filter by person or key</label>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
            <input
              id="access-history-person"
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              placeholder="Person or key name"
              className="tp-focus-ring w-48 pl-7 pr-2 py-1 text-xs border border-input rounded-md bg-card text-foreground"
            />
          </div>
        </form>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Role changes, super-admin list changes, and every API key and OAuth client created, changed or removed. Admins are e-mailed when a key or client is created, gets a new secret, or is switched back on.
      </p>

      {error && <p className="text-xs text-destructive mb-2" role="alert">{error}</p>}
      {items === null && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Activity className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}
      {items && items.length === 0 && !error && (
        <p className="text-xs text-muted-foreground/75 italic">{query ? `Nothing for "${query}".` : 'No changes recorded yet. Recording started on 20 Nov 2026.'}</p>
      )}
      {items && items.length > 0 && (
        <ol className="divide-y divide-border">
          {items.map((e) => {
            const credential = /^(api_key|oauth_client)_/.test(e.action || '');
            const Icon = credential ? KeyRound : ShieldAlert;
            const detail = credentialDetail(e);
            return (
              <li key={e.id} className="flex items-start gap-2.5 py-2 text-xs">
                <Icon
                  className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isAlerting(e.action) ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground/75'}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-foreground break-words">{describeAccessEvent(e)}</p>
                  {detail && <p className="text-[11px] text-muted-foreground break-words">{detail}</p>}
                </div>
                <time dateTime={e.createdAt} className="shrink-0 text-muted-foreground/75 tabular-nums">{whenLabel(e.createdAt)}</time>
              </li>
            );
          })}
        </ol>
      )}
      {nextBefore && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={async () => { setLoadingMore(true); await load(nextBefore); setLoadingMore(false); }}
          className="tp-focus-ring mt-2 text-xs font-medium text-primary hover:underline disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Show older'}
        </button>
      )}
    </section>
  );
}
