import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Check, GraduationCap, RefreshCw, Trash2 } from 'lucide-react';
import { assignmentAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import { PersonAvatar } from '../tickets/ticketUi';
import FancySelect from '../common/FancySelect';

/**
 * Assignment Review → Competencies → Learned skills (QA 10-09 item 12).
 * The skills the system added from closed tickets, with what is behind each:
 * how many tickets that person closed in the category, and how many of those
 * the AI assigned. An admin keeps, re-levels or removes them, one at a time or
 * several at once.
 *
 * Grouped by person in name order — a tidy-up list, never a ranking of people.
 * Inside a person, the thinnest evidence comes first (a high level on few
 * closed tickets), which is the order the server returns.
 */
const LEVEL_LABELS = { basic: 'Basic', intermediate: 'Comfortable', advanced: 'Advanced', expert: 'Expert / SME' };
const DEFAULT_LEVELS = ['basic', 'intermediate', 'advanced', 'expert'];
const levelLabel = (level) => LEVEL_LABELS[level] || level || '—';

function categoryLabel(category) {
  if (!category?.name) return 'Unknown category';
  return category.parentName ? `${category.parentName} › ${category.name}` : category.name;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Avatars: one roster fetch per mount (the list the matrix already uses) →
 * { [techId]: { photoUrl } }. Photos are never part of the learned-skills
 * payload; a missing photo falls back to initials. `techPhotos` skips the fetch.
 */
export default function LearnedSkillsTab({ workspaceTimezone = 'America/Los_Angeles', techPhotos: techPhotosProp = null }) {
  const [fetchedPhotos, setFetchedPhotos] = useState(null);
  useEffect(() => {
    if (techPhotosProp) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => assignmentAPI.getCompetencyTechnicians())
      .then((res) => {
        if (cancelled) return;
        const map = {};
        for (const t of (res?.data || [])) if (t?.id != null) map[t.id] = { photoUrl: t.photoUrl || null };
        setFetchedPhotos(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [techPhotosProp]);
  const techPhotos = techPhotosProp || fetchedPhotos;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [person, setPerson] = useState('');
  const [level, setLevel] = useState('');
  const [thinOnly, setThinOnly] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null); // a row id, or 'bulk'

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await assignmentAPI.getLearnedSkills();
      setData(res?.data || { items: [], thresholds: {}, levels: [] });
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load learned skills');
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => data?.items || [], [data]);
  const levels = useMemo(() => (data?.levels?.length ? data.levels : DEFAULT_LEVELS), [data]);
  const thresholds = data?.thresholds || {};

  const personOptions = useMemo(() => {
    const seen = new Map();
    for (const it of items) if (it.technician?.id != null && !seen.has(it.technician.id)) seen.set(it.technician.id, it.technician.name || `Person #${it.technician.id}`);
    return [
      { value: '', label: 'Everyone' },
      ...[...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => ({ value: String(id), label: name })),
    ];
  }, [items]);
  const levelOptions = useMemo(() => [
    { value: '', label: 'All levels' },
    ...levels.map((value) => ({ value, label: levelLabel(value) })),
  ], [levels]);
  const rowLevelOptions = useMemo(() => levels.map((value) => ({ value, label: levelLabel(value) })), [levels]);

  const visible = useMemo(() => items.filter((it) => (
    (!person || String(it.technician?.id) === person)
    && (!level || it.level === level)
    && (!thinOnly || it.evidence?.belowBar)
  )), [items, person, level, thinOnly]);

  // Server order is weakest evidence first; grouping keeps it inside a person.
  const groups = useMemo(() => {
    const byTech = new Map();
    for (const it of visible) {
      const key = it.technician?.id ?? 0;
      if (!byTech.has(key)) byTech.set(key, { technician: it.technician || { id: key, name: null }, rows: [] });
      byTech.get(key).rows.push(it);
    }
    return [...byTech.values()].sort((a, b) => String(a.technician.name || '').localeCompare(String(b.technician.name || '')));
  }, [visible]);

  // A selection never outlives the rows it points at.
  const visibleIds = useMemo(() => new Set(visible.map((it) => it.id)), [visible]);
  const selectedIds = useMemo(() => [...selected].filter((id) => visibleIds.has(id)), [selected, visibleIds]);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleMany = (ids, on) => setSelected((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });

  const dropRows = (ids) => {
    const gone = new Set(ids);
    setData((prev) => (prev ? { ...prev, items: (prev.items || []).filter((it) => !gone.has(it.id)) } : prev));
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
  };

  const run = async (work, ids, done) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await work();
      dropRows(ids);
      setNotice(done);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'That did not save');
    }
    setBusy(false);
    setConfirmRemove(null);
  };
  const keep = (ids) => run(
    () => assignmentAPI.keepLearnedSkills(ids), ids,
    `${plural(ids.length, 'skill', 'skills')} kept. ${ids.length === 1 ? 'It is' : 'They are'} now a normal part of the matrix.`,
  );
  const remove = (ids) => run(
    () => assignmentAPI.removeLearnedSkills(ids), ids,
    `${plural(ids.length, 'skill', 'skills')} removed.`,
  );
  const changeLevel = (row, next) => {
    if (!next || next === row.level) return undefined;
    return run(
      () => assignmentAPI.setLearnedSkillLevel(row.id, next), [row.id],
      `${row.technician?.name || 'Skill'}: ${categoryLabel(row.category)} set to ${levelLabel(next)} and kept.`,
    );
  };

  const thinCount = items.filter((it) => it.evidence?.belowBar).length;
  const linkBtn = 'tp-focus-ring inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium disabled:opacity-50';

  return (
    <div className="space-y-4" data-testid="learned-skills-tab">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto min-w-0 max-w-2xl">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <GraduationCap className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Learned skills
          </h3>
          <p className="text-xs text-muted-foreground">Skills the system added — confirm or remove.</p>
          <p className="mt-1 text-xs text-muted-foreground/75">
            A skill is added when someone closes a ticket in a category, never when a ticket is assigned:
            {' '}Basic from {thresholds.basic ?? 1} closed, Comfortable from {thresholds.intermediate ?? 10}, Advanced from {thresholds.advanced ?? 25}.
            {' '}Expert is only ever set by a person.
          </p>
        </div>
        <div className="w-44 text-xs text-muted-foreground">
          <span className="mb-0.5 block">Person</span>
          <FancySelect value={person} onChange={setPerson} options={personOptions} aria-label="Filter by person" className="h-8 py-1" />
        </div>
        <div className="w-36 text-xs text-muted-foreground">
          <span className="mb-0.5 block">Level</span>
          <FancySelect value={level} onChange={setLevel} options={levelOptions} aria-label="Filter by level" className="h-8 py-1" />
        </div>
        <label className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={thinOnly} onChange={(e) => setThinOnly(e.target.checked)} className="tp-focus-ring h-3.5 w-3.5 rounded border-input" />
          Thin evidence only
        </label>
        <button type="button" onClick={load} aria-label="Refresh" className="tp-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
          {loading ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>

      {data?.learningEnabled === false && (
        <p className="text-xs text-muted-foreground">Learning from closed tickets is switched off for this workspace, so nothing new is added. The rows below are from before.</p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}

      {items.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="learned-summary">
          {plural(items.length, 'skill', 'skills')} added by the system
          {thinCount > 0 ? ` · ${thinCount} with fewer closed tickets than ${thinCount === 1 ? 'its' : 'their'} level asks for` : ''}
          {visible.length !== items.length ? ` · showing ${visible.length}` : ''}
        </p>
      )}

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2" data-testid="learned-bulk-bar">
          <span className="text-xs font-medium text-foreground">{selectedIds.length} selected</span>
          <button type="button" disabled={busy} onClick={() => keep(selectedIds)} className={`${linkBtn} border border-border bg-card text-foreground hover:bg-muted`}>
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> Keep selected
          </button>
          {confirmRemove === 'bulk' ? (
            <span className="inline-flex items-center gap-1 text-xs text-foreground">
              Remove {plural(selectedIds.length, 'skill', 'skills')}?
              <button type="button" disabled={busy} onClick={() => remove(selectedIds)} className={`${linkBtn} bg-destructive text-destructive-foreground hover:opacity-90`}>Yes, remove</button>
              <button type="button" onClick={() => setConfirmRemove(null)} className={`${linkBtn} text-muted-foreground hover:bg-muted`}>No</button>
            </span>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirmRemove('bulk')} className={`${linkBtn} border border-border bg-card text-destructive hover:bg-muted`}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Remove selected
            </button>
          )}
          <button type="button" onClick={() => setSelected(new Set())} className={`${linkBtn} text-muted-foreground hover:bg-muted`}>Clear</button>
        </div>
      )}

      {loading && !data ? (
        <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" role="status"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading learned skills…</p>
      ) : items.length === 0 ? (
        <div className="py-8 text-center">
          <GraduationCap className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Nothing to review.</p>
          <p className="mt-0.5 text-xs text-muted-foreground/75">Every skill in the matrix was set or confirmed by a person.</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No learned skills match these filters.</p>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => {
            const ids = group.rows.map((r) => r.id);
            const allOn = ids.every((id) => selected.has(id));
            const name = group.technician.name || `Person #${group.technician.id}`;
            return (
              <section key={group.technician.id} data-testid="learned-group" aria-label={name}>
                <div className="flex items-center gap-2 border-b border-border pb-1.5">
                  <input
                    type="checkbox"
                    checked={allOn}
                    onChange={(e) => toggleMany(ids, e.target.checked)}
                    aria-label={`Select all of ${name}'s learned skills`}
                    className="tp-focus-ring h-3.5 w-3.5 rounded border-input"
                  />
                  <PersonAvatar name={group.technician.name} photoUrl={techPhotos?.[group.technician.id]?.photoUrl || null} size="h-6 w-6" textSize="text-[10px]" />
                  <span className="truncate text-sm font-medium text-foreground">{name}</span>
                  <span className="text-xs text-muted-foreground">{plural(group.rows.length, 'skill', 'skills')}</span>
                  {group.technician.isActive === false && <span className="text-xs text-muted-foreground/75">· not on the active team</span>}
                </div>
                <ul className="divide-y divide-border/60">
                  {group.rows.map((row) => {
                    const ev = row.evidence || { closed: 0, aiAssigned: 0 };
                    const label = categoryLabel(row.category);
                    return (
                      <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pl-0.5" data-testid="learned-row">
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          onChange={() => toggle(row.id)}
                          aria-label={`Select ${label} for ${name}`}
                          className="tp-focus-ring h-3.5 w-3.5 rounded border-input"
                        />
                        <div className="min-w-[12rem] flex-1">
                          <span className="block truncate text-sm text-foreground" title={label}>{label}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            Added {formatDateTimeInTimezone(row.createdAt, workspaceTimezone)}
                          </span>
                        </div>
                        <div className="w-56 text-xs" data-testid="learned-evidence">
                          <span className="text-foreground/85">
                            {plural(ev.closed, 'ticket closed', 'tickets closed')}
                            {ev.closed > 0 ? ` · ${ev.aiAssigned} assigned by the AI` : ''}
                          </span>
                          {ev.belowBar && (
                            <span className="block text-[11px] text-amber-700 dark:text-amber-300">
                              {levelLabel(row.level)} asks for {ev.expectedForLevel}
                            </span>
                          )}
                        </div>
                        <div className="w-36">
                          <FancySelect
                            value={row.level}
                            onChange={(next) => changeLevel(row, next)}
                            options={rowLevelOptions}
                            disabled={busy}
                            aria-label={`Level of ${label} for ${name}`}
                            className="h-7 py-0.5 text-xs"
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <button type="button" disabled={busy} onClick={() => keep([row.id])} aria-label={`Keep ${label} for ${name}`} className={`${linkBtn} text-primary hover:bg-muted`}>
                            <Check className="h-3.5 w-3.5" aria-hidden="true" /> Keep
                          </button>
                          {confirmRemove === row.id ? (
                            <span className="inline-flex items-center gap-1 text-xs text-foreground">
                              Remove?
                              <button type="button" disabled={busy} onClick={() => remove([row.id])} className={`${linkBtn} bg-destructive text-destructive-foreground hover:opacity-90`}>Yes</button>
                              <button type="button" onClick={() => setConfirmRemove(null)} className={`${linkBtn} text-muted-foreground hover:bg-muted`}>No</button>
                            </span>
                          ) : (
                            <button type="button" disabled={busy} onClick={() => setConfirmRemove(row.id)} aria-label={`Remove ${label} for ${name}`} className={`${linkBtn} text-muted-foreground hover:bg-muted hover:text-destructive`}>
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Remove
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          <p className="text-[11px] text-muted-foreground/75">
            Keep makes a skill a normal, person-confirmed entry. Remove deletes it; the system adds it again only if that person later closes a ticket in the category.
          </p>
        </div>
      )}
    </div>
  );
}
