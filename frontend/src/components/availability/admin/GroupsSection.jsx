import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { availabilityAPI } from '../../../services/api';
import { BTN_LINK, BTN_QUIET, Field, INPUT, SectionTitle, StatusDot, TEXTAREA, Toggle, nameFromEmail } from '../availabilityUi';
import { Drawer, MultiCheck, PeoplePicker } from './adminUi';

/**
 * Approval groups: who is in the group, who approves for them (with optional
 * time-boxed delegates), and which types skip approval for the group.
 */

const BLANK = { name: '', description: '', autoApproveTypeIds: [], requireAll: false, isActive: true, members: [], approvers: [] };

function toDraft(g) {
  return {
    ...BLANK,
    ...g,
    members: (g.members || []).map((m) => m.email || m),
    approvers: (g.approvers || []).map((a) => ({ email: a.email, isDelegate: Boolean(a.isDelegate), delegateFrom: a.delegateFrom ? String(a.delegateFrom).slice(0, 10) : '', delegateUntil: a.delegateUntil ? String(a.delegateUntil).slice(0, 10) : '' })),
    autoApproveTypeIds: Array.isArray(g.autoApproveTypeIds) ? g.autoApproveTypeIds : [],
  };
}

export default function GroupsSection({ config, reload, toast }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const people = config.people || [];
  const nameOf = (email) => people.find((p) => p.email === email)?.name || nameFromEmail(email);
  const typeOptions = (config.leaveTypes || []).filter((t) => t.isActive !== false).map((t) => ({ value: t.id, label: t.name }));
  const typeName = (id) => (config.leaveTypes || []).find((t) => t.id === id)?.name;
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if (!draft.name.trim()) { setError('Give the group a name'); return; }
    if (!draft.approvers.length) { setError('Add at least one approver'); return; }
    setSaving(true);
    setError(null);
    try {
      await availabilityAPI.saveGroup({
        id: draft.id,
        name: draft.name.trim(),
        description: draft.description || '',
        autoApproveTypeIds: draft.autoApproveTypeIds,
        requireAll: draft.requireAll,
        isActive: draft.isActive,
        members: draft.members,
        approvers: draft.approvers.map((a) => ({
          email: a.email, isDelegate: a.isDelegate, delegateFrom: a.isDelegate && a.delegateFrom ? a.delegateFrom : null, delegateUntil: a.isDelegate && a.delegateUntil ? a.delegateUntil : null,
        })),
      });
      toast(`${draft.name.trim()} saved`);
      setDraft(null);
      reload();
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (g) => {
    if (!window.confirm(`Delete the approval group "${g.name}"?`)) return;
    try {
      await availabilityAPI.deleteGroup(g.id);
      toast(`${g.name} deleted`);
      reload();
    } catch (err) {
      toast(err?.message || 'Could not delete', 'red');
    }
  };

  const setApprover = (email, patch) => set({ approvers: draft.approvers.map((a) => (a.email === email ? { ...a, ...patch } : a)) });

  return (
    <section aria-label="Approval groups">
      <SectionTitle
        hint="Requests from people in no group go to the Ticket Pulse admins, so nothing gets stuck."
        action={<button type="button" className={BTN_LINK} onClick={() => { setDraft(toDraft(BLANK)); setError(null); }}><Plus className="h-4 w-4" aria-hidden="true" />New group</button>}
      >
        Approval groups
      </SectionTitle>
      {!(config.groups || []).length && <p className="py-4 text-sm text-muted-foreground">No groups yet.</p>}
      <ul className="divide-y divide-border">
        {(config.groups || []).map((g) => {
          const auto = Array.isArray(g.autoApproveTypeIds) && g.autoApproveTypeIds.includes('*')
            ? 'All types skip approval'
            : (g.autoApproveTypeIds || []).map(typeName).filter(Boolean).join(', ');
          return (
            <li key={g.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
              <div className="min-w-[12rem] flex-1">
                <p className="text-sm font-medium text-foreground">{g.name}</p>
                {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
              </div>
              <div className="min-w-[14rem] flex-[2] text-xs text-muted-foreground">
                <p><span className="text-foreground/85">{(g.members || []).length}</span> members · approvers: <span className="text-foreground/85">{(g.approvers || []).map((a) => `${nameOf(a.email)}${a.isDelegate ? ' (delegate)' : ''}`).join(', ') || '—'}</span>{g.requireAll ? ' · all must approve' : ''}</p>
                {auto && <p>Automatic: {auto}</p>}
              </div>
              <StatusDot tone={g.isActive === false ? 'grey' : 'green'} label={g.isActive === false ? 'Off' : 'Active'} />
              <span className="flex gap-1">
                <button type="button" className={BTN_QUIET} onClick={() => { setDraft(toDraft(g)); setError(null); }} aria-label={`Edit ${g.name}`}><Pencil className="h-4 w-4" aria-hidden="true" /></button>
                <button type="button" className={BTN_QUIET} onClick={() => remove(g)} aria-label={`Delete ${g.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
              </span>
            </li>
          );
        })}
      </ul>

      <Drawer open={Boolean(draft)} title={draft?.id ? `Edit ${draft.name}` : 'New approval group'} onClose={() => setDraft(null)} onSave={save} saving={saving} error={error}>
        {draft && (
          <>
            <Field label="Name"><input className={INPUT} value={draft.name} onChange={(e) => set({ name: e.target.value })} aria-label="Group name" /></Field>
            <Field label="Description"><textarea rows={2} className={TEXTAREA} value={draft.description || ''} onChange={(e) => set({ description: e.target.value })} aria-label="Group description" /></Field>
            <PeoplePicker label="Members" people={people} value={draft.members} onChange={(members) => set({ members })} />
            <PeoplePicker
              label="Approvers"
              people={people}
              value={draft.approvers.map((a) => a.email)}
              onChange={(emails) => set({ approvers: emails.map((email) => draft.approvers.find((a) => a.email === email) || { email, isDelegate: false, delegateFrom: '', delegateUntil: '' }) })}
              renderExtra={(email) => {
                const a = draft.approvers.find((x) => x.email === email);
                return (
                  <span className="flex w-full flex-wrap items-center gap-2 pl-8 text-xs sm:w-auto sm:pl-0">
                    <label className="inline-flex items-center gap-1 text-foreground/85">
                      <input type="checkbox" checked={Boolean(a?.isDelegate)} onChange={(e) => setApprover(email, { isDelegate: e.target.checked })} className="accent-[hsl(var(--primary))]" aria-label={`${nameOf(email)} is a delegate`} />
                      Delegate
                    </label>
                    {a?.isDelegate && (
                      <>
                        <input type="date" className={`${INPUT} h-7 w-32 text-xs`} value={a.delegateFrom || ''} onChange={(e) => setApprover(email, { delegateFrom: e.target.value })} aria-label={`${nameOf(email)} delegate from`} />
                        <input type="date" className={`${INPUT} h-7 w-32 text-xs`} value={a.delegateUntil || ''} onChange={(e) => setApprover(email, { delegateUntil: e.target.value })} aria-label={`${nameOf(email)} delegate until`} />
                      </>
                    )}
                  </span>
                );
              }}
            />
            <MultiCheck label="Types that skip approval for this group" options={typeOptions} value={draft.autoApproveTypeIds} onChange={(v) => set({ autoApproveTypeIds: v })} allValue="*" allLabel="All types" />
            <Toggle checked={draft.requireAll} onChange={(v) => set({ requireAll: v })} label="Every approver must approve" hint="Off: the first approver to decide settles it." />
            <Toggle checked={draft.isActive !== false} onChange={(v) => set({ isActive: v })} label="Active" />
          </>
        )}
      </Drawer>
    </section>
  );
}
