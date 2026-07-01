import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Send, Sparkles, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { PRIORITY_LABELS } from './ticketUi';

/**
 * Slide-over composer for creating a native (TP-born) ticket.
 * Assignment choice: let the AI pipeline decide (default), pick a technician,
 * or take it yourself when the actor has a technician profile.
 */
export default function TicketComposer({ meta, onClose, onCreated }) {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [requesterEmail, setRequesterEmail] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [priority, setPriority] = useState(2);
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [assignMode, setAssignMode] = useState('ai'); // ai | me | pick | none
  const [assignTechId, setAssignTechId] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const subcategories = useMemo(() => {
    const top = (meta?.categoryTree || []).find((c) => String(c.id) === String(categoryId));
    return top?.subcategories || [];
  }, [meta, categoryId]);

  const canTakeMyself = Boolean(meta?.actor?.technicianId);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      const payload = {
        subject: subject.trim(),
        description: description.trim() ? description.trim() : null,
        priority: Number(priority),
        requesterEmail: requesterEmail.trim(),
        requesterName: requesterName.trim() || null,
        internalCategoryId: categoryId ? Number(categoryId) : null,
        internalSubcategoryId: subcategoryId ? Number(subcategoryId) : null,
        groupId: groupId ? Number(groupId) : null,
        runAiTriage: assignMode === 'ai',
      };
      if (assignMode === 'me' && canTakeMyself) payload.assignedTechId = meta.actor.technicianId;
      if (assignMode === 'pick' && assignTechId) payload.assignedTechId = Number(assignTechId);

      const res = await ticketsAPI.create(payload);
      onCreated?.(res.data);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to create ticket');
      setIsSaving(false);
    }
  };

  const fieldClass = 'tp-focus-ring w-full text-sm bg-white border border-input rounded-lg px-3 py-2 text-slate-800 placeholder:text-slate-400';
  const labelClass = 'block text-xs font-semibold text-slate-600 mb-1';

  return (
    <div className="fixed inset-0 z-50 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="ticket-composer-title">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />

      <div className="absolute inset-y-0 right-0 w-full max-w-lg bg-white shadow-soft flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <h2 id="ticket-composer-title" className="text-base font-bold text-slate-900">New ticket</h2>
            <p className="text-xs text-slate-500">Born in Ticket Pulse — mirrored to FreshService as a fallback copy.</p>
          </div>
          <button onClick={onClose} aria-label="Close composer" className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit} className="flex-1 overflow-y-auto settings-scrollbar px-5 py-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="tc-requester-email" className={labelClass}>Requester email *</label>
              <input
                id="tc-requester-email"
                type="email"
                required
                value={requesterEmail}
                onChange={(e) => setRequesterEmail(e.target.value)}
                placeholder="person@company.com"
                className={fieldClass}
              />
            </div>
            <div>
              <label htmlFor="tc-requester-name" className={labelClass}>Requester name</label>
              <input
                id="tc-requester-name"
                type="text"
                value={requesterName}
                onChange={(e) => setRequesterName(e.target.value)}
                placeholder="Auto-filled from Entra if known"
                className={fieldClass}
              />
            </div>
          </div>

          <div>
            <label htmlFor="tc-subject" className={labelClass}>Subject *</label>
            <input
              id="tc-subject"
              type="text"
              required
              minLength={3}
              maxLength={500}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Short summary of the issue or request"
              className={fieldClass}
            />
          </div>

          <div>
            <label htmlFor="tc-description" className={labelClass}>Description</label>
            <textarea
              id="tc-description"
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened, where, since when, error messages…"
              className={`${fieldClass} resize-y min-h-[120px]`}
            />
          </div>

          <div>
            <span className={labelClass}>Priority</span>
            <div role="group" aria-label="Priority" className="grid grid-cols-4 gap-1.5">
              {[1, 2, 3, 4].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  aria-pressed={priority === p}
                  className={`tp-focus-ring px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    priority === p
                      ? p === 4 ? 'bg-red-600 text-white border-red-600'
                        : p === 3 ? 'bg-amber-500 text-white border-amber-500'
                          : p === 2 ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-blue-500 text-white border-blue-500'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="tc-category" className={labelClass}>Category</label>
              <select
                id="tc-category"
                value={categoryId}
                onChange={(e) => { setCategoryId(e.target.value); setSubcategoryId(''); }}
                className={fieldClass}
              >
                <option value="">Let AI classify</option>
                {(meta?.categoryTree || []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="tc-subcategory" className={labelClass}>Subcategory</label>
              <select
                id="tc-subcategory"
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                disabled={!categoryId || subcategories.length === 0}
                className={`${fieldClass} disabled:bg-slate-50 disabled:text-slate-400`}
              >
                <option value="">—</option>
                {subcategories.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          {(meta?.groups?.length || 0) > 0 && (
            <div>
              <label htmlFor="tc-group" className={labelClass}>Group</label>
              <select id="tc-group" value={groupId} onChange={(e) => setGroupId(e.target.value)} className={fieldClass}>
                <option value="">No group</option>
                {meta.groups.map((g) => (
                  <option key={g.id} value={String(g.freshserviceId)}>{g.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <span className={labelClass}>Assignment</span>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 bg-white hover:border-blue-200 cursor-pointer">
                <input type="radio" name="tc-assign" checked={assignMode === 'ai'} onChange={() => setAssignMode('ai')} className="tp-focus-ring" />
                <Sparkles className="w-4 h-4 text-indigo-500" aria-hidden="true" />
                <span className="text-sm text-slate-700">Let the AI pipeline triage & recommend</span>
              </label>
              {canTakeMyself && (
                <label className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 bg-white hover:border-blue-200 cursor-pointer">
                  <input type="radio" name="tc-assign" checked={assignMode === 'me'} onChange={() => setAssignMode('me')} className="tp-focus-ring" />
                  <span className="text-sm text-slate-700">Assign to me</span>
                </label>
              )}
              <label className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 bg-white hover:border-blue-200 cursor-pointer">
                <input type="radio" name="tc-assign" checked={assignMode === 'pick'} onChange={() => setAssignMode('pick')} className="tp-focus-ring" />
                <span className="text-sm text-slate-700">Assign to…</span>
                <select
                  value={assignTechId}
                  onChange={(e) => { setAssignTechId(e.target.value); setAssignMode('pick'); }}
                  onClick={() => setAssignMode('pick')}
                  aria-label="Technician to assign"
                  className="tp-focus-ring ml-auto text-sm bg-white border border-input rounded-lg px-2 py-1 text-slate-700"
                >
                  <option value="">Choose…</option>
                  {(meta?.technicians || []).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 bg-white hover:border-blue-200 cursor-pointer">
                <input type="radio" name="tc-assign" checked={assignMode === 'none'} onChange={() => setAssignMode('none')} className="tp-focus-ring" />
                <span className="text-sm text-slate-700">Leave unassigned</span>
              </label>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg" role="alert">
              <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span className="text-sm text-red-800">{error}</span>
            </div>
          )}
        </form>

        <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/60">
          <button onClick={onClose} type="button" className="tp-focus-ring px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={isSaving || !subject.trim() || !requesterEmail.trim() || (assignMode === 'pick' && !assignTechId)}
            className="tp-focus-ring inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-semibold rounded-lg shadow-subtle hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
            {isSaving ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}
