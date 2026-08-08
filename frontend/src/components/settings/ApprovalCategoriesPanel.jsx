import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  Stamp, Loader, Plus, Pencil, Trash2, Check, X, AlertCircle, CheckCircle2,
  Search, UserPlus, Users, Power, PowerOff, Ban,
} from 'lucide-react';

function initials(name) {
  return (name || '?').split(/[\s@.]+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

function Avatar({ name, photoUrl, size = 'h-6 w-6' }) {
  return (
    <span className={`${size} rounded-full bg-slate-100 overflow-hidden inline-flex items-center justify-center shrink-0`}>
      {photoUrl
        ? <img src={photoUrl} alt="" className="w-full h-full object-cover" />
        : <span className="text-[9px] font-semibold text-slate-500">{initials(name)}</span>}
    </span>
  );
}

/**
 * Approval-manager picker — workspace members first, then the Entra directory
 * for anyone else (admins/coordinators who aren't technicians — QA 07-06 #7).
 * Approvals key on EMAIL: any picked person can decide via the emailed magic
 * link, and in-app if they can sign in.
 */
function MemberPicker({ members, exclude = [], onPick }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [directoryResults, setDirectoryResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const memberResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members || [])
      .filter((m) => m.isActive !== false && m.email && !exclude.includes(m.email.toLowerCase()))
      .filter((m) => !q || (m.name || '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .slice(0, 6);
  }, [members, query, exclude]);

  // Directory search (debounced) surfaces people who aren't workspace members.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setDirectoryResults([]); return undefined; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await settingsAPI.searchDirectory(q);
        const memberEmails = new Set((members || []).map((m) => String(m.email || '').toLowerCase()));
        setDirectoryResults((res.data || [])
          .filter((p) => p.mail && !memberEmails.has(p.mail.toLowerCase()) && !exclude.includes(p.mail.toLowerCase()))
          .slice(0, 5));
      } catch { setDirectoryResults([]); }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, members, exclude]);

  const pick = (email) => { onPick(String(email).toLowerCase()); setQuery(''); setDirectoryResults([]); setOpen(false); };

  const row = (key, name, email, badge, photoUrl) => (
    <button
      key={key}
      type="button"
      onClick={() => pick(email)}
      className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left hover:bg-blue-50 tp-focus-ring"
    >
      <Avatar name={name} photoUrl={photoUrl} size="h-9 w-9" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-gray-900 truncate">{name || email}</span>
        <span className="block text-xs text-gray-500 truncate">{email}</span>
      </span>
      {badge && <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">{badge}</span>}
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 shrink-0"><UserPlus className="w-3.5 h-3.5" /> Add</span>
    </button>
  );

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Add an approval manager — search members or the directory…"
          className="w-full pl-10 pr-3 py-2.5 border border-input rounded-lg text-sm tp-focus-ring"
        />
      </div>
      {open && (
        <div className="absolute z-30 mt-1 w-full tp-card rounded-xl shadow-soft p-1.5 max-h-72 overflow-y-auto settings-scrollbar animate-scaleIn">
          {memberResults.map((m) => row(`m-${m.email}`, m.name, m.email, null, m.photoUrl))}
          {directoryResults.length > 0 && (
            <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Directory</p>
          )}
          {directoryResults.map((p) => row(`d-${p.mail}`, p.displayName, p.mail, 'directory', p.photoUrl))}
          {searching && <p className="px-3 py-2 text-xs text-slate-400">Searching directory…</p>}
          {!searching && memberResults.length === 0 && directoryResults.length === 0 && (
            <div className="px-3 py-4 text-sm text-slate-400">
              {query.trim().length >= 2 ? `No one matches “${query}”.` : 'Type at least 2 characters to search the directory.'}
              <span className="block text-[11px] mt-0.5">Anyone with an email can approve via the emailed link; members and admins can also decide in-app.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Enriched manager chip: avatar + display name (falls back to email). */
function ManagerChip({ email, member, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-xs text-blue-900">
      <Avatar name={member?.name || email} photoUrl={member?.photoUrl} size="h-5 w-5" />
      <span className="truncate max-w-[180px]">{member?.name || email}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${email}`} className="tp-focus-ring rounded-full p-0.5 hover:bg-blue-100 text-blue-500">
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

const emptyForm = { name: '', description: '', managerEmails: [] };

function CategoryForm({ initial, members, memberByEmail, onCancel, onSave, saving }) {
  const [form, setForm] = useState(initial || emptyForm);
  const addEmail = (email) => setForm((f) => (f.managerEmails.includes(email) ? f : { ...f, managerEmails: [...f.managerEmails, email] }));
  const removeEmail = (email) => setForm((f) => ({ ...f, managerEmails: f.managerEmails.filter((x) => x !== email) }));

  return (
    <div className="tp-card p-4 border-blue-200 ring-1 ring-blue-100 space-y-3">
      <input
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        placeholder="Category name (e.g. Laptop purchase)"
        className="w-full px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring"
      />
      <input
        value={form.description}
        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        placeholder="Description (optional)"
        className="w-full px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring"
      />
      <div>
        <p className="text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> Approval managers <span className="font-normal text-slate-400">(any one can approve)</span></p>
        {form.managerEmails.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {form.managerEmails.map((email) => (
              <ManagerChip key={email} email={email} member={memberByEmail[email]} onRemove={() => removeEmail(email)} />
            ))}
          </div>
        )}
        <MemberPicker members={members} exclude={form.managerEmails} onPick={addEmail} />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={saving || !form.name.trim() || form.managerEmails.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50 tp-focus-ring"
        >
          {saving ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
        </button>
        <button type="button" onClick={onCancel} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 tp-focus-ring rounded-lg">
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
        {form.managerEmails.length === 0 && <span className="text-[11px] text-amber-600">Add at least one manager</span>}
      </div>
    </div>
  );
}

export default function ApprovalCategoriesPanel() {
  const { currentWorkspace } = useWorkspace();
  const [categories, setCategories] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const memberByEmail = useMemo(() => {
    const map = {};
    for (const m of members) if (m.email) map[m.email.toLowerCase()] = m;
    return map;
  }, [members]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [cats, techs] = await Promise.all([
        settingsAPI.getApprovalCategories(),
        settingsAPI.getTechnicians(),
      ]);
      setCategories(cats.data || []);
      setMembers((techs.data || []).filter((t) => t.isActive !== false));
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load approval categories');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  const flash = (msg) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(null), 4000); };

  const create = async (form) => {
    setSaving(true); setError(null);
    try {
      await settingsAPI.createApprovalCategory({ name: form.name.trim(), description: form.description.trim() || null, managerEmails: form.managerEmails });
      flash(`“${form.name.trim()}” created.`);
      setCreating(false);
      await load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
    finally { setSaving(false); }
  };

  const saveEdit = async (id, form) => {
    setSaving(true); setError(null);
    try {
      await settingsAPI.updateApprovalCategory(id, { name: form.name.trim(), description: form.description.trim() || null, managerEmails: form.managerEmails });
      flash('Category updated.');
      setEditingId(null);
      await load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
    finally { setSaving(false); }
  };

  const toggleActive = async (c) => {
    setError(null);
    try {
      await settingsAPI.updateApprovalCategory(c.id, { isActive: !c.isActive });
      flash(`“${c.name}” ${c.isActive ? 'deactivated' : 'reactivated'}.`);
      await load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
  };

  const remove = async (c) => {
    setError(null);
    try {
      await settingsAPI.deleteApprovalCategory(c.id);
      flash(`“${c.name}” deleted.`);
      setConfirmDeleteId(null);
      await load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 rounded-lg"><Stamp className="w-5 h-5 text-blue-600" /></div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Approval Categories</h3>
          <p className="text-sm text-gray-500 max-w-2xl">
            Define what needs sign-off (e.g. <strong>Laptop purchase</strong>) and which <strong>members</strong> approve it.
            On a ticket, a member requests approval by category and every manager is notified — <strong>any one</strong> can
            approve, reject, or ask for more info. Approvals stay inside Ticket Pulse.
            Workspace <strong>reviewers</strong> can manage these too — no admin needed.
          </p>
        </div>
      </div>

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

      {creating ? (
        <CategoryForm members={members} memberByEmail={memberByEmail} onCancel={() => setCreating(false)} onSave={create} saving={saving} />
      ) : (
        <button
          type="button"
          onClick={() => { setCreating(true); setEditingId(null); }}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-blue-700 tp-focus-ring"
        >
          <Plus className="w-4 h-4" /> New approval category
        </button>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400"><Loader className="w-5 h-5 animate-spin mr-2" /> Loading…</div>
      ) : (categories || []).length === 0 ? (
        <p className="text-sm text-gray-400 italic px-1">No approval categories yet. Create one above to enable ticket approvals.</p>
      ) : (
        <div className="space-y-2">
          {categories.map((c) => (
            editingId === c.id ? (
              <CategoryForm
                key={c.id}
                initial={{ name: c.name, description: c.description || '', managerEmails: c.managerEmails || [] }}
                members={members}
                memberByEmail={memberByEmail}
                onCancel={() => setEditingId(null)}
                onSave={(form) => saveEdit(c.id, form)}
                saving={saving}
              />
            ) : (
              <div key={c.id} className={`relative rounded-lg border px-3.5 py-3 ${c.isActive ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-100/70'}`}>
                {!c.isActive && <span className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg bg-red-400" aria-hidden="true" />}
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-sm font-semibold ${c.isActive ? 'text-gray-900' : 'text-slate-500'}`}>{c.name}</span>
                      {!c.isActive && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-red-100 text-red-700"><Ban className="w-3 h-3" /> Inactive</span>
                      )}
                    </div>
                    {c.description && <p className="text-xs text-slate-500 mt-0.5">{c.description}</p>}
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {(c.managerEmails || []).length === 0
                        ? <span className="text-[11px] text-amber-600">No managers — add some so this can be used</span>
                        : (c.managerEmails || []).map((email) => (
                          <ManagerChip key={email} email={email} member={memberByEmail[email.toLowerCase()]} />
                        ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button onClick={() => { setEditingId(c.id); setCreating(false); }} title="Edit" className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg tp-focus-ring"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => toggleActive(c)} title={c.isActive ? 'Deactivate' : 'Reactivate'} className={`p-1.5 rounded-lg tp-focus-ring ${c.isActive ? 'text-gray-400 hover:text-red-600' : 'text-emerald-600 hover:text-emerald-700'}`}>
                      {c.isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                    </button>
                    {confirmDeleteId === c.id ? (
                      <span className="inline-flex items-center gap-1">
                        <button onClick={() => remove(c)} className="px-2 py-1 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700 tp-focus-ring">Delete</button>
                        <button onClick={() => setConfirmDeleteId(null)} className="p-1 text-slate-400 hover:text-slate-600 rounded tp-focus-ring"><X className="w-4 h-4" /></button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmDeleteId(c.id)} title="Delete" className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg tp-focus-ring"><Trash2 className="w-4 h-4" /></button>
                    )}
                  </div>
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}
