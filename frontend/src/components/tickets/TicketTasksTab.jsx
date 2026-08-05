import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell, Check, CheckSquare, Circle, Clock, Loader2, Pencil, Plus, Trash2, UserCircle2,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { formatDayTime } from './ticketUi';

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

// Due-time dropdown: 15-minute steps, default 5:00 PM — mirrors FreshService.
const DEFAULT_DUE_TIME = '17:00';
const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { value, label: `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` };
});

// "Notify before" presets — mirrors the FreshService modal (QA 08-04 #8b).
const REMIND_OPTIONS = [
  { value: '', label: 'Never' },
  { value: '15', label: '15 Minutes' },
  { value: '30', label: '30 Minutes' },
  { value: '45', label: '45 Minutes' },
  { value: '60', label: '1 Hour' },
  { value: '120', label: '2 Hours' },
];
const REMIND_SHORT = { 15: '15m', 30: '30m', 45: '45m', 60: '1h', 120: '2h' };

const fieldLabel = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500';
const fieldInput = 'tp-focus-ring w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700';

/** Local date ("YYYY-MM-DD") + time ("HH:mm") → full ISO string, so the backend
 *  stops receiving bare dates it would read as UTC midnight. */
function toDueIso(date, time) {
  if (!date) return null;
  const d = new Date(`${date}T${time || DEFAULT_DUE_TIME}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Split a stored dueAt into local picker parts (time snapped to 15 min). */
function splitDue(dueAt) {
  if (!dueAt) return { date: '', time: DEFAULT_DUE_TIME };
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return { date: '', time: DEFAULT_DUE_TIME };
  const pad = (n) => String(n).padStart(2, '0');
  const mins = Math.min(1425, Math.round((d.getHours() * 60 + d.getMinutes()) / 15) * 15);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`,
  };
}

function isOverdue(task) {
  return Boolean(task.dueAt) && task.status !== 'done' && new Date(task.dueAt).getTime() < Date.now();
}

/**
 * Tasks tab (QA 07-16 #3). Per-ticket assignable sub-tasks. Works for TP-born
 * tickets (owned here, mirrored to the FreshService copy) and FS-born tickets
 * (proxied to FreshService's Tasks API — FS sends the assignee's email). The
 * assignee dropdown draws from the workspace agents; on FS-born tickets a note
 * explains FreshService owns the notification.
 *
 * QA 07-17: labeled add fields, a per-task status dropdown.
 * QA 08-04 #8: due date now carries a TIME (15-min dropdown, 5 PM default),
 * a "Notify before" due reminder, and a full row-edit popover (title,
 * description, assignee, status, due, reminder) behind the pencil.
 */
export default function TicketTasksTab({ ticketId, technicians = [], canWrite = false, ticketOrigin, onCountChange }) {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', assignedTechId: '', dueDate: '', dueTime: DEFAULT_DUE_TIME, remindBefore: '', notifyAgent: true });
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const popoverRef = useRef(null);
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

  // Close the edit popover on an outside click.
  useEffect(() => {
    if (editingId === null) return undefined;
    const onDown = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setEditingId(null); setEditDraft(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editingId]);

  const techName = (id) => technicians.find((t) => t.id === id)?.name || null;

  const doAdd = async () => {
    const title = draft.title.trim();
    if (!title) return;
    setAdding(true); setError(null);
    try {
      await ticketsAPI.addTask(ticketId, {
        title,
        assignedTechId: draft.assignedTechId ? Number(draft.assignedTechId) : null,
        dueAt: toDueIso(draft.dueDate, draft.dueTime),
        remindBeforeMinutes: draft.dueDate && draft.remindBefore ? Number(draft.remindBefore) : null,
        notifyAgent: draft.notifyAgent,
      });
      setDraft({ title: '', assignedTechId: '', dueDate: '', dueTime: DEFAULT_DUE_TIME, remindBefore: '', notifyAgent: true });
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

  const startEdit = (task) => {
    const due = splitDue(task.dueAt);
    setEditingId(task.id);
    setEditDraft({
      title: task.title,
      description: task.description || '',
      assignedTechId: task.assignedTechId ? String(task.assignedTechId) : '',
      status: task.status,
      dueDate: due.date,
      dueTime: due.time,
      remindBefore: task.remindBeforeMinutes ? String(task.remindBeforeMinutes) : '',
    });
  };
  const cancelEdit = () => { setEditingId(null); setEditDraft(null); };

  /** PATCH only what actually changed in the popover. */
  const saveEdit = async (task) => {
    if (!editDraft) return;
    const body = {};
    const title = editDraft.title.trim();
    if (title && title !== task.title) body.title = title;
    const description = editDraft.description.trim();
    if (description !== (task.description || '')) body.description = description || null;
    const assignedTechId = editDraft.assignedTechId ? Number(editDraft.assignedTechId) : null;
    if (assignedTechId !== (task.assignedTechId ?? null)) body.assignedTechId = assignedTechId;
    if (editDraft.status !== task.status) body.status = editDraft.status;
    const dueAt = toDueIso(editDraft.dueDate, editDraft.dueTime);
    const dueUnchanged = (dueAt === null && !task.dueAt)
      || (dueAt !== null && task.dueAt && new Date(dueAt).getTime() === new Date(task.dueAt).getTime());
    if (!dueUnchanged) body.dueAt = dueAt;
    const remindBeforeMinutes = editDraft.dueDate && editDraft.remindBefore ? Number(editDraft.remindBefore) : null;
    if (remindBeforeMinutes !== (task.remindBeforeMinutes ?? null)) body.remindBeforeMinutes = remindBeforeMinutes;
    cancelEdit();
    if (Object.keys(body).length === 0) return;
    await patch(task, body);
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
            const overdue = isOverdue(task);
            const isEditing = editingId === task.id;
            return (
              <li key={task.id} className="relative flex items-start gap-2.5 rounded-lg border border-slate-100 px-3 py-2.5 hover:bg-slate-50/60">
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
                  <span className={`block text-sm font-medium ${task.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{task.title}</span>
                  {task.description && <span className="block text-xs text-slate-500">{task.description}</span>}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-semibold ${sm.cls}`}>
                      <sm.Icon className="h-3 w-3" aria-hidden="true" />{sm.label}
                    </span>
                    {assigneeName ? (
                      <span className="inline-flex items-center gap-1"><UserCircle2 className="h-3 w-3" aria-hidden="true" />{assigneeName}</span>
                    ) : <span className="text-slate-300">Unassigned</span>}
                    {task.dueAt && (
                      <span
                        className={`inline-flex items-center gap-1 ${overdue ? 'font-semibold text-rose-600' : ''}`}
                        title={overdue ? 'Past due' : undefined}
                      >
                        <Clock className="h-3 w-3" aria-hidden="true" />Due {formatDayTime(task.dueAt)}
                      </span>
                    )}
                    {task.dueAt && task.remindBeforeMinutes && task.status !== 'done' ? (
                      <span className="inline-flex items-center gap-1" title={`Assignee is emailed ${REMIND_SHORT[task.remindBeforeMinutes] || `${task.remindBeforeMinutes}m`} before the due time`}>
                        <Bell className="h-3 w-3" aria-hidden="true" />{REMIND_SHORT[task.remindBeforeMinutes] || `${task.remindBeforeMinutes}m`} before
                      </span>
                    ) : null}
                  </span>
                </span>
                {canWrite && (
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
                    <button
                      onClick={() => (isEditing ? cancelEdit() : startEdit(task))}
                      disabled={busy}
                      aria-label="Edit task"
                      aria-expanded={isEditing}
                      className="tp-focus-ring rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                    >
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
                {isEditing && editDraft && (
                  <div
                    ref={popoverRef}
                    role="dialog"
                    aria-label={`Edit task: ${task.title}`}
                    onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                    className="tp-card absolute right-2 top-10 z-20 w-72 animate-scaleIn rounded-xl p-3 shadow-soft"
                  >
                    <div className="space-y-2.5">
                      <div>
                        <label htmlFor={`task-edit-title-${task.id}`} className={fieldLabel}>Title</label>
                        <input
                          id={`task-edit-title-${task.id}`}
                          value={editDraft.title}
                          onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(task); }}
                          autoFocus
                          className={fieldInput}
                        />
                      </div>
                      <div>
                        <label htmlFor={`task-edit-desc-${task.id}`} className={fieldLabel}>Description</label>
                        <textarea
                          id={`task-edit-desc-${task.id}`}
                          value={editDraft.description}
                          onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))}
                          rows={2}
                          className={`${fieldInput} resize-none`}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label htmlFor={`task-edit-assignee-${task.id}`} className={fieldLabel}>Assign To</label>
                          <select
                            id={`task-edit-assignee-${task.id}`}
                            value={editDraft.assignedTechId}
                            onChange={(e) => setEditDraft((d) => ({ ...d, assignedTechId: e.target.value }))}
                            className={fieldInput}
                          >
                            <option value="">Unassigned</option>
                            {technicians.filter((t) => t.isActive !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`task-edit-status-${task.id}`} className={fieldLabel}>Status</label>
                          <select
                            id={`task-edit-status-${task.id}`}
                            value={editDraft.status}
                            onChange={(e) => setEditDraft((d) => ({ ...d, status: e.target.value }))}
                            className={fieldInput}
                          >
                            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label htmlFor={`task-edit-due-date-${task.id}`} className={fieldLabel}>Due Date</label>
                          <input
                            id={`task-edit-due-date-${task.id}`}
                            type="date"
                            value={editDraft.dueDate}
                            onChange={(e) => setEditDraft((d) => ({ ...d, dueDate: e.target.value }))}
                            className={fieldInput}
                          />
                        </div>
                        <div>
                          <label htmlFor={`task-edit-due-time-${task.id}`} className={fieldLabel}>Time</label>
                          <select
                            id={`task-edit-due-time-${task.id}`}
                            value={editDraft.dueTime}
                            onChange={(e) => setEditDraft((d) => ({ ...d, dueTime: e.target.value }))}
                            disabled={!editDraft.dueDate}
                            className={`${fieldInput} disabled:opacity-50`}
                          >
                            {TIME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label htmlFor={`task-edit-remind-${task.id}`} className={fieldLabel}>Notify Before</label>
                        <select
                          id={`task-edit-remind-${task.id}`}
                          value={editDraft.remindBefore}
                          onChange={(e) => setEditDraft((d) => ({ ...d, remindBefore: e.target.value }))}
                          disabled={!editDraft.dueDate}
                          className={`${fieldInput} disabled:opacity-50`}
                        >
                          {REMIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        {isFsBorn && <p className="mt-1 text-[10px] leading-tight text-slate-400">FreshService sends this reminder for FS-born tasks.</p>}
                      </div>
                      <div className="flex justify-end gap-1.5 pt-0.5">
                        <button onClick={cancelEdit} className="tp-focus-ring rounded-md px-2.5 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100">Cancel</button>
                        <button
                          onClick={() => saveEdit(task)}
                          disabled={busy || !editDraft.title.trim()}
                          className="tp-focus-ring rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
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
                value={draft.dueDate}
                onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))}
                className="tp-focus-ring rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600"
              />
            </div>
            <div>
              <label htmlFor="new-task-due-time" className={fieldLabel}>Time</label>
              <select
                id="new-task-due-time"
                value={draft.dueTime}
                onChange={(e) => setDraft((d) => ({ ...d, dueTime: e.target.value }))}
                disabled={!draft.dueDate}
                className="tp-focus-ring rounded-lg border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-sm text-slate-600 disabled:opacity-50"
              >
                {TIME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="new-task-remind" className={fieldLabel}>Notify Before</label>
              <select
                id="new-task-remind"
                value={draft.remindBefore}
                onChange={(e) => setDraft((d) => ({ ...d, remindBefore: e.target.value }))}
                disabled={!draft.dueDate}
                className="tp-focus-ring rounded-lg border border-slate-200 bg-white py-1.5 pl-2 pr-6 text-sm text-slate-600 disabled:opacity-50"
              >
                {REMIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
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
