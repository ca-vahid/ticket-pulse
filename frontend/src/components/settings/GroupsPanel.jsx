import { useState, useEffect, useCallback, useMemo } from 'react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  Users2, Plus, Loader, Cloud, Home, Power, PowerOff, Pencil, Check, X,
  AlertCircle, CheckCircle2, UsersRound, Search,
} from 'lucide-react';

const EMPTY = { name: '', description: '' };

export default function GroupsPanel() {
  const { currentWorkspace } = useWorkspace();
  const [groups, setGroups] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY);
  const [togglingId, setTogglingId] = useState(null);

  // membership editor state
  const [membersFor, setMembersFor] = useState(null); // groupId
  const [memberIds, setMemberIds] = useState(new Set());
  const [memberQuery, setMemberQuery] = useState('');
  const [savingMembers, setSavingMembers] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [g, t] = await Promise.all([settingsAPI.getGroups(), settingsAPI.getTechnicians()]);
      setGroups(g.data || []);
      setTechnicians((t.data || []).filter((x) => x.isActive));
    } catch (err) {
      setError(err.message || 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  const flash = (msg) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(null), 4000); };

  const { internal, fs } = useMemo(() => {
    const list = groups || [];
    return {
      internal: list.filter((g) => g.origin === 'local'),
      fs: list.filter((g) => g.origin !== 'local'),
    };
  }, [groups]);

  const handleCreate = useCallback(async () => {
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setSaving(true); setError(null);
    try {
      await settingsAPI.createInternalGroup({ name: form.name.trim(), description: form.description.trim() || undefined });
      flash(`Group "${form.name.trim()}" created.`);
      setForm(EMPTY); setShowAdd(false);
      await load();
    } catch (err) { setError(err.message || 'Failed to create group'); }
    finally { setSaving(false); }
  }, [form, load]);

  const saveEdit = useCallback(async (id) => {
    if (!editForm.name.trim()) { setError('Name is required.'); return; }
    setSaving(true); setError(null);
    try {
      await settingsAPI.updateGroup(id, { name: editForm.name.trim(), description: editForm.description.trim() });
      flash('Group updated.');
      setEditingId(null);
      await load();
    } catch (err) { setError(err.message || 'Failed to update group'); }
    finally { setSaving(false); }
  }, [editForm, load]);

  const toggleActive = useCallback(async (g) => {
    setTogglingId(g.id); setError(null);
    try {
      await settingsAPI.updateGroup(g.id, { isActive: !g.isActive });
      flash(`${g.name} ${g.isActive ? 'deactivated' : 'reactivated'}.`);
      await load();
    } catch (err) { setError(err.message || 'Failed to change status'); }
    finally { setTogglingId(null); }
  }, [load]);

  const openMembers = useCallback(async (g) => {
    if (membersFor === g.id) { setMembersFor(null); return; }
    setMembersFor(g.id); setMemberQuery(''); setError(null);
    try {
      const res = await settingsAPI.getGroupMembers(g.id);
      setMemberIds(new Set((res.data || []).map((m) => m.id)));
    } catch (err) { setError(err.message || 'Failed to load members'); }
  }, [membersFor]);

  const saveMembers = useCallback(async (groupId) => {
    setSavingMembers(true); setError(null);
    try {
      const res = await settingsAPI.setGroupMembers(groupId, [...memberIds]);
      flash(`Membership saved (${res.data?.memberCount ?? memberIds.size} member${(res.data?.memberCount ?? memberIds.size) === 1 ? '' : 's'}).`);
      setMembersFor(null);
      await load();
    } catch (err) { setError(err.message || 'Failed to save members'); }
    finally { setSavingMembers(false); }
  }, [memberIds, load]);

  const toggleMember = (id) => setMemberIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const filteredTechs = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    return q ? technicians.filter((t) => t.name.toLowerCase().includes(q)) : technicians;
  }, [technicians, memberQuery]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Users2 className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Groups</h3>
            <p className="text-sm text-gray-500 max-w-2xl">
              FreshService groups sync automatically. <strong>Internal groups</strong> are Ticket Pulse–owned
              routing groups with their own membership — use them to route mailboxes and Ticket Pulse tickets
              without a FreshService group.
            </p>
          </div>
        </div>
        {!showAdd && (
          <button
            onClick={() => { setShowAdd(true); setForm(EMPTY); setError(null); }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 tp-focus-ring shrink-0"
          >
            <Plus className="w-4 h-4" /> New internal group
          </button>
        )}
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

      {showAdd && (
        <div className="tp-card p-4 space-y-4 animate-scaleIn">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Home className="w-4 h-4 text-blue-600" /> New internal group
            {currentWorkspace?.name && <span className="text-xs font-normal text-gray-500">in {currentWorkspace.name}</span>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Name *</span>
              <input
                autoFocus value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Accounts Receivable"
                className="mt-1 w-full px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Description</span>
              <input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional"
                className="mt-1 w-full px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleCreate} disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-60 tp-focus-ring">
              {saving ? <Loader className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create group
            </button>
            <button onClick={() => { setShowAdd(false); setError(null); }}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 tp-focus-ring rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader className="w-5 h-5 animate-spin mr-2" /> Loading groups…
        </div>
      ) : (
        <>
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Home className="w-4 h-4 text-blue-600" /> Internal groups
              <span className="text-xs font-normal text-gray-400">({internal.length})</span>
            </div>
            {internal.length === 0 ? (
              <p className="text-sm text-gray-400 italic px-1 py-2">
                No internal groups yet. Create one to route mailboxes and Ticket Pulse tickets without a FreshService group.
              </p>
            ) : (
              <div className="space-y-2">
                {internal.map((g) => (
                  <div key={g.id} className="space-y-0">
                    <GroupRow
                      g={g}
                      editing={editingId === g.id}
                      editForm={editForm} setEditForm={setEditForm}
                      onStartEdit={() => { setEditingId(g.id); setEditForm({ name: g.name, description: g.description || '' }); setError(null); }}
                      onCancelEdit={() => { setEditingId(null); setError(null); }}
                      onSaveEdit={() => saveEdit(g.id)}
                      onToggle={() => toggleActive(g)}
                      onManageMembers={() => openMembers(g)}
                      membersOpen={membersFor === g.id}
                      saving={saving}
                      toggling={togglingId === g.id}
                    />
                    {membersFor === g.id && (
                      <div className="mt-1 tp-card p-3 border-blue-200 ring-1 ring-blue-100 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-gray-800">Members ({memberIds.size})</span>
                          <div className="flex items-center gap-2">
                            <button onClick={() => saveMembers(g.id)} disabled={savingMembers}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-60 tp-focus-ring">
                              {savingMembers ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
                            </button>
                            <button onClick={() => setMembersFor(null)}
                              className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 tp-focus-ring rounded-lg">Close</button>
                          </div>
                        </div>
                        <div className="relative">
                          <Search className="w-3.5 h-3.5 text-slate-300 absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <input value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)}
                            placeholder="Find member…"
                            className="w-full pl-8 pr-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg placeholder:text-slate-400 tp-focus-ring" />
                        </div>
                        <div className="max-h-56 overflow-y-auto settings-scrollbar space-y-1">
                          {filteredTechs.map((t) => (
                            <label key={t.id}
                              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-slate-50 ${memberIds.has(t.id) ? 'bg-blue-50/70' : ''}`}>
                              <input type="checkbox" checked={memberIds.has(t.id)} onChange={() => toggleMember(t.id)}
                                className="rounded border-slate-300 text-primary focus:ring-primary" />
                              <span className="text-sm text-slate-700">{t.name}</span>
                              {t.origin === 'local' && (
                                <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 text-blue-600">Local</span>
                              )}
                            </label>
                          ))}
                          {filteredTechs.length === 0 && <p className="px-2 py-2 text-xs text-slate-400">No member matches “{memberQuery}”.</p>}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Cloud className="w-4 h-4 text-slate-500" /> FreshService groups
              <span className="text-xs font-normal text-gray-400">({fs.length})</span>
              <span className="text-xs font-normal text-gray-400">· synced, read-only</span>
            </div>
            <div className="space-y-2">
              {fs.map((g) => <GroupRow key={g.id} g={g} readOnly />)}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function OriginBadge({ origin }) {
  if (origin === 'local') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-100 text-blue-700 border border-blue-200">
        <Home className="w-3 h-3" /> Internal
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
      <Cloud className="w-3 h-3" /> FreshService
    </span>
  );
}

function GroupRow({
  g, readOnly, editing, editForm, setEditForm,
  onStartEdit, onCancelEdit, onSaveEdit, onToggle, onManageMembers, membersOpen, saving, toggling,
}) {
  if (editing) {
    return (
      <div className="tp-card p-3 border-blue-200 ring-1 ring-blue-100">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Name" className="px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring" />
          <input value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Description" className="px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring" />
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={onSaveEdit} disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-60 tp-focus-ring">
            {saving ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
          </button>
          <button onClick={onCancelEdit}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 tp-focus-ring rounded-lg">
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`tp-card p-3 flex items-center gap-3 ${!g.isActive ? 'opacity-60' : ''}`}>
      <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
        <UsersRound className="w-4 h-4 text-slate-500" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 truncate">{g.name}</span>
          <OriginBadge origin={g.origin} />
          {!g.isActive && <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Inactive</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
          <span className="inline-flex items-center gap-1"><UsersRound className="w-3 h-3" />{g.memberCount} member{g.memberCount === 1 ? '' : 's'}</span>
          {g.description && <span className="truncate">· {g.description}</span>}
        </div>
      </div>
      {!readOnly && (
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onManageMembers} title="Manage members"
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium tp-focus-ring ${membersOpen ? 'bg-blue-100 text-blue-700' : 'text-blue-600 hover:bg-blue-50'}`}>
            Members
          </button>
          <button onClick={onStartEdit} title="Edit" className="p-2 text-gray-400 hover:text-blue-600 rounded-lg tp-focus-ring">
            <Pencil className="w-4 h-4" />
          </button>
          <button onClick={onToggle} disabled={toggling} title={g.isActive ? 'Deactivate' : 'Reactivate'}
            className={`p-2 rounded-lg tp-focus-ring ${g.isActive ? 'text-gray-400 hover:text-red-600' : 'text-gray-400 hover:text-emerald-600'}`}>
            {toggling ? <Loader className="w-4 h-4 animate-spin" /> : g.isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
