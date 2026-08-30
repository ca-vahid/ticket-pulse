import { useState, useEffect, useCallback, useMemo } from 'react';
import { settingsAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  Users2, Plus, Loader, Cloud, Home, Power, PowerOff, Pencil, Check, X,
  AlertCircle, CheckCircle2, UsersRound, Search, Star,
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

  // Default group for new tickets (QA 08-06 #1): one internal group max —
  // a workspace column, so starring a new one unsets the previous default.
  const toggleDefault = useCallback(async (g) => {
    setError(null);
    try {
      await settingsAPI.setDefaultGroup(g.isDefault ? null : g.id);
      flash(g.isDefault
        ? 'Default cleared — new tickets without a group stay ungrouped.'
        : `"${g.name}" is now the default group for new tickets.`);
      await load();
    } catch (err) { setError(err.message || 'Failed to change the default group'); }
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
          <div className="p-2 bg-blue-100 dark:bg-blue-500/20 rounded-lg">
            <Users2 className="w-5 h-5 text-blue-600 dark:text-blue-300" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">Groups</h3>
            <p className="text-sm text-muted-foreground max-w-2xl">
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
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg text-sm text-red-700 dark:text-red-200">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 rounded-lg text-sm text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /><span>{successMsg}</span>
        </div>
      )}

      {showAdd && (
        <div className="tp-card p-4 space-y-4 animate-scaleIn">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Home className="w-4 h-4 text-blue-600 dark:text-blue-300" /> New internal group
            {currentWorkspace?.name && <span className="text-xs font-normal text-muted-foreground">in {currentWorkspace.name}</span>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Name *</span>
              <input
                autoFocus value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Accounts Receivable"
                className="mt-1 w-full px-3 py-2 border border-input rounded-lg text-sm tp-focus-ring"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Description</span>
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
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground tp-focus-ring rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground/75">
          <Loader className="w-5 h-5 animate-spin mr-2" /> Loading groups…
        </div>
      ) : (
        <>
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/85">
              <Home className="w-4 h-4 text-blue-600 dark:text-blue-300" /> Internal groups
              <span className="text-xs font-normal text-muted-foreground/75">({internal.length})</span>
            </div>
            {internal.length > 0 && !internal.some((g) => g.isDefault) && (
              <p className="text-xs text-muted-foreground/75 px-1" data-testid="no-default-group-hint">
                No default group — tickets created without a group stay ungrouped. Star a group to make
                it the default for new tickets.
              </p>
            )}
            {internal.length === 0 ? (
              <p className="text-sm text-muted-foreground/75 italic px-1 py-2">
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
                      onToggleDefault={() => toggleDefault(g)}
                      onManageMembers={() => openMembers(g)}
                      membersOpen={membersFor === g.id}
                      saving={saving}
                      toggling={togglingId === g.id}
                    />
                    {membersFor === g.id && (
                      <div className="mt-1 tp-card p-3 border-blue-200 dark:border-blue-500/30 ring-1 ring-blue-100 dark:ring-blue-500/30 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-foreground">Members ({memberIds.size})</span>
                          <div className="flex items-center gap-2">
                            <button onClick={() => saveMembers(g.id)} disabled={savingMembers}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-60 tp-focus-ring">
                              {savingMembers ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
                            </button>
                            <button onClick={() => setMembersFor(null)}
                              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground tp-focus-ring rounded-lg">Close</button>
                          </div>
                        </div>
                        <div className="relative">
                          <Search className="w-3.5 h-3.5 text-muted-foreground/50 absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <input value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)}
                            placeholder="Find member…"
                            className="w-full pl-8 pr-2 py-1.5 text-xs bg-muted/50 border border-border rounded-lg placeholder:text-muted-foreground/75 tp-focus-ring" />
                        </div>
                        <div className="max-h-56 overflow-y-auto settings-scrollbar space-y-1">
                          {filteredTechs.map((t) => (
                            <label key={t.id}
                              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-muted/50 ${memberIds.has(t.id) ? 'bg-blue-50/70 dark:bg-blue-500/10' : ''}`}>
                              <input type="checkbox" checked={memberIds.has(t.id)} onChange={() => toggleMember(t.id)}
                                className="rounded border-input text-primary focus:ring-primary" />
                              <span className="text-sm text-foreground/85">{t.name}</span>
                              {t.origin === 'local' && (
                                <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300">Local</span>
                              )}
                            </label>
                          ))}
                          {filteredTechs.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground/75">No member matches “{memberQuery}”.</p>}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/85">
              <Cloud className="w-4 h-4 text-muted-foreground" /> FreshService groups
              <span className="text-xs font-normal text-muted-foreground/75">({fs.length})</span>
              <span className="text-xs font-normal text-muted-foreground/75">· synced, read-only</span>
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
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200 border border-blue-200 dark:border-blue-500/30">
        <Home className="w-3 h-3" /> Internal
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground border border-border">
      <Cloud className="w-3 h-3" /> FreshService
    </span>
  );
}

function GroupRow({
  g, readOnly, editing, editForm, setEditForm,
  onStartEdit, onCancelEdit, onSaveEdit, onToggle, onToggleDefault, onManageMembers, membersOpen, saving, toggling,
}) {
  if (editing) {
    return (
      <div className="tp-card p-3 border-blue-200 dark:border-blue-500/30 ring-1 ring-blue-100 dark:ring-blue-500/30">
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
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground tp-focus-ring rounded-lg">
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`tp-card p-3 flex items-center gap-3 ${!g.isActive ? 'opacity-60' : ''}`}>
      <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <UsersRound className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{g.name}</span>
          <OriginBadge origin={g.origin} />
          {g.isDefault && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border border-amber-200 dark:border-amber-500/30"
              title="New tickets created without a group land here"
            >
              <Star className="w-3 h-3 fill-amber-400 text-amber-400" /> Default for new tickets
            </span>
          )}
          {!g.isActive && <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Inactive</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
          <span className="inline-flex items-center gap-1"><UsersRound className="w-3 h-3" />{g.memberCount} member{g.memberCount === 1 ? '' : 's'}</span>
          {g.description && <span className="truncate">· {g.description}</span>}
        </div>
      </div>
      {!readOnly && (
        <div className="flex items-center gap-1 shrink-0">
          {g.isActive && (
            <button
              onClick={onToggleDefault}
              title={g.isDefault ? 'Clear the default group for new tickets' : 'Make this the default group for new tickets'}
              aria-label={g.isDefault ? `Clear ${g.name} as default group` : `Make ${g.name} the default group for new tickets`}
              aria-pressed={g.isDefault === true}
              className={`p-2 rounded-lg tp-focus-ring ${g.isDefault ? 'text-amber-500 hover:text-amber-600 dark:hover:text-amber-300' : 'text-muted-foreground/50 hover:text-amber-500'}`}
            >
              <Star className={`w-4 h-4 ${g.isDefault ? 'fill-amber-400' : ''}`} />
            </button>
          )}
          <button onClick={onManageMembers} title="Manage members"
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium tp-focus-ring ${membersOpen ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200' : 'text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/15'}`}>
            Members
          </button>
          <button onClick={onStartEdit} title="Edit" className="p-2 text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300 rounded-lg tp-focus-ring">
            <Pencil className="w-4 h-4" />
          </button>
          <button onClick={onToggle} disabled={toggling} title={g.isActive ? 'Deactivate' : 'Reactivate'}
            className={`p-2 rounded-lg tp-focus-ring ${g.isActive ? 'text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300' : 'text-muted-foreground/75 hover:text-emerald-600 dark:hover:text-emerald-300'}`}>
            {toggling ? <Loader className="w-4 h-4 animate-spin" /> : g.isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
