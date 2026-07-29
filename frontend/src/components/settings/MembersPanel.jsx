import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel, flexRender, createColumnHelper,
} from '@tanstack/react-table';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  Users, Loader, Cloud, Home, Power, PowerOff, Pencil, Check, X,
  AlertCircle, CheckCircle2, MapPin, Search, UserPlus, Brain,
  ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';

const COMMON_TIMEZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Toronto', 'America/Vancouver', 'UTC',
];

function Avatar({ name, photoUrl, size = 'h-8 w-8', dim = false }) {
  return (
    <div className={`${size} rounded-full bg-slate-100 overflow-hidden flex items-center justify-center shrink-0 ${dim ? 'grayscale opacity-60' : ''}`}>
      {photoUrl
        ? <img src={photoUrl} alt="" className="w-full h-full object-cover" />
        : <span className="text-[10px] font-semibold text-slate-500">{(name || '?').split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}</span>}
    </div>
  );
}

/** Entra (GAL) typeahead — search the directory, click a person to add them. */
function DirectoryAdd({ onAdded, onError }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [addingEmail, setAddingEmail] = useState(null);
  const debounceRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const doSearch = useCallback(async (q) => {
    if (q.trim().length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    try {
      const res = await settingsAPI.searchDirectory(q.trim());
      setResults(res.data || []);
      setOpen(true);
    } catch (err) {
      onError?.(err.response?.data?.message || err.message);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [onError]);

  const handleChange = (v) => {
    setQuery(v);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    debounceRef.current = setTimeout(() => doSearch(v), 300);
  };

  const add = async (person) => {
    if (person.alreadyMemberActive) return;
    setAddingEmail(person.email);
    onError?.(null);
    try {
      await settingsAPI.createLocalAgent({
        name: person.name,
        email: person.email,
        photoUrl: person.photoUrl || undefined,
      });
      setQuery(''); setResults([]); setOpen(false);
      onAdded?.(person.name);
    } catch (err) {
      onError?.(err.response?.data?.message || err.message);
    } finally {
      setAddingEmail(null);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => { if (results.length) setOpen(true); }}
          placeholder="Search your company directory by name or email…"
          className="w-full pl-10 pr-9 py-2.5 border border-input rounded-lg text-sm tp-focus-ring"
        />
        {searching && <Loader className="w-4 h-4 text-slate-400 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
      </div>

      {open && query.trim().length >= 2 && (
        <div className="absolute z-30 mt-1 w-full tp-card rounded-xl shadow-soft p-1.5 max-h-80 overflow-y-auto settings-scrollbar animate-scaleIn">
          {searching && results.length === 0 && (
            <div className="px-3 py-4 text-sm text-slate-400 flex items-center gap-2"><Loader className="w-4 h-4 animate-spin" /> Searching directory…</div>
          )}
          {!searching && results.length === 0 && (
            <div className="px-3 py-4 text-sm text-slate-400">No one in the directory matches “{query}”.</div>
          )}
          {results.map((p) => {
            const busy = addingEmail === p.email;
            const disabled = p.alreadyMemberActive || busy;
            return (
              <button
                key={p.email}
                type="button"
                onClick={() => add(p)}
                disabled={disabled}
                className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left tp-focus-ring ${
                  p.alreadyMemberActive ? 'opacity-60 cursor-default' : 'hover:bg-blue-50'
                }`}
              >
                <Avatar name={p.name} photoUrl={p.photoUrl} size="h-9 w-9" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {p.email}{p.jobTitle ? ` · ${p.jobTitle}` : ''}
                  </div>
                </div>
                {p.alreadyMemberActive ? (
                  <span className="text-[11px] font-medium text-slate-400 shrink-0">Already added</span>
                ) : busy ? (
                  <Loader className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 shrink-0">
                    {p.alreadyMember ? <><Power className="w-3.5 h-3.5" /> Re-add</> : <><UserPlus className="w-3.5 h-3.5" /> Add</>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Members panel, rebuilt as ONE sortable/filterable table (QA 07-29).
 *
 * The old layout was two alphabetical columns snaking left→right (unscannable),
 * with a shouting red DISABLED badge + red rail on most rows (46 of 68 members
 * are disabled — that's a normal state, not an alarm) and no search or filter.
 *
 * Now: TanStack Table (headless — logic only, all styling is ours) drives a
 * single dense table with sortable Name / Type / Location / Status columns,
 * a search box, and count-labelled filter chips. The default view is ACTIVE
 * members only, which removes ~⅔ of the rows an admin never cares about.
 * Disabled rows (in their filter) are dimmed with a quiet slate pill.
 */
const FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'disabled', label: 'Disabled' },
  { key: 'local', label: 'Local' },
  { key: 'fs', label: 'FreshService' },
  { key: 'all', label: 'All' },
];

const columnHelper = createColumnHelper();

export default function MembersPanel() {
  const { currentWorkspace } = useWorkspace();
  const [members, setMembers] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', location: '', timezone: 'America/Los_Angeles' });
  const [togglingId, setTogglingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('active');
  const [searchQ, setSearchQ] = useState('');
  const [sorting, setSorting] = useState([{ id: 'name', desc: false }]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await settingsAPI.getTechnicians();
      setMembers(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  const flash = (msg) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(null), 4000); };

  const counts = useMemo(() => {
    const list = members || [];
    return {
      all: list.length,
      active: list.filter((t) => t.isActive).length,
      disabled: list.filter((t) => !t.isActive).length,
      local: list.filter((t) => t.origin === 'local').length,
      fs: list.filter((t) => t.origin !== 'local').length,
    };
  }, [members]);

  const rows = useMemo(() => {
    let list = members || [];
    if (filter === 'active') list = list.filter((t) => t.isActive);
    else if (filter === 'disabled') list = list.filter((t) => !t.isActive);
    else if (filter === 'local') list = list.filter((t) => t.origin === 'local');
    else if (filter === 'fs') list = list.filter((t) => t.origin !== 'local');
    const q = searchQ.trim().toLowerCase();
    if (q) {
      list = list.filter((t) => [t.name, t.email, t.location]
        .some((v) => String(v || '').toLowerCase().includes(q)));
    }
    return list;
  }, [members, filter, searchQ]);

  const saveEdit = useCallback(async (id) => {
    if (!editForm.name.trim()) { setError('Name is required.'); return; }
    setSaving(true); setError(null);
    try {
      await settingsAPI.updateTechnician(id, {
        name: editForm.name.trim(),
        location: editForm.location.trim(),
        timezone: editForm.timezone,
      });
      flash('Member updated.');
      setEditingId(null);
      await load();
    } catch (err) { setError(err.message || 'Failed to update member'); }
    finally { setSaving(false); }
  }, [editForm, load]);

  const toggleActive = useCallback(async (t) => {
    setTogglingId(t.id); setError(null);
    try {
      await settingsAPI.setTechnicianActive(t.id, !t.isActive);
      flash(`${t.name} ${t.isActive ? 'disabled' : 're-enabled'}.`);
      await load();
    } catch (err) { setError(err.message || 'Failed to change status'); }
    finally { setTogglingId(null); }
  }, [load]);

  // AI routing guidance (QA 07-14): a standing instruction the assignment AI
  // reads whenever this person is a candidate — e.g. reduced capacity.
  const [guidanceId, setGuidanceId] = useState(null);
  const [guidanceDraft, setGuidanceDraft] = useState('');
  const [guidanceSaving, setGuidanceSaving] = useState(false);
  const openGuidance = useCallback((t) => {
    setGuidanceId(t.id);
    setGuidanceDraft(t.routingGuidance || '');
  }, []);
  const saveGuidance = useCallback(async () => {
    setGuidanceSaving(true); setError(null);
    try {
      await settingsAPI.updateTechnician(guidanceId, { routingGuidance: guidanceDraft });
      flash(guidanceDraft.trim() ? 'AI routing note saved — it applies from the next run.' : 'AI routing note removed.');
      setGuidanceId(null);
      await load();
    } catch (err) { setError(err.message || 'Failed to save routing note'); }
    finally { setGuidanceSaving(false); }
  }, [guidanceId, guidanceDraft, load]);

  const columns = useMemo(() => [
    columnHelper.accessor('name', {
      id: 'name',
      header: 'Member',
      cell: ({ row }) => {
        const t = row.original;
        return (
          <div className="flex items-center gap-2.5 min-w-0">
            <Avatar name={t.name} photoUrl={t.photoUrl} dim={!t.isActive} />
            <div className="min-w-0">
              <div className={`text-sm font-medium truncate ${t.isActive ? 'text-gray-900' : 'text-slate-500'}`}>
                {t.name}
                {t.routingGuidance && (
                  <Brain className="inline-block w-3.5 h-3.5 ml-1.5 -mt-0.5 text-violet-500" aria-label="Has an AI routing note" title={t.routingGuidance} />
                )}
              </div>
              <div className="text-xs text-gray-500 truncate">{t.email || '—'}</div>
            </div>
          </div>
        );
      },
    }),
    columnHelper.accessor((t) => (t.origin === 'local' ? 'Local' : 'FreshService'), {
      id: 'type',
      header: 'Type',
      cell: ({ getValue }) => (getValue() === 'Local' ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
          <Home className="w-3 h-3" aria-hidden="true" /> Local
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-50 text-slate-500 border border-slate-200">
          <Cloud className="w-3 h-3" aria-hidden="true" /> FreshService
        </span>
      )),
    }),
    columnHelper.accessor((t) => t.location || '', {
      id: 'location',
      header: 'Location',
      cell: ({ getValue }) => (getValue() ? (
        <span className="inline-flex items-center gap-1 text-xs text-gray-600">
          <MapPin className="w-3 h-3 text-slate-400" aria-hidden="true" />{getValue()}
        </span>
      ) : <span className="text-xs text-slate-300">—</span>),
    }),
    columnHelper.accessor((t) => (t.isActive ? 0 : 1), {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (row.original.isActive ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> Active
        </span>
      ) : (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
          Disabled
        </span>
      )),
    }),
  ], []);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const colSpanAll = columns.length + 1; // + actions column

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 rounded-lg">
          <Users className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Members</h3>
          <p className="text-sm text-gray-500 max-w-2xl">
            FreshService members sync automatically (read-only). <strong>Local members</strong> are staff without a
            FreshService license — they can be assigned <strong>Ticket Pulse tickets only</strong> and sign in with
            their Microsoft account.
          </p>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /><span>{successMsg}</span>
        </div>
      )}

      {/* Add via directory */}
      <div className="tp-card p-3.5 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <UserPlus className="w-4 h-4 text-blue-600" /> Add a local member
          {currentWorkspace?.name && <span className="text-xs font-normal text-gray-500">to {currentWorkspace.name}</span>}
        </div>
        <DirectoryAdd onAdded={(name) => { flash(`${name} added from the directory.`); load(); }} onError={setError} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader className="w-5 h-5 animate-spin mr-2" /> Loading members…
        </div>
      ) : (
        <div className="tp-card rounded-xl overflow-hidden">
          {/* Toolbar: search + filter chips with live counts */}
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/60 px-3 py-2.5">
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search name, email, location…"
                aria-label="Search members"
                className="w-full pl-8 pr-3 py-1.5 border border-input rounded-lg text-sm bg-white tp-focus-ring"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter members">
              {FILTERS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  aria-pressed={filter === key}
                  className={`tp-focus-ring px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
                    filter === key
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {label} <span className={filter === key ? 'opacity-80' : 'text-slate-400'}>{counts[key]}</span>
                </button>
              ))}
            </div>
            <span className="ml-auto hidden md:inline text-xs text-slate-400">
              {rows.length} shown · click a column to sort
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      const hideOnMobile = header.column.id === 'type' ? 'hidden md:table-cell'
                        : header.column.id === 'location' ? 'hidden lg:table-cell' : '';
                      return (
                        <th key={header.id} className={`px-3 py-2 ${hideOnMobile}`}>
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="tp-focus-ring inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-slate-700"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === 'asc' ? <ArrowUp className="w-3 h-3" aria-hidden="true" />
                              : sorted === 'desc' ? <ArrowDown className="w-3 h-3" aria-hidden="true" />
                                : <ArrowUpDown className="w-3 h-3 opacity-40" aria-hidden="true" />}
                          </button>
                        </th>
                      );
                    })}
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {table.getRowModel().rows.length === 0 && (
                  <tr>
                    <td colSpan={colSpanAll} className="px-3 py-8 text-center text-sm text-slate-400">
                      {searchQ ? `No members match “${searchQ}” in this filter.` : 'No members in this filter.'}
                    </td>
                  </tr>
                )}
                {table.getRowModel().rows.map((row) => {
                  const t = row.original;
                  const isLocal = t.origin === 'local';
                  const editing = editingId === t.id;
                  const guidanceOpen = guidanceId === t.id;
                  return (
                    <MemberTableRow
                      key={t.id}
                      row={row}
                      t={t}
                      colSpanAll={colSpanAll}
                      editing={editing}
                      editForm={editForm}
                      setEditForm={setEditForm}
                      onStartEdit={isLocal ? () => { setEditingId(t.id); setEditForm({ name: t.name || '', location: t.location || '', timezone: t.timezone || 'America/Los_Angeles' }); setError(null); } : null}
                      onCancelEdit={() => { setEditingId(null); setError(null); }}
                      onSaveEdit={() => saveEdit(t.id)}
                      saving={saving}
                      onToggle={() => toggleActive(t)}
                      toggling={togglingId === t.id}
                      guidanceOpen={guidanceOpen}
                      guidanceDraft={guidanceDraft}
                      setGuidanceDraft={setGuidanceDraft}
                      onOpenGuidance={() => openGuidance(t)}
                      onCloseGuidance={() => setGuidanceId(null)}
                      onSaveGuidance={saveGuidance}
                      guidanceSaving={guidanceSaving}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MemberTableRow({
  row, t, colSpanAll, editing, editForm, setEditForm, onStartEdit, onCancelEdit, onSaveEdit, saving,
  onToggle, toggling, guidanceOpen, guidanceDraft, setGuidanceDraft, onOpenGuidance, onCloseGuidance, onSaveGuidance, guidanceSaving,
}) {
  return (
    <>
      <tr className={`transition-colors hover:bg-slate-50/70 ${t.isActive ? '' : 'opacity-70'}`}>
        {row.getVisibleCells().map((cell) => {
          const hideOnMobile = cell.column.id === 'type' ? 'hidden md:table-cell'
            : cell.column.id === 'location' ? 'hidden lg:table-cell' : '';
          return (
            <td key={cell.id} className={`px-3 py-2 ${hideOnMobile}`}>
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </td>
          );
        })}
        <td className="px-3 py-2">
          <div className="flex items-center justify-end gap-0.5">
            {t.isActive && !guidanceOpen && (
              <button onClick={onOpenGuidance} title={t.routingGuidance ? 'Edit AI routing note' : 'Add AI routing note (e.g. reduced capacity)'}
                className={`p-1.5 rounded-lg tp-focus-ring ${t.routingGuidance ? 'text-violet-600 hover:text-violet-800' : 'text-gray-400 hover:text-violet-600'}`}>
                <Brain className="w-4 h-4" />
              </button>
            )}
            {onStartEdit && t.isActive && !editing && (
              <button onClick={onStartEdit} title="Edit name / location / timezone" className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg tp-focus-ring">
                <Pencil className="w-4 h-4" />
              </button>
            )}
            <button onClick={onToggle} disabled={toggling} title={t.isActive ? 'Disable' : 'Re-enable'}
              className={`p-1.5 rounded-lg tp-focus-ring ${t.isActive ? 'text-gray-400 hover:text-red-600' : 'text-emerald-600 hover:text-emerald-700'}`}>
              {toggling ? <Loader className="w-4 h-4 animate-spin" /> : t.isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded editors render as a full-width row directly under the member */}
      {editing && (
        <tr className="bg-blue-50/40">
          <td colSpan={colSpanAll} className="px-3 py-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Name" className="px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring" />
              <input value={editForm.location} onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))}
                placeholder="Location" className="px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring" />
              <select value={editForm.timezone} onChange={(e) => setEditForm((f) => ({ ...f, timezone: e.target.value }))}
                className="px-3 py-2 border border-input rounded-lg text-sm bg-white tp-focus-ring">
                {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <button onClick={onSaveEdit} disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-60 tp-focus-ring">
                {saving ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
              </button>
              <button onClick={onCancelEdit} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 tp-focus-ring rounded-lg">
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
      {guidanceOpen && (
        <tr className="bg-violet-50/40">
          <td colSpan={colSpanAll} className="px-3 py-3">
            <textarea
              value={guidanceDraft}
              onChange={(e) => setGuidanceDraft?.(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. Reduced ticket capacity — only recommend for a significantly stronger skill match or their specialty categories."
              className="w-full px-2.5 py-1.5 border border-violet-200 rounded-lg text-xs tp-focus-ring"
              autoFocus
            />
            <div className="flex items-center gap-2 mt-1.5">
              <button onClick={onSaveGuidance} disabled={guidanceSaving}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-violet-600 text-white rounded-lg text-[11px] font-semibold hover:bg-violet-700 disabled:opacity-60 tp-focus-ring">
                {guidanceSaving ? <Loader className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save note
              </button>
              <button onClick={onCloseGuidance} className="text-[11px] text-gray-500 hover:text-gray-800 tp-focus-ring rounded px-1.5 py-1">Cancel</button>
              <span className="ml-auto text-[10px] text-gray-400">The AI treats this as a standing instruction from the team lead</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
