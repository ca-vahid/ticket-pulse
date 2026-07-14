import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  Users, Loader, Cloud, Home, Power, PowerOff, Pencil, Check, X,
  AlertCircle, CheckCircle2, MapPin, Mail, Search, UserPlus, Ban, Brain,
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

  const { local, fs } = useMemo(() => {
    const list = members || [];
    return {
      local: list.filter((t) => t.origin === 'local'),
      fs: list.filter((t) => t.origin !== 'local'),
    };
  }, [members]);

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

  const localActive = local.filter((t) => t.isActive).length;
  const localDisabled = local.length - localActive;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 rounded-lg">
          <Users className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Members</h3>
          <p className="text-sm text-gray-500 max-w-2xl">
            FreshService members sync automatically. <strong>Local members</strong> are staff without a
            FreshService license — search your company directory to add them; they can be assigned
            <strong> Ticket Pulse tickets only</strong> and sign in with their Microsoft account.
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
        <>
          {/* Local members */}
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Home className="w-4 h-4 text-blue-600" /> Local members
              <span className="text-xs font-normal text-gray-400">({localActive} active{localDisabled ? `, ${localDisabled} disabled` : ''})</span>
            </div>
            {local.length === 0 ? (
              <p className="text-sm text-gray-400 italic px-1 py-1">
                No local members yet. Use the search above to add staff who aren’t in FreshService.
              </p>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                {local.map((t) => (
                  <MemberRow
                    guidanceOpen={guidanceId === t.id}
                    guidanceDraft={guidanceDraft}
                    setGuidanceDraft={setGuidanceDraft}
                    onOpenGuidance={() => openGuidance(t)}
                    onCloseGuidance={() => setGuidanceId(null)}
                    onSaveGuidance={saveGuidance}
                    guidanceSaving={guidanceSaving}
                    key={t.id}
                    t={t}
                    editable
                    editing={editingId === t.id}
                    editForm={editForm} setEditForm={setEditForm}
                    onStartEdit={() => { setEditingId(t.id); setEditForm({ name: t.name || '', location: t.location || '', timezone: t.timezone || 'America/Los_Angeles' }); setError(null); }}
                    onCancelEdit={() => { setEditingId(null); setError(null); }}
                    onSaveEdit={() => saveEdit(t.id)}
                    onToggle={() => toggleActive(t)}
                    saving={saving}
                    toggling={togglingId === t.id}
                  />
                ))}
              </div>
            )}
          </section>

          {/* FreshService members */}
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Cloud className="w-4 h-4 text-slate-500" /> FreshService members
              <span className="text-xs font-normal text-gray-400">({fs.length}) · synced, read-only</span>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
              {fs.map((t) => (
                <MemberRow
                  key={t.id}
                  t={t}
                  onToggle={() => toggleActive(t)}
                  toggling={togglingId === t.id}
                  guidanceOpen={guidanceId === t.id}
                  guidanceDraft={guidanceDraft}
                  setGuidanceDraft={setGuidanceDraft}
                  onOpenGuidance={() => openGuidance(t)}
                  onCloseGuidance={() => setGuidanceId(null)}
                  onSaveGuidance={saveGuidance}
                  guidanceSaving={guidanceSaving}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MemberRow({ t, editable, editing, editForm, setEditForm, onStartEdit, onCancelEdit, onSaveEdit, onToggle, saving, toggling, guidanceOpen = false, guidanceDraft = '', setGuidanceDraft, onOpenGuidance, onCloseGuidance, onSaveGuidance, guidanceSaving = false }) {
  if (editing) {
    return (
      <div className="tp-card p-3 border-blue-200 ring-1 ring-blue-100 xl:col-span-2">
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
      </div>
    );
  }

  const disabled = !t.isActive;
  return (
    <div className={`group relative flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
      disabled
        ? 'border-dashed border-slate-300 bg-slate-100/70'
        : 'border-slate-200 bg-white hover:border-slate-300'
    }`}>
      {/* Disabled gets a bold red left rail so it's unmistakable at a glance */}
      {disabled && <span className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg bg-red-400" aria-hidden="true" />}
      <Avatar name={t.name} photoUrl={t.photoUrl} dim={disabled} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`text-sm font-medium truncate ${disabled ? 'text-slate-500 line-through decoration-slate-300' : 'text-gray-900'}`}>{t.name}</span>
          {disabled && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-red-100 text-red-700 shrink-0">
              <Ban className="w-3 h-3" /> Disabled
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500 truncate">
          {t.email && <span className="inline-flex items-center gap-1 truncate"><Mail className="w-3 h-3 shrink-0" />{t.email}</span>}
          {t.location && <span className="inline-flex items-center gap-1 shrink-0"><MapPin className="w-3 h-3" />{t.location}</span>}
        </div>
        {t.routingGuidance && !guidanceOpen && (
          <div className="mt-1 flex items-start gap-1 text-[11px] text-violet-700 bg-violet-50 border border-violet-100 rounded-md px-1.5 py-0.5" title="The assignment AI reads this note whenever this person is a candidate">
            <Brain className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-2">{t.routingGuidance}</span>
          </div>
        )}
        {guidanceOpen && (
          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
            <textarea
              value={guidanceDraft}
              onChange={(e) => setGuidanceDraft?.(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. Reduced ticket capacity — only recommend for a significantly stronger skill match or their specialty categories."
              className="w-full px-2.5 py-1.5 border border-violet-200 rounded-lg text-xs tp-focus-ring"
              autoFocus
            />
            <div className="flex items-center gap-2 mt-1">
              <button onClick={onSaveGuidance} disabled={guidanceSaving}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-violet-600 text-white rounded-lg text-[11px] font-semibold hover:bg-violet-700 disabled:opacity-60 tp-focus-ring">
                {guidanceSaving ? <Loader className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save note
              </button>
              <button onClick={onCloseGuidance} className="text-[11px] text-gray-500 hover:text-gray-800 tp-focus-ring rounded px-1.5 py-1">Cancel</button>
              <span className="ml-auto text-[10px] text-gray-400">The AI treats this as a standing instruction from the team lead</span>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {onOpenGuidance && !disabled && !guidanceOpen && (
          <button onClick={onOpenGuidance} title={t.routingGuidance ? 'Edit AI routing note' : 'Add AI routing note (e.g. reduced capacity)'}
            className={`p-1.5 rounded-lg tp-focus-ring ${t.routingGuidance ? 'text-violet-600 hover:text-violet-800' : 'text-gray-400 hover:text-violet-600'}`}>
            <Brain className="w-4 h-4" />
          </button>
        )}
        {editable && !disabled && (
          <button onClick={onStartEdit} title="Edit" className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg tp-focus-ring">
            <Pencil className="w-4 h-4" />
          </button>
        )}
        <button onClick={onToggle} disabled={toggling} title={t.isActive ? 'Disable' : 'Re-enable'}
          className={`p-1.5 rounded-lg tp-focus-ring ${t.isActive ? 'text-gray-400 hover:text-red-600' : 'text-emerald-600 hover:text-emerald-700'}`}>
          {toggling ? <Loader className="w-4 h-4 animate-spin" /> : t.isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
