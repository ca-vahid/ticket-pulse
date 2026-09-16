import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Forward, Loader2, Search, X } from 'lucide-react';
import { PersonAvatar } from './ticketUi';

/**
 * Approvals v2 — shared hand-off UI (in-app timeline, Approvals inbox and the
 * public magic-link page all use the same pieces):
 *
 *  - <PeoplePicker/>: searchable combobox over workspace people
 *    ({ name, email, photoUrl? }) with rich rows; `onPick(person)`.
 *  - <HandoffPanel/>: the inline "Escalate to <next tier>" / "Forward to …"
 *    form (required note; forward needs a target). `onSubmit({ mode, note,
 *    toEmail })` returns a promise; errors render inline.
 *  - formatMoney(): "$5,200.00" the way the backend prints it.
 */

export function formatMoney(amount, currency = 'CAD') {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency || 'CAD' }).format(n);
  } catch {
    return `${currency || 'CAD'} ${n.toFixed(2)}`;
  }
}

export function PeoplePicker({
  people = [], value = null, onPick, placeholder = 'Search people…', autoFocus = false, ariaLabel = 'Forward to', emptyText = 'No one matches',
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people || [])
      .filter((p) => p && p.email)
      .filter((p) => !q || String(p.name || '').toLowerCase().includes(q) || String(p.email).toLowerCase().includes(q))
      .slice(0, 8);
  }, [people, query]);

  useEffect(() => { setCursor(0); }, [query]);

  const selected = value ? (people || []).find((p) => String(p.email).toLowerCase() === String(value).toLowerCase()) || { email: value, name: value } : null;
  const pick = (p) => { onPick?.(p); setQuery(''); setOpen(false); };

  if (selected) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/60 dark:bg-blue-500/10 px-2 py-1.5">
        <PersonAvatar name={selected.name || selected.email} photoUrl={selected.photoUrl} size="h-7 w-7" textSize="text-[10px]" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground truncate">{selected.name || selected.email}</span>
          {selected.name && <span className="block text-[11px] text-muted-foreground truncate">{selected.email}</span>}
        </span>
        <button type="button" onClick={() => onPick?.(null)} aria-label="Change person" className="tp-focus-ring p-1 rounded-md text-muted-foreground/75 hover:text-foreground hover:bg-muted">
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" />
        <input
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor((c) => Math.min(results.length - 1, c + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
            else if (e.key === 'Enter' && open && results[cursor]) { e.preventDefault(); pick(results[cursor]); }
            else if (e.key === 'Escape') { setOpen(false); }
          }}
          placeholder={placeholder}
          className="tp-focus-ring w-full text-sm bg-card border border-input rounded-lg pl-8 pr-8 py-2 placeholder:text-muted-foreground/75"
        />
        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" aria-hidden="true" />
      </div>
      {open && (
        <ul role="listbox" className="absolute z-40 mt-1 w-full tp-card rounded-xl shadow-soft p-1.5 max-h-64 overflow-y-auto settings-scrollbar animate-scaleIn">
          {results.length === 0 && (
            <li className="px-3 py-3 text-sm text-muted-foreground/75">{query.trim() ? `${emptyText} “${query.trim()}”.` : 'Type a name or e-mail.'}</li>
          )}
          {results.map((p, i) => (
            <li key={p.email}>
              <button
                type="button"
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(p)}
                className={`tp-focus-ring w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left ${i === cursor ? 'bg-blue-50 dark:bg-blue-500/15' : 'hover:bg-muted'}`}
              >
                <PersonAvatar name={p.name || p.email} photoUrl={p.photoUrl} size="h-8 w-8" textSize="text-[10px]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground truncate">{p.name || p.email}</span>
                  <span className="block text-[11px] text-muted-foreground truncate">{p.email}{p.role ? ` · ${p.role}` : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const MODE_META = {
  escalate: {
    Icon: ArrowUpRight,
    title: (ctx) => `Escalate to ${ctx.nextTierName || 'the next tier'}`,
    hint: (ctx) => `${ctx.nextTierNames?.length ? ctx.nextTierNames.join(', ') : 'The next tier'} will get the request with your note. You are handed off — the decision is theirs.`,
    placeholder: 'Why does this need the next tier? (required — the next approver reads this)',
    submit: 'Escalate',
    tone: 'bg-amber-600 hover:bg-amber-700',
  },
  forward: {
    Icon: Forward,
    title: () => 'Forward to someone else',
    hint: () => 'They become the final approver: their decision ends the request, whatever the amount. You are handed off.',
    placeholder: 'Why are you forwarding this? (required — they read this)',
    submit: 'Forward',
    tone: 'bg-primary hover:bg-blue-700',
  },
};

export function HandoffPanel({ mode, people = [], nextTierName = null, nextTierNames = [], onSubmit, onCancel, compact = false }) {
  const meta = MODE_META[mode] || MODE_META.forward;
  const [note, setNote] = useState('');
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ctx = { nextTierName, nextTierNames };
  const ready = note.trim().length > 0 && (mode !== 'forward' || Boolean(target));

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      await onSubmit({ mode, note: note.trim(), toEmail: target?.email || null });
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not hand this off. Try again.');
      setBusy(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={meta.title(ctx)}
      className={`rounded-xl border ${mode === 'escalate' ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/10' : 'border-blue-200 dark:border-blue-500/30 bg-blue-50/50 dark:bg-blue-500/10'} ${compact ? 'p-2.5 space-y-2' : 'p-3.5 space-y-2.5'}`}
    >
      <div className="flex items-start gap-2">
        <meta.Icon className={`w-4 h-4 mt-0.5 shrink-0 ${mode === 'escalate' ? 'text-amber-600 dark:text-amber-300' : 'text-blue-600 dark:text-blue-300'}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{meta.title(ctx)}</p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">{meta.hint(ctx)}</p>
        </div>
      </div>
      {mode === 'forward' && (
        <PeoplePicker people={people} value={target?.email || null} onPick={setTarget} autoFocus placeholder="Search anyone in the workspace…" ariaLabel="Forward to" />
      )}
      <textarea
        rows={compact ? 2 : 3}
        autoFocus={mode !== 'forward'}
        value={note}
        onChange={(e) => { setNote(e.target.value); if (error) setError(null); }}
        placeholder={meta.placeholder}
        aria-label={`${meta.submit} note`}
        className="tp-focus-ring w-full text-sm bg-card border border-input rounded-lg px-3 py-2 placeholder:text-muted-foreground/75"
      />
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-200">{error}</p>}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={submit}
          disabled={!ready || busy}
          className={`tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-white disabled:opacity-50 ${meta.tone}`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
          {busy ? 'Sending…' : meta.submit}{mode === 'forward' && target ? ` to ${(target.name || target.email).split(' ')[0]}` : ''}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="tp-focus-ring px-2.5 py-1.5 text-xs font-medium rounded-lg text-muted-foreground hover:bg-muted">Cancel</button>
        {!ready && <span className="text-[11px] text-muted-foreground/75">{mode === 'forward' && !target ? 'Pick a person and add a note' : 'A note is required'}</span>}
      </div>
    </div>
  );
}

/** Small chips shared by the timeline, inbox and public page. */
export function TierChip({ tier, tierName, tierCount, className = '' }) {
  if (!tierCount || tierCount < 2) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border border-border bg-muted/70 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground ${className}`} title={`Approval tier ${tier} of ${tierCount}`}>
      {tierName || `Tier ${tier}`}<span className="text-muted-foreground/60">/{tierCount}</span>
    </span>
  );
}

export function AmountChip({ amount, currency, className = '' }) {
  const label = formatMoney(amount, currency);
  if (!label) return null;
  return (
    <span className={`inline-flex items-center rounded-full border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-800 dark:text-emerald-200 ${className}`} title="Amount on this request">
      {label}
    </span>
  );
}

/** Reads a hand-off log entry as a sentence ("Vahid escalated to Tier 2 — “needs CISO”"). */
export function handoffSentence(entry, { withNote = true } = {}) {
  if (!entry) return '';
  const by = entry.byName || entry.byEmail || 'An approver';
  const to = (entry.toNames && entry.toNames.length ? entry.toNames : entry.toEmails || []).join(', ');
  const tier = entry.toTierName || (entry.toTier ? `Tier ${entry.toTier}` : 'the next tier');
  let s;
  if (entry.kind === 'forwarded') s = `${by} forwarded this to ${to || 'someone else'} as the final approver`;
  else if (entry.kind === 'auto') s = `${by} approved at ${entry.fromTierName || `Tier ${entry.fromTier || 1}`} — over the limit, so it moved on to ${tier}${to ? ` (${to})` : ''}`;
  else s = `${by} escalated this to ${tier}${to ? ` (${to})` : ''}`;
  if (withNote && entry.note) s += ` — “${entry.note}”`;
  return s;
}
