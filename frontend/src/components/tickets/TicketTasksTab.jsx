import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check, CheckSquare, Circle, Clock, Loader2, Pencil, Plus, Trash2, UserCircle2, X,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';

const STATUS_META = {
  open: { label: 'Open', cls: 'bg-slate-100 text-slate-600 border-slate-200', Icon: Circle },
  in_progress: { label: 'In progress', cls: 'bg-amber-50 text-amber-700 border-amber-200', Icon: Clock },
  done: { label: 'Done', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: Check },
};
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

const fieldLabel = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500';

/**
 * Tasks tab (QA 07-16 #3). Per-ticket assignable sub-tasks. Works for TP-born
 * tickets (owned here, mirrored to the FreshService copy) and FS-born tickets
 * (proxied to FreshService's Tasks API — FS sends the assignee's email). The
 * assignee dropdown draws from the workspace agents; on FS-born tickets a note
 * explains FreshService owns the notification.
 *
 * QA 07-17: labeled add fields, a per-task status dropdown, and inline editing
 * of the task description. Status changes are logged to the ticket Activity tab.
 */
export default function TicketTasksTab({ ticketId, technicians = [], canWrite = false, ticketOrigin, onCountChange }) {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', assignedTechId: '', dueAt: '', notifyAgent: true });
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const countRef = useRef(onCountChange);
  countRef.current = onCountChange;
  const isFsBorn = ticketOrigin !== 'ticketpulse';

  const load = useCallback(async () => {
    try {
      const res = await ticketsAPI.tasks(ticketId);
      const list = res?.data?.data || res?.data || [];
      setTasks(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setTasks([]);
    }
  }, [ticketId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tasks) countRef.current?.(tasks.filter((t) => t.status !== 'done').length);
  }, [tasks]);

  const techName = (id) => technicians.find((t) => t.id === id)?.name || null;

  const doAdd = async () => {
    const title = draft.title.trim();
    if (!title) return;
    setAdding(true); setError(null);
    try {
      await ticketsAPI.addTask(ticketId, {
        title,
        assignedTechId: draft.assignedTechId ? Number(draft.assignedTechId) : null,
        dueAt: draft.dueAt || null,
        notifyAgent: draft.notifyAgent,
      });
      setDraft({ title: '', assignedTechId: '', dueAt: '', notifyAgent: true });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setAdding(false);
  };

  const patch = async (task, body) => {
    setBusyId(task.id); setError(null);
    try {
      await ticketsAPI.updateTask(ticketId, task.id, body);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setBusyId(null);
  };

  const startEdit = (task) => { setEditingId(task.id); setEditText(task.title); };
  const cancelEdit = () => { setEditingId(null); setEditText(''); };
  const saveEdit = async (task) => {
    const title = editText.trim();
    if (!title || title === task.title) { cancelEdit(); return; }
    await patch(task, { title });
    cancelEdit();
  };

  const remove = async (task) => {
    setBusyId(task.id); setError(null);
    try {
      await ticketsAPI.removeTask(ticketId, task.id);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setBusyId(null);
  };

  return (
    <section className="tp-card rounded-xl p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <CheckSquare className="h-4 w-4 text-blue-600" aria-hidden="true" />
        <h3 className="text-sm font-bold text-slate-900">Tasks</h3>
        <span className="text-xs text-slate-400">
          {isFsBorn ? 'FreshService owns these tasks — it emails the assignee.' : 'Assign discrete tasks to agents on this ticket.'}
        </span>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</div>
      )}

      {tasks === null ? (
        <p className="flex items-center gap-2 py-4 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading tasks…</p>
      ) : (
        <ul className="space-y-1.5">
          {tasks.length === 0 && <li className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-sm text-slate-400">No tasks yet.</li>}
          {tasks.map((task) => {
            const sm = STATUS_META[task.status] || STATUS_META.open;
            const busy = busyId === task.id;
            const assigneeName = task.assignee?.name || techName(task.assignedTechId);
            const isEditing = editingId === task.id;
            return (
              <li key={task.id} className="flex items-start gap-2.5 rounded-lg border border-slate-100 px-3 py-2.5 hover:bg-slate-50/60">
                <button
                  onClick={() => canWrite && patch(task, { status: task.status === 'done' ? 'open' : 'done' })}
                  disabled={!canWrite || busy}
                  title={task.status === 'done' ? 'Reopen' : 'Mark done'}
                  className="tp-focus-ring mt-0.5 flex-shrink-0 rounded disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />
                    : task.status === 'done' ? <CheckSquare className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                      : <Circle className="h-4 w-4 text-slate-300 hover:text-emerald-500" aria-hidden="true" />}
                </button>
                <span className="min-w-0 flex-1">
                  {isEditing ? (
                    <span className="flex items-center gap-1.5">
                      <input
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(task); if (e.key === 'Escape') cancelEdit(); }}
                        autoFocus
                        aria-label="Edit task description"
                        className="tp-focus-ring min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                      />
                      <button onClick={() => saveEdit(task)} disabled={busy} aria-label="Save" className="tp-focus-ring rounded p-1 text-emerald-600 hover:bg-emerald-50"><Check className="h-4 w-4" aria-hidden="true" /></button>
                      <button onClick={cancelEdit} aria-label="Cancel" className="tp-focus-ring rounded p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" aria-hidden="true" /></button>
                    </span>
                  ) : (
                    <span className={`block text-sm font-medium ${task.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{task.title}</span>
                  )}
                  {task.description && !isEditing && <span className="block text-xs text-slate-500">{task.description}</span>}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-semibold ${sm.cls}`}>
                      <sm.Icon className="h-3 w-3" aria-hidden="true" />{sm.label}
                    </span>
                    {assigneeName ? (
                      <span className="inline-flex items-center gap-1"><UserCircle2 className="h-3 w-3" aria-hidden="true" />{assigneeName}</span>
                    ) : <span className="text-slate-300">Unassigned</span>}
                    {task.dueAt && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden="true" />Due {new Date(task.dueAt).toLocaleDateString()}</span>}
                  </span>
                </span>
                {canWrite && !isEditing && (
                  <span className="flex flex-shrink-0 items-center gap-1">
                    <label className="sr-only" htmlFor={`task-status-${task.id}`}>Task status</label>
                    <select
                      id={`task-status-${task.id}`}
                      value={task.status}
                      onChange={(e) => patch(task, { status: e.target.value })}
                      disabled={busy}
                      title="Task status"
                      className="tp-focus-ring rounded-md border border-slate-200 bg-white py-0.5 pl-1.5 pr-5 text-[11px] font-semibold text-slate-600"
                    >
                      {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <button onClick={() => startEdit(task)} disabled={busy} aria-label="Edit task description" className="tp-focus-ring rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600">
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <select
                      value={task.assignedTechId || ''}
                      onChange={(e) => patch(task, { assignedTechId: e.target.value ? Number(e.target.value) : null })}
                      disabled={busy}
                      aria-label="Reassign task"
                      className="tp-focus-ring max-w-[120px] rounded-md border border-slate-200 bg-white py-0.5 pl-1.5 pr-5 text-[11px] text-slate-600"
                    >
                      <option value="">Unassigned</option>
                      {technicians.filter((t) => t.isActive !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <button onClick={() => remove(task)} disabled={busy} aria-label="Delete task" className="tp-focus-ring rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canWrite && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <div className="flex flex-wrap items-end gap-2.5">
            <div className="min-w-[180px] flex-1">
              <label htmlFor="new-task-title" className={fieldLabel}>Task Description</label>
              <input
                id="new-task-title"
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') doAdd(); }}
                placeholder="What needs to be done?"
                className="tp-focus-ring w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor="new-task-assignee" className={fieldLabel}>Assign To</label>
              <select
                id="new-task-assignee"
                value={draft.assignedTechId}
                onChange={(e) => setDraft((d) => ({ ...d, assignedTechId: e.target.value }))}
                className="tp-focus-ring rounded-lg border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-sm text-slate-600"
              >
                <option value="">Unassigned</option>
                {technicians.filter((t) => t.isActive !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="new-task-due" className={fieldLabel}>Due Date</label>
              <input
                id="new-task-due"
                type="date"
                value={draft.dueAt}
                onChange={(e) => setDraft((d) => ({ ...d, dueAt: e.target.value }))}
                className="tp-focus-ring rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600"
              />
            </div>
            <button
              onClick={doAdd}
              disabled={adding || !draft.title.trim()}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
              Add
            </button>
          </div>
          <label className="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-500">
            <input type="checkbox" checked={draft.notifyAgent} onChange={(e) => setDraft((d) => ({ ...d, notifyAgent: e.target.checked }))} className="tp-focus-ring" />
            {isFsBorn ? 'Notify the assignee (via FreshService)' : 'Email the assignee that they were assigned'}
          </label>
        </div>
      )}
    </section>
  );
}
