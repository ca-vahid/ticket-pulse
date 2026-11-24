import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Loader2, Search, Trash2, UserRound } from 'lucide-react';
import { personalApiKeysAPI, settingsAPI } from '../../services/api';
import { Switch } from '../ui/switch';
import {
  STATUS_TONE, STATUS_WORDS, abilitySentence, errorText, expiryParts, formatDayShort, isLiveKey,
  keySummaryParts, lastUsedParts,
} from '../apiKeys/personalKeyText';

/**
 * Personal API keys, admin view (4.4.05), under Settings → API Keys beside the
 * integration keys. Two parts:
 *  - API access: who may make a personal key. The same per-person pattern as
 *    "Can see the Dashboard" in Members: a switch per agent, saved as a list
 *    of technician ids. Empty list = nobody. Removing someone revokes their key.
 *  - Everyone's personal keys: owner, what it can do, status, dates, last use,
 *    with switch off/on and revoke.
 * A 403 on either read hides the section (not an admin here).
 */

const STATUS_ORDER = { active: 0, disabled: 1, expired: 2, revoked: 3 };
const btnQuiet = 'tp-focus-ring inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60';
const btnDanger = 'tp-focus-ring inline-flex items-center gap-1 rounded-lg bg-destructive px-2.5 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60';

const ownerName = (k) => k?.owner?.name || k?.owner?.email || 'Someone';
const lower = (s) => String(s || '').toLowerCase();

function AccessPicker({ people, accessIds, keyFor, busyId, onAdd, onRemove }) {
  const [q, setQ] = useState('');
  const [confirmFor, setConfirmFor] = useState(null); // technician id awaiting "remove"
  const [showIneligible, setShowIneligible] = useState(false);
  // People who can't have a key (no agent profile, profile switched off) are
  // listed only on request, unless they are still on the list.
  const offerable = useMemo(() => people.filter((p) => p.eligible || accessIds.has(p.id)), [people, accessIds]);
  const ineligibleCount = people.length - offerable.length;
  const shown = useMemo(() => {
    const base = showIneligible ? people : offerable;
    const needle = q.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((p) => lower(p.name).includes(needle) || lower(p.email).includes(needle));
  }, [people, offerable, showIneligible, q]);
  const onCount = offerable.filter((p) => accessIds.has(p.id)).length;

  return (
    <div data-testid="api-access-picker">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">API access</h4>
        <span className="text-xs text-muted-foreground">{onCount === 0 ? 'Nobody yet' : `${onCount} of ${offerable.length} ${offerable.length === 1 ? 'person' : 'people'}`}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Who may make a personal key. The key can do only what that person can do in the app. Removing someone revokes their key.
      </p>
      {offerable.length > 8 && (
        <div className="relative mt-2 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a person…"
            aria-label="Find a person for API access"
            className="tp-focus-ring w-full rounded-lg border border-input bg-card py-1.5 pl-8 pr-3 text-sm"
          />
        </div>
      )}
      <ul className="mt-2 grid gap-x-6 sm:grid-cols-2">
        {shown.map((p) => {
          const on = typeof p.id === 'number' && accessIds.has(p.id);
          const key = keyFor(p);
          const busy = busyId === p.id;
          const confirming = confirmFor === p.id;
          const locked = !p.eligible && !on;
          return (
            <li key={p.id ?? `e:${lower(p.email)}`} className="border-b border-border/60 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className={`block truncate text-sm ${p.eligible ? 'text-foreground' : 'text-muted-foreground'}`}>{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground" title={p.reason || undefined}>
                    {key ? `Has a key: “${key.name}”` : !p.eligible && p.reason ? p.reason : p.email || '—'}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />}
                  <Switch
                    checked={on}
                    disabled={busy || confirming || locked}
                    title={locked ? p.reason || "Can't have a key" : undefined}
                    aria-label={`${p.name} may have an API key`}
                    onCheckedChange={(v) => {
                      if (v === true) onAdd(p);
                      else setConfirmFor(p.id);
                    }}
                  />
                </span>
              </div>
              {confirming && (
                <div role="alertdialog" aria-label={`Remove ${p.name} from API access?`} className="mt-2 border-l-2 border-amber-400 dark:border-amber-500/60 pl-3">
                  <p className="text-xs text-foreground">
                    Remove {p.name} from API access?
                    {key && ` Their key “${key.name}” is revoked now and stops working. This can't be undone.`}
                  </p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button type="button" onClick={async () => { setConfirmFor(null); await onRemove(p); }} className={btnDanger}>
                      {key ? 'Remove and revoke the key' : 'Remove'}
                    </button>
                    <button type="button" onClick={() => setConfirmFor(null)} className={btnQuiet}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="py-3 text-sm text-muted-foreground">{q ? `No one matches “${q}”.` : 'No active agents in this workspace.'}</li>
        )}
      </ul>
      {ineligibleCount > 0 && (
        <button type="button" onClick={() => setShowIneligible((v) => !v)} className={`${btnQuiet} mt-1 -ml-2.5`} aria-expanded={showIneligible}>
          {showIneligible ? 'Hide' : 'Show'} {ineligibleCount} {ineligibleCount === 1 ? 'person' : 'people'} who can{"'"}t have a key
        </button>
      )}
    </div>
  );
}

/** One shape for the picker, from the users read (`people`) or, failing that, the roster. */
function normalisePeople(userData, roster) {
  if (Array.isArray(userData?.people)) {
    return userData.people.map((p) => ({
      id: typeof p.technicianId === 'number' ? p.technicianId : null,
      name: p.name || p.email || 'Someone',
      email: p.email || '',
      eligible: p.eligible !== false && typeof p.technicianId === 'number',
      reason: p.reason || null,
      hasKey: p.hasKey === true,
    }));
  }
  return roster
    .filter((t) => typeof t.id === 'number')
    .map((t) => ({
      id: t.id,
      name: t.name || t.email || 'Someone',
      email: t.email || '',
      eligible: t.isActive === true,
      reason: t.isActive ? null : 'Their agent profile is switched off.',
      hasKey: false,
    }));
}

function KeysTable({ keys, busyId, onSetDisabled, onRevoke }) {
  const [confirmFor, setConfirmFor] = useState(null);
  const sorted = useMemo(
    () => [...keys].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      || ownerName(a).localeCompare(ownerName(b))),
    [keys],
  );
  // Six columns from xl up (the settings pane is ~970 px there). The table is
  // one grid and every row a subgrid of it, so a column is as wide as its
  // widest cell: fr tracks never squeeze below their content (the phrases are
  // whole lines, whitespace-nowrap), and Status and Actions take only what
  // they need. Below xl each key stacks: owner, abilities, one status line,
  // and the actions (to the right from sm up).
  const table = 'xl:grid xl:grid-cols-[1.3fr_1.6fr_auto_1fr_1fr_auto] xl:gap-x-4';
  const subrow = 'xl:col-span-full xl:grid xl:grid-cols-subgrid';
  const wide = 'hidden xl:block';

  return (
    <div data-testid="personal-keys-table">
      <h4 className="text-sm font-semibold text-foreground">Everyone&rsquo;s personal keys</h4>
      {sorted.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">No one has made a personal key yet.</p>
      ) : (
        <div role="table" aria-label="Everyone's personal keys" className={`mt-2 ${table}`}>
          <div role="row" className={`hidden border-b border-border pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${subrow}`}>
            <span role="columnheader">Owner</span>
            <span role="columnheader">What it can do</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Expires</span>
            <span role="columnheader">Last used</span>
            <span role="columnheader" className="text-right">Actions</span>
          </div>
          {sorted.map((k) => {
            const live = isLiveKey(k);
            const busy = busyId === k.id;
            const who = ownerName(k);
            const end = expiryParts(k);
            const used = lastUsedParts(k);
            const summary = keySummaryParts(k);
            // A key that no longer works is marked by its status word only:
            // no fading, so every line keeps AA contrast.
            const lead = live ? 'text-foreground/85' : 'text-muted-foreground';
            return (
              <div key={k.id} role="row" data-testid="admin-key-row" className={`border-b border-border/60 py-2.5 ${subrow}`}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4 xl:contents">
                  <div className="min-w-0 flex-1 space-y-1 xl:contents">
                    <div role="cell" className="min-w-0 xl:self-center">
                      <span className="block break-words text-sm font-medium text-foreground" title={k.owner?.email || undefined}>{who}</span>
                      <span className="block break-words text-xs text-muted-foreground" data-testid="admin-key-name">“{k.name}”</span>
                      <span className="block text-[11px] text-muted-foreground" data-testid="admin-key-made">made {formatDayShort(k.createdAt)}</span>
                    </div>
                    <div role="cell" className={`text-xs ${lead} xl:self-center`}>{abilitySentence(k)}</div>
                    <p role="cell" className="text-xs text-muted-foreground xl:hidden" data-testid="admin-key-summary">
                      {summary.text}
                      {/* At phone width the IP moves down together with its "from". */}
                      {summary.from && <>{' '}<span className="whitespace-nowrap" data-testid="admin-key-summary-from">{summary.from}</span></>}
                    </p>
                    <div role="cell" className={`${wide} self-center whitespace-nowrap text-xs font-medium ${STATUS_TONE[k.status] || 'text-muted-foreground'}`}>{STATUS_WORDS[k.status] || k.status || '—'}</div>
                    <div role="cell" className={`${wide} self-center text-xs`} data-testid="admin-key-expires">
                      <span className={`block whitespace-nowrap ${lead}`}>{end.date}</span>
                      {end.note && <span className="block whitespace-nowrap text-muted-foreground">{end.note}</span>}
                    </div>
                    <div role="cell" className={`${wide} self-center text-xs`} data-testid="admin-key-last-used">
                      <span className={`block whitespace-nowrap ${lead}`}>{used.when}</span>
                      {used.from && <span className="block whitespace-nowrap text-muted-foreground">{used.from}</span>}
                    </div>
                  </div>
                  {live && (
                    <div role="cell" className="flex shrink-0 items-center gap-1.5 xl:justify-end xl:self-center">
                      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />}
                      <Switch
                        checked={k.status === 'active'}
                        disabled={busy}
                        aria-label={`${who}'s key “${k.name}” is on`}
                        title={k.status === 'active' ? 'Switch this key off' : 'Switch this key back on'}
                        onCheckedChange={(v) => onSetDisabled(k, v !== true)}
                      />
                      {confirmFor !== k.id && (
                        <button type="button" onClick={() => setConfirmFor(k.id)} disabled={busy} aria-label={`Revoke ${who}'s key “${k.name}”`} className={`${btnQuiet} hover:text-destructive`}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Revoke
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {confirmFor === k.id && (
                  <div role="alertdialog" aria-label={`Revoke ${who}'s key?`} className="mt-2 border-l-2 border-amber-400 dark:border-amber-500/60 pl-3 xl:col-span-full">
                    <p className="text-xs text-foreground">Revoke {who}&rsquo;s key “{k.name}”? It stops working at once and they would have to make a new one. This can&rsquo;t be undone.</p>
                    <div className="mt-1.5 flex gap-1.5">
                      <button type="button" onClick={async () => { setConfirmFor(null); await onRevoke(k); }} className={btnDanger}>Revoke key</button>
                      <button type="button" onClick={() => setConfirmFor(null)} className={btnQuiet}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function PersonalKeysAdmin() {
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState([]);
  const [accessIds, setAccessIds] = useState(() => new Set());
  const [people, setPeople] = useState([]);
  const [busyPersonId, setBusyPersonId] = useState(null);
  const [busyKeyId, setBusyKeyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadKeys = useCallback(async () => {
    const res = await personalApiKeysAPI.list();
    setKeys(Array.isArray(res?.data?.keys) ? res.data.keys : []);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [keyRes, userRes] = await Promise.all([personalApiKeysAPI.list(), personalApiKeysAPI.users()]);
      setKeys(Array.isArray(keyRes?.data?.keys) ? keyRes.data.keys : []);
      const ids = userRes?.data?.technicianIds;
      setAccessIds(new Set(Array.isArray(ids) ? ids.map(Number) : []));
      // The users read names everyone with their eligibility; an older
      // backend without `people` falls back to the roster.
      let roster = [];
      if (!Array.isArray(userRes?.data?.people)) {
        const techRes = await Promise.resolve().then(() => settingsAPI.getTechnicians()).catch(() => ({ data: [] }));
        roster = Array.isArray(techRes?.data) ? techRes.data : [];
      }
      setPeople(normalisePeople(userRes?.data, roster)
        .sort((a, b) => String(a.name).localeCompare(String(b.name))));
      setHidden(false);
    } catch (err) {
      if (err?.status === 403 || err?.status === 401) setHidden(true);
      else setError(errorText(err, 'Could not load personal keys.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // A person's live key: by technician id, else by e-mail.
  const keyFor = useMemo(() => {
    const byId = new Map();
    const byEmail = new Map();
    for (const k of keys) {
      if (!isLiveKey(k)) continue;
      if (typeof k.owner?.technicianId === 'number') byId.set(k.owner.technicianId, k);
      if (k.owner?.email) byEmail.set(lower(k.owner.email), k);
    }
    return (p) => (typeof p.id === 'number' && byId.get(p.id)) || byEmail.get(lower(p.email)) || null;
  }, [keys]);

  // 422 personal_key_user_not_eligible: say who, and why.
  const refusalText = (err) => {
    const details = Array.isArray(err?.details) ? err.details : Array.isArray(err?.data?.details) ? err.data.details : [];
    const lines = details
      .map((d) => {
        const who = people.find((p) => p.id === Number(d?.technicianId));
        return d?.reason ? `${who?.name || 'Someone'}: ${d.reason}` : null;
      })
      .filter(Boolean);
    const head = errorText(err, 'Could not change API access.');
    return lines.length ? `${head} ${lines.join(' ')}` : head;
  };

  const flash = (text) => { setNotice(text); setError(null); };

  const saveAccess = async (person, on) => {
    const before = accessIds;
    const next = new Set(before);
    if (on) next.add(person.id); else next.delete(person.id);
    setAccessIds(next);
    setBusyPersonId(person.id);
    setError(null); setNotice(null);
    try {
      // Only the person toggled, as a delta, so two admins editing at once
      // don't overwrite each other's changes. The whole list rides along only
      // as a fallback for a whole-list-only backend (never an empty body that
      // could read as "nobody").
      const res = await personalApiKeysAPI.changeUsers({
        add: on ? [person.id] : [],
        remove: on ? [] : [person.id],
        technicianIds: [...next],
      });
      const ids = res?.data?.technicianIds;
      if (Array.isArray(ids)) setAccessIds(new Set(ids.map(Number)));
      const revoked = Array.isArray(res?.data?.revokedKeyIds) ? res.data.revokedKeyIds : [];
      if (on) {
        flash(`${person.name} can now make a personal API key on their Profile page.`);
      } else {
        flash(revoked.length
          ? `${person.name} no longer has API access. Their key was revoked.`
          : `${person.name} no longer has API access.`);
        if (revoked.length) await loadKeys().catch(() => {});
      }
    } catch (err) {
      setAccessIds(before);
      setError(refusalText(err));
    } finally {
      setBusyPersonId(null);
    }
  };

  const setDisabled = async (k, disabled) => {
    setBusyKeyId(k.id); setError(null); setNotice(null);
    try {
      const res = await personalApiKeysAPI.setDisabled(k.id, disabled);
      const updated = res?.data;
      setKeys((list) => list.map((x) => (x.id === k.id
        ? { ...x, ...(updated && typeof updated === 'object' ? updated : {}), owner: x.owner, status: updated?.status || (disabled ? 'disabled' : 'active') }
        : x)));
      flash(disabled
        ? `${ownerName(k)}’s key “${k.name}” is switched off. It does nothing until you switch it back on.`
        : `${ownerName(k)}’s key “${k.name}” is on again.`);
    } catch (err) {
      setError(errorText(err, 'Could not change the key.'));
    } finally {
      setBusyKeyId(null);
    }
  };

  const revoke = async (k) => {
    setBusyKeyId(k.id); setError(null); setNotice(null);
    try {
      await personalApiKeysAPI.adminRevoke(k.id);
      setKeys((list) => list.map((x) => (x.id === k.id ? { ...x, status: 'revoked' } : x)));
      flash(`${ownerName(k)}’s key “${k.name}” is revoked.`);
      await loadKeys().catch(() => {});
    } catch (err) {
      setError(errorText(err, 'Could not revoke the key.'));
    } finally {
      setBusyKeyId(null);
    }
  };

  if (hidden) return null;

  return (
    <section className="tp-card rounded-xl p-4" aria-label="Personal API keys" data-testid="personal-keys-admin">
      <div className="mb-1 flex items-center gap-2">
        <UserRound className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">Personal API keys</h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Keys people make for themselves on their profile. A personal key acts as its owner: replies go out in their name with their signature, and it can never do more than they can in the app.
      </p>

      {error && <p className="mb-2 text-xs text-destructive" role="alert">{error}</p>}
      {notice && <p className="mb-2 text-xs text-emerald-700 dark:text-emerald-300" role="status">{notice}</p>}

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading personal keys…</div>
      ) : (
        <div className="space-y-6">
          <AccessPicker
            people={people}
            accessIds={accessIds}
            keyFor={keyFor}
            busyId={busyPersonId}
            onAdd={(p) => saveAccess(p, true)}
            onRemove={(p) => saveAccess(p, false)}
          />
          <KeysTable keys={keys} busyId={busyKeyId} onSetDisabled={setDisabled} onRevoke={revoke} />
        </div>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> Each person has at most one key per workspace. Every create, rotate and revoke shows in Members → Access history.
      </p>
    </section>
  );
}
