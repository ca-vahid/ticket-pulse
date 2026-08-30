import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Mail, Search, Send, ShieldCheck, Stamp, X } from 'lucide-react';
import { PersonAvatar } from './ticketUi';
import RichTextEditor, { isRichContent } from './RichTextEditor';

const SEARCH_THRESHOLD = 6; // show the filter box once the list gets long

/**
 * Guided "Request approval" modal. Replaces the cramped inline dropdown with a
 * clear two-step flow: pick a category (each option previews the managers who
 * will be notified), add optional context, send. `onSubmit` gets
 * { approvalCategoryId, note } and should resolve/reject; the modal shows the
 * busy state and closes on success (parent unmounts it).
 */
export default function RequestApprovalModal({ categories = [], technicians = [], busy = false, onSubmit, onClose }) {
  const [categoryId, setCategoryId] = useState(categories.length === 1 ? categories[0].id : null);
  const [note, setNote] = useState(''); // plain text (canonical fallback)
  const [noteHtml, setNoteHtml] = useState(''); // sanitized rich variant (P2.4)
  const [query, setQuery] = useState('');
  const [notifyApprover, setNotifyApprover] = useState(true); // QA 07-14 #2: suppressible, on by default

  const showSearch = categories.length > SEARCH_THRESHOLD;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => `${c.name} ${c.description || ''}`.toLowerCase().includes(q));
  }, [categories, query]);

  const memberByEmail = useMemo(() => {
    const map = new Map();
    for (const t of technicians) if (t.email) map.set(t.email.toLowerCase(), t);
    return map;
  }, [technicians]);

  const managersFor = (cat) => (cat.managerEmails || []).map((email) => {
    const m = memberByEmail.get(String(email).toLowerCase());
    return { email, name: m?.name || email, photoUrl: m?.photoUrl || null };
  });

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selected = categories.find((c) => c.id === categoryId) || null;
  const submit = (e) => {
    e.preventDefault();
    if (!categoryId || busy) return;
    onSubmit({
      approvalCategoryId: Number(categoryId),
      note: note.trim() || null,
      noteHtml: note.trim() && isRichContent(noteHtml) ? noteHtml : null,
      notifyApprover,
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="req-approval-title">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <form onSubmit={submit} className="relative tp-card rounded-2xl shadow-soft w-full max-w-lg max-h-[90vh] flex flex-col animate-scaleIn">
        <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-border/60">
          <span className="h-9 w-9 rounded-xl bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 inline-flex items-center justify-center flex-shrink-0">
            <Stamp className="w-4.5 h-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="req-approval-title" className="text-base font-bold text-foreground">Request approval</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Route this ticket to an approval category. Any one of its managers can decide.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto settings-scrollbar space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">1 · What needs approval?</p>
              <span className="text-[11px] text-muted-foreground/50">{categories.length}</span>
            </div>
            {showSearch && (
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter categories…"
                  aria-label="Filter approval categories"
                  className="tp-focus-ring w-full text-sm bg-card border border-input rounded-lg pl-8 pr-3 py-2 placeholder:text-muted-foreground/75"
                />
              </div>
            )}
            <div className={`space-y-1.5 ${showSearch ? 'max-h-[300px] overflow-y-auto settings-scrollbar pr-1' : ''}`}>
              {filtered.length === 0 && (
                <p className="text-sm text-muted-foreground/75 py-4 text-center">No categories match “{query}”.</p>
              )}
              {filtered.map((cat) => {
                const managers = managersFor(cat);
                const active = cat.id === categoryId;
                return (
                  <button
                    type="button"
                    key={cat.id}
                    onClick={() => setCategoryId(cat.id)}
                    className={`tp-focus-ring w-full text-left rounded-lg border px-3 py-2.5 transition-all ${
                      active ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-500/10 ring-2 ring-blue-200 dark:ring-blue-500/30' : 'border-border bg-card hover:border-blue-200 dark:hover:border-blue-500/30 hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-5 w-5 rounded-full border flex items-center justify-center flex-shrink-0 ${active ? 'border-blue-500 bg-blue-500 text-white' : 'border-input'}`}>
                        {active && <Check className="w-3 h-3" aria-hidden="true" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-foreground truncate">{cat.name}</span>
                        {cat.description && <span className="block text-xs text-muted-foreground truncate">{cat.description}</span>}
                      </span>
                      {/* Approver avatars collapse to the right; compact for long lists */}
                      <span className="flex -space-x-2 flex-shrink-0" title={`${cat.managerCount} approver${cat.managerCount === 1 ? '' : 's'}`}>
                        {managers.slice(0, 3).map((m) => (
                          <span key={m.email} className="ring-2 ring-card rounded-full">
                            <PersonAvatar name={m.name} photoUrl={m.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                          </span>
                        ))}
                        {managers.length > 3 && (
                          <span className="h-6 w-6 rounded-full bg-muted border-2 border-card text-[9px] font-semibold text-muted-foreground flex items-center justify-center">+{managers.length - 3}</span>
                        )}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="approval-note" className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-2">
              2 · Context for the approver(s) <span className="font-normal normal-case text-muted-foreground/50">— optional</span>
            </label>
            <RichTextEditor
              value={noteHtml}
              onChange={({ html, text }) => { setNoteHtml(html); setNote(text); }}
              placeholder="Why does this need approval? e.g. “New hire starting Monday needs a dev laptop — budget code IT-204.”"
              ariaLabel="Approval context"
              minHeight={96}
            />
          </div>

          {selected && (
            <div className="space-y-2">
              <label className="flex items-start gap-2 rounded-xl bg-muted/50 border border-border/60 px-3 py-2.5 cursor-pointer hover:border-blue-200 dark:hover:border-blue-500/30 transition-colors">
                <input
                  type="checkbox"
                  checked={notifyApprover}
                  onChange={(e) => setNotifyApprover(e.target.checked)}
                  className="tp-focus-ring mt-0.5"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground/85">
                    <Mail className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" /> Email the approver{selected.managerCount === 1 ? '' : 's'} a decision link
                  </span>
                  <span className="block text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                    {notifyApprover
                      ? 'Each manager gets a personal email link to approve or reject without signing in (sent from ticketpulse@ — may land in Junk on first use).'
                      : 'No email — approvers will only see the request in-app under Approvals.'}
                  </span>
                </span>
              </label>
              <p className="text-[11px] text-muted-foreground leading-relaxed px-1">
                The <span className="font-medium text-muted-foreground">{selected.managerCount}</span> manager{selected.managerCount === 1 ? '' : 's'} of
                <span className="font-medium text-muted-foreground"> {selected.name}</span> are notified in-app{notifyApprover ? ' and by email' : ''}. The first to respond decides;
                the rest auto-cancel.
              </p>
            </div>
          )}

          {/* QA 08-11 #4: the TP-only note shows ALWAYS — not only once a
              category is picked (it used to hide inside the {selected} block). */}
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-relaxed px-1">
            <ShieldCheck className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-px" aria-hidden="true" />
            <span>Approvals stay inside Ticket Pulse — never synced to FreshService. You&apos;ll get an email when the decision is made.</span>
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border/60">
          <button type="button" onClick={onClose} className="tp-focus-ring px-3.5 py-2 text-sm font-medium rounded-lg text-muted-foreground hover:bg-muted">Cancel</button>
          <button
            type="submit"
            disabled={!categoryId || busy}
            className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
            {busy ? 'Sending…' : 'Send approval request'}
          </button>
        </div>
      </form>
    </div>
  );
}
