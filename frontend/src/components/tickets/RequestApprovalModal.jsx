import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, BadgeDollarSign, Check, ChevronDown, ImagePlus, Loader2, Mail, Paperclip, Search, Send, ShieldCheck, Stamp, X,
} from 'lucide-react';
import { PersonAvatar } from './ticketUi';
import RichTextEditor, { isRichContent } from './RichTextEditor';
import StagedFileChip from './StagedFileChip';
import { formatMoney } from './ApprovalHandoff';

const MAX_FILES = 5;

/**
 * "Request approval" modal — Approvals v2 (09-15 #8).
 *
 *  1. A searchable category combobox with rich rows: description, the tier
 *     chain ("Vahid → Neville"), tier-1 approver avatars, an Amount badge.
 *  2. An amount field when the category is monetary, with a live read-out of
 *     who can finalise that amount (tier limits).
 *  3. The same rich composer as a ticket note: paste or drop screenshots,
 *     attach files. Files are uploaded to the ticket by the parent; the note
 *     keeps a "[Image: name]" marker where the picture was pasted.
 *
 * `onSubmit` gets { approvalCategoryId, note, noteHtml, notifyApprover,
 * amount, files } and should resolve/reject; the parent closes the modal.
 */
export default function RequestApprovalModal({
  categories = [], technicians = [], members = [], busy = false, onSubmit, onClose, allowFiles = true,
}) {
  const [categoryId, setCategoryId] = useState(categories.length === 1 ? categories[0].id : null);
  const [note, setNote] = useState('');
  const [noteHtml, setNoteHtml] = useState('');
  const [amount, setAmount] = useState('');
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [notifyApprover, setNotifyApprover] = useState(true);
  const [amountTouched, setAmountTouched] = useState(false);
  const pasteCount = useRef(0);
  const fileInputRef = useRef(null);

  const people = useMemo(() => {
    const map = new Map();
    for (const t of [...(technicians || []), ...(members || [])]) {
      if (!t?.email) continue;
      const key = String(t.email).toLowerCase();
      if (!map.has(key) || (!map.get(key).photoUrl && t.photoUrl)) map.set(key, t);
    }
    return map;
  }, [technicians, members]);
  const person = (email) => {
    const m = people.get(String(email || '').toLowerCase());
    return { email, name: m?.name || email, photoUrl: m?.photoUrl || null };
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selected = categories.find((c) => c.id === categoryId) || null;
  const tiers = selected ? (Array.isArray(selected.tiers) && selected.tiers.length ? selected.tiers : [{ name: 'Tier 1', managerEmails: selected.managerEmails || [], limit: null }]) : [];
  const monetary = Boolean(selected?.hasAmount);
  const currency = selected?.amountCurrency || 'CAD';
  const amountNumber = amount.trim() === '' ? null : Number(String(amount).replace(/[^0-9.]/g, ''));
  const amountValid = !monetary || (amountNumber !== null && Number.isFinite(amountNumber) && amountNumber >= 0);

  // Which tiers this amount has to pass through (limits are "may finalise up to").
  const route = useMemo(() => {
    if (!selected) return [];
    if (!monetary || amountNumber === null || !Number.isFinite(amountNumber)) return tiers.slice(0, 1);
    const out = [];
    for (let i = 0; i < tiers.length; i += 1) {
      out.push(tiers[i]);
      const limit = tiers[i].limit;
      if (limit === null || limit === undefined || amountNumber <= Number(limit) || i === tiers.length - 1) break;
    }
    return out;
  }, [selected, monetary, amountNumber, tiers]);

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    setFiles((prev) => {
      const merged = [...prev];
      for (const f of incoming) if (!merged.some((x) => x.name === f.name && x.size === f.size)) merged.push(f);
      return merged.slice(0, MAX_FILES);
    });
  };

  const submit = (e) => {
    e.preventDefault();
    if (!categoryId || busy) return;
    if (!amountValid) { setAmountTouched(true); return; }
    onSubmit({
      approvalCategoryId: Number(categoryId),
      note: note.trim() || null,
      noteHtml: note.trim() && isRichContent(noteHtml) ? noteHtml : null,
      notifyApprover,
      amount: monetary ? Math.round(amountNumber * 100) / 100 : null,
      files,
    });
  };

  const tierOneCount = selected ? (tiers[0]?.managerEmails || []).length : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="req-approval-title">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <form onSubmit={submit} className="relative tp-card rounded-2xl shadow-soft w-full max-w-xl max-h-[92vh] flex flex-col animate-scaleIn">
        <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-border/60">
          <span className="h-9 w-9 rounded-xl bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 inline-flex items-center justify-center flex-shrink-0">
            <Stamp className="w-4.5 h-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="req-approval-title" className="text-base font-bold text-foreground">Request approval</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Pick what needs sign-off, add the context, send. The first tier decides — or moves it up.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto settings-scrollbar space-y-4">
          {/* 1 · Category */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-2">1 · What needs approval?</p>
            <CategoryCombobox
              categories={categories}
              value={selected}
              onChange={(c) => { setCategoryId(c ? c.id : null); if (!c?.hasAmount) setAmount(''); }}
              person={person}
            />
          </div>

          {/* 2 · Amount (monetary categories) */}
          {selected && monetary && (
            <div>
              <label htmlFor="approval-amount" className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-2">
                2 · Amount <span className="font-normal normal-case text-muted-foreground/50">— {currency}, required</span>
              </label>
              <div className="flex flex-wrap items-start gap-3">
                <div className="relative w-44">
                  <BadgeDollarSign className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
                  <input
                    id="approval-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    onBlur={() => setAmountTouched(true)}
                    placeholder="0.00"
                    aria-invalid={amountTouched && !amountValid}
                    className={`tp-focus-ring w-full text-sm font-semibold tabular-nums bg-card border rounded-lg pl-8 pr-3 py-2 ${amountTouched && !amountValid ? 'border-red-400' : 'border-input'}`}
                  />
                </div>
                <div className="min-w-0 flex-1 text-xs text-muted-foreground leading-relaxed">
                  {amountNumber !== null && Number.isFinite(amountNumber) ? (
                    <RouteReadout route={route} tiers={tiers} amountLabel={formatMoney(amountNumber, currency)} person={person} />
                  ) : (
                    <span>Enter the total. Each tier has a limit it may approve up to — anything above moves to the next tier automatically after they approve.</span>
                  )}
                </div>
              </div>
              {amountTouched && !amountValid && <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-200">Enter the amount (numbers only).</p>}
            </div>
          )}

          {/* 3 · Context + files */}
          <div>
            <label htmlFor="approval-note" className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-2">
              {selected && monetary ? '3' : '2'} · Context for the approver{tierOneCount === 1 ? '' : 's'} <span className="font-normal normal-case text-muted-foreground/50">— optional · paste or drop screenshots</span>
            </label>
            <div
              onDragOver={(e) => { if (!allowFiles) return; e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { if (!allowFiles) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files); }}
              className={`relative rounded-xl transition-shadow ${dragging ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-card' : ''}`}
            >
              <RichTextEditor
                value={noteHtml}
                onChange={({ html, text }) => { setNoteHtml(html); setNote(text); }}
                placeholder="Why does this need approval? e.g. “New hire starting Monday needs a dev laptop — quote attached, budget code IT-204.”"
                ariaLabel="Approval context"
                minHeight={110}
                onImagePaste={allowFiles ? (file) => {
                  const ext = ((file.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
                  const name = `pasted-image-${++pasteCount.current}.${ext}`;
                  addFiles([new File([file], name, { type: file.type || 'image/png' })]);
                  return name;
                } : undefined}
              />
              {dragging && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-blue-50/80 dark:bg-blue-500/20 text-sm font-semibold text-blue-700 dark:text-blue-200">
                  <span className="inline-flex items-center gap-2"><ImagePlus className="w-4 h-4" aria-hidden="true" /> Drop to attach</span>
                </div>
              )}
            </div>
            {allowFiles && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={files.length >= MAX_FILES}
                  className="tp-focus-ring inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
                >
                  <Paperclip className="w-3.5 h-3.5" aria-hidden="true" /> Attach files
                </button>
                <input ref={fileInputRef} type="file" multiple className="hidden" aria-label="Attach files" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                <span className="text-[11px] text-muted-foreground/75">Files land on the ticket; approvers open it to see them. Up to {MAX_FILES}.</span>
              </div>
            )}
            {files.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2 items-start" aria-label="Files to attach">
                {files.map((file) => (
                  <StagedFileChip key={`${file.name}-${file.size}`} file={file} onRemove={() => setFiles((prev) => prev.filter((f) => f !== file))} />
                ))}
              </ul>
            )}
          </div>

          {selected && (
            <div className="space-y-2">
              <label className="flex items-start gap-2 rounded-xl bg-muted/50 border border-border/60 px-3 py-2.5 cursor-pointer hover:border-blue-200 dark:hover:border-blue-500/30">
                <input type="checkbox" checked={notifyApprover} onChange={(e) => setNotifyApprover(e.target.checked)} className="tp-focus-ring mt-0.5" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground/85">
                    <Mail className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" /> Email the approver{tierOneCount === 1 ? '' : 's'} a decision link
                  </span>
                  <span className="block text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                    {notifyApprover
                      ? 'Each approver gets a personal email link to approve, reject, ask a question, escalate or forward — no sign-in needed.'
                      : 'No email — approvers will only see the request in-app under Approvals.'}
                  </span>
                </span>
              </label>
              <p className="text-[11px] text-muted-foreground leading-relaxed px-1">
                Goes to the <span className="font-medium text-muted-foreground">{tierOneCount}</span> {tiers[0]?.name || 'Tier 1'} approver{tierOneCount === 1 ? '' : 's'} of
                <span className="font-medium text-muted-foreground"> {selected.name}</span>{notifyApprover ? ' in-app and by email' : ' in-app'}. The first to respond decides;
                the rest auto-cancel.{tiers.length > 1 ? ` They can escalate to ${tiers.slice(1).map((t) => t.name).join(' then ')} or forward to anyone.` : ''}
              </p>
            </div>
          )}

          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-relaxed px-1">
            <ShieldCheck className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-px" aria-hidden="true" />
            <span>Approvals stay inside Ticket Pulse — never synced to FreshService. You&apos;ll get an email when the decision is made.</span>
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border/60">
          <button type="button" onClick={onClose} className="tp-focus-ring px-3.5 py-2 text-sm font-medium rounded-lg text-muted-foreground hover:bg-muted">Cancel</button>
          <button
            type="submit"
            disabled={!categoryId || busy || (monetary && amountTouched && !amountValid)}
            className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
            {busy ? (files.length ? 'Uploading & sending…' : 'Sending…') : 'Send approval request'}
          </button>
        </div>
      </form>
    </div>
  );
}

function RouteReadout({ route, tiers, amountLabel, person }) {
  if (!route.length) return null;
  const last = route[route.length - 1];
  const finaliser = (last.managerEmails || []).map((e) => person(e).name).join(', ') || last.name;
  if (route.length === 1) {
    return (
      <span>
        <span className="font-semibold text-foreground">{amountLabel}</span> can be approved by <span className="font-semibold text-foreground">{finaliser}</span>
        {tiers.length > 1 && last.limit !== null && last.limit !== undefined ? ` (${last.name} limit ${formatMoney(last.limit)})` : ''}.
      </span>
    );
  }
  return (
    <span>
      <span className="font-semibold text-foreground">{amountLabel}</span> is over the {route[0].name} limit ({formatMoney(route[0].limit)}) — after{' '}
      {route.slice(0, -1).map((t, i) => (
        <span key={t.name}>{i > 0 ? ' and ' : ''}<span className="font-semibold text-foreground">{(t.managerEmails || []).map((e) => person(e).name).join(', ') || t.name}</span></span>
      ))}
      {' '}approve{route.length - 1 === 1 ? 's' : ''}, it goes on to <span className="font-semibold text-foreground">{finaliser}</span> ({last.name}) automatically.
    </span>
  );
}

/**
 * Searchable single-select over approval categories with rich rows. Opens on
 * focus/typing; arrow keys + Enter select; the chosen category renders as a
 * card with a "Change" affordance.
 */
function CategoryCombobox({ categories, value, onChange, person }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(!value && categories.length > 1);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => `${c.name} ${c.description || ''}`.toLowerCase().includes(q));
  }, [categories, query]);
  useEffect(() => { setCursor(0); }, [query]);

  const pick = (c) => { onChange(c); setQuery(''); setOpen(false); };
  const chain = (c) => (Array.isArray(c.tiers) && c.tiers.length ? c.tiers : [{ name: 'Tier 1', managerEmails: c.managerEmails || [] }]);

  if (value) {
    const tiers = chain(value);
    return (
      <div className="rounded-xl border border-blue-300 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-500/10 ring-2 ring-blue-100 dark:ring-blue-500/20 px-3 py-2.5">
        <div className="flex items-start gap-2.5">
          <span className="h-6 w-6 rounded-full bg-blue-500 text-white flex items-center justify-center flex-shrink-0 mt-0.5"><Check className="w-3.5 h-3.5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-foreground">{value.name}</span>
              {value.hasAmount && <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-200"><BadgeDollarSign className="w-3 h-3" aria-hidden="true" /> {value.amountCurrency || 'CAD'} amount</span>}
            </div>
            {value.description && <p className="text-xs text-muted-foreground mt-0.5">{value.description}</p>}
            <TierChain tiers={tiers} person={person} className="mt-1.5" />
          </div>
          <button type="button" onClick={() => { onChange(null); setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }} className="tp-focus-ring text-xs font-semibold text-blue-700 dark:text-blue-200 hover:underline flex-shrink-0">Change</button>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/75" aria-hidden="true" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-label="Approval category"
          autoFocus
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor((c) => Math.min(filtered.length - 1, c + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); if (open && filtered[cursor]) pick(filtered[cursor]); }
          }}
          placeholder={`Type to search ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}…`}
          className="tp-focus-ring w-full text-sm bg-card border border-input rounded-xl pl-9 pr-9 py-2.5 placeholder:text-muted-foreground/75"
        />
        <ChevronDown className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </div>
      {open && (
        <ul role="listbox" aria-label="Approval categories" className="mt-1.5 w-full rounded-xl border border-border bg-card shadow-subtle p-1.5 space-y-1 animate-fadeIn">
          {filtered.length === 0 && <li className="px-3 py-4 text-sm text-muted-foreground/75 text-center">No categories match “{query}”.</li>}
          {filtered.map((c, i) => {
            const tiers = chain(c);
            const t1 = (tiers[0]?.managerEmails || []).map(person);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(c)}
                  className={`tp-focus-ring w-full text-left rounded-lg border px-3 py-2.5 ${i === cursor ? 'border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15' : 'border-border/60 dark:border-border hover:bg-muted hover:border-border'}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-foreground">{c.name}</span>
                        {c.hasAmount && <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:text-emerald-200"><BadgeDollarSign className="w-3 h-3" aria-hidden="true" /> amount</span>}
                        {tiers.length > 1 && <span className="rounded-full border border-border bg-muted/70 px-1.5 py-px text-[10px] font-semibold text-muted-foreground">{tiers.length} tiers</span>}
                      </div>
                      {c.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{c.description}</p>}
                      <TierChain tiers={tiers} person={person} className="mt-1" compact />
                    </div>
                    <span className="flex -space-x-2 flex-shrink-0 mt-0.5" title={`${t1.length} approver${t1.length === 1 ? '' : 's'}`}>
                      {t1.slice(0, 3).map((m) => (
                        <span key={m.email} className="ring-2 ring-card rounded-full"><PersonAvatar name={m.name} photoUrl={m.photoUrl} size="h-6 w-6" textSize="text-[9px]" /></span>
                      ))}
                      {t1.length > 3 && <span className="h-6 w-6 rounded-full bg-muted border-2 border-card text-[9px] font-semibold text-muted-foreground flex items-center justify-center">+{t1.length - 3}</span>}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TierChain({ tiers, person, className = '', compact = false }) {
  if (!tiers?.length) return null;
  const names = (t) => (t.managerEmails || []).map((e) => person(e).name.split(' ')[0]).join(', ') || '—';
  return (
    <p className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground ${className}`}>
      {tiers.map((t, i) => (
        <span key={t.name || i} className="inline-flex items-center gap-1">
          {i > 0 && <ArrowRight className="w-3 h-3 text-muted-foreground/50" aria-hidden="true" />}
          <span className={compact ? '' : 'font-medium text-foreground/80'}>{names(t)}</span>
          {tiers.length > 1 && <span className="text-muted-foreground/60">({t.name}{t.limit !== null && t.limit !== undefined ? ` · up to ${formatMoney(t.limit)}` : ''})</span>}
        </span>
      ))}
    </p>
  );
}
