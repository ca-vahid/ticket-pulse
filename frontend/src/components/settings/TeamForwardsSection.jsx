import { useCallback, useEffect, useState } from 'react';
import { Check, Forward, Activity, Plus, Trash2 } from 'lucide-react';
import { settingsAPI } from '../../services/api';

/**
 * Team forwards (QA 09-25 item 6): "Forward to <team>" destinations — e.g.
 * Digital Solutions Team in IT. Each row shows up in the ticket page's More
 * menu once it is enabled and has an address; a row without one waits here
 * until the team has an inbox.
 */
export default function TeamForwardsSection() {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    // Promise.resolve().then: a partial API mock (panel tests) must not throw.
    Promise.resolve().then(() => settingsAPI.getTeamForwards())
      .then((res) => setRows((res?.data || []).map((r) => ({ ...r, email: r.email || '' }))))
      .catch(() => setRows([]))
      .finally(() => { setLoaded(true); setDirty(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const update = (i, patch) => {
    setRows((list) => list.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const add = () => { setRows((list) => [...list, { id: null, label: '', email: '', enabled: true }]); setDirty(true); };
  const remove = (i) => { setRows((list) => list.filter((_, idx) => idx !== i)); setDirty(true); };

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const res = await settingsAPI.saveTeamForwards(rows.map((r) => ({
        id: r.id || undefined, label: r.label, email: r.email || null, enabled: r.enabled !== false,
      })));
      setRows((res?.data || []).map((r) => ({ ...r, email: r.email || '' })));
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not save');
    }
    setBusy(false);
  };

  return (
    <section className="tp-card rounded-xl p-4" aria-labelledby="team-forwards-title">
      <div className="flex items-center gap-2 mb-1">
        <Forward className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 id="team-forwards-title" className="text-sm font-bold text-foreground">Team forwards</h3>
      </div>
      <p className="text-xs text-muted-foreground/75 mb-3">
        Other teams a ticket can be handed to by e-mail. Each enabled team with an address appears as &ldquo;Forward to &hellip;&rdquo; in the ticket&rsquo;s More menu.
      </p>

      {!loaded ? (
        <p className="text-xs text-muted-foreground"><Activity className="inline h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading…</p>
      ) : (
        <div className="space-y-2">
          {rows.length === 0 && <p className="text-xs italic text-muted-foreground/75">No teams yet.</p>}
          {rows.map((r, i) => (
            <div key={r.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={r.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Digital Solutions Team"
                aria-label="Team name"
                maxLength={120}
                className="tp-focus-ring h-9 w-56 rounded-lg border border-input bg-card px-3 text-sm"
              />
              <input
                type="email"
                value={r.email}
                onChange={(e) => update(i, { email: e.target.value })}
                placeholder="team inbox (leave empty until it exists)"
                aria-label={`${r.label || 'Team'} e-mail address`}
                className="tp-focus-ring h-9 w-72 rounded-lg border border-input bg-card px-3 text-sm"
              />
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={r.enabled !== false}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                  className="tp-focus-ring h-3.5 w-3.5 accent-primary"
                />
                Enabled
              </label>
              {!r.email && <span className="text-[11px] text-muted-foreground/75">Hidden on tickets until it has an address</span>}
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove ${r.label || 'team'}`}
                className="tp-focus-ring ml-auto rounded-md p-1.5 text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={add}
              className="tp-focus-ring inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add team
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="tp-focus-ring ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy && <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} Save
            </button>
            {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-300"><Check className="h-3.5 w-3.5" aria-hidden="true" /> Saved</span>}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}
