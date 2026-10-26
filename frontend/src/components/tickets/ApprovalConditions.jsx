import { useEffect, useRef, useState } from 'react';
import { Activity, CheckCircle2, CircleAlert, ListChecks, Plus, Send, Trash2, Users, XCircle } from 'lucide-react';
import { formatDayTime } from './ticketUi';

/**
 * Approve with conditions, as a conversation (Vahid, 26 Oct 2026).
 *
 * An approver's conditions are separate items. The technician who asked
 * answers each one ("can be met" + how, or "can't be met as asked" + why) and
 * the answers go straight back to the approver, who approves (accepting
 * them), changes the conditions, asks someone, or does not approve. Nothing
 * counts as approved until then.
 *
 *   ConditionsEditor      the approver writes the list (composer)
 *   ConditionsReview      the list with answers, read-only (approver, ticket, public page)
 *   ConditionsAnswerForm  the technician answers on the ticket
 */

export const RESPONSE_LABEL = { can_meet: 'Can be met', cant_meet: "Can't be met as asked" };

export function readConditions(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items) || raw.items.length === 0) return null;
  return raw;
}

/** Who a conditions round waits on: 'it' while answers are due, 'approver' once they are in. */
export function conditionsWaitingOn(raw, status) {
  const c = readConditions(raw);
  if (!c) return null;
  if (status === 'info_requested' && !c.submittedAt) return 'it';
  if (status === 'pending' && c.submittedAt) return 'approver';
  return null;
}

const MAX = 20;

/** The approver's list: one box per condition, Enter on the last adds another. */
export function ConditionsEditor({ value, onChange, disabled = false, autoFocus = false }) {
  const list = value.length ? value : [''];
  const refs = useRef([]);
  const [focusIndex, setFocusIndex] = useState(autoFocus ? 0 : null);
  useEffect(() => {
    if (focusIndex === null) return;
    refs.current[focusIndex]?.focus();
    setFocusIndex(null);
  }, [focusIndex]);
  const set = (i, text) => onChange(list.map((v, n) => (n === i ? text : v)));
  const add = (at = list.length) => {
    if (list.length >= MAX) return;
    const next = [...list.slice(0, at), '', ...list.slice(at)];
    onChange(next);
    setFocusIndex(at);
  };
  const remove = (i) => {
    const next = list.filter((_, n) => n !== i);
    onChange(next.length ? next : ['']);
    setFocusIndex(Math.max(0, i - 1));
  };
  return (
    <div data-testid="conditions-editor">
      <ol className="space-y-2">
        {list.map((text, i) => (
          // Rows have no identity until saved, so the position is the key.
          <li key={i} className="flex items-start gap-2">
            <span className="mt-2 w-5 shrink-0 text-right text-[13px] font-semibold tabular-nums text-muted-foreground">{i + 1}.</span>
            <textarea
              ref={(el) => { refs.current[i] = el; }}
              rows={2}
              value={text}
              disabled={disabled}
              onChange={(e) => set(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && i === list.length - 1 && text.trim()) { e.preventDefault(); add(i + 1); }
              }}
              aria-label={`Condition ${i + 1}`}
              placeholder={i === 0 ? 'e.g. Only models with Public or Internal data are connected' : 'Another condition'}
              className="tp-focus-ring min-h-[44px] w-full resize-y rounded-lg border border-input bg-card px-3 py-2 text-[13.5px] leading-snug text-foreground placeholder:text-muted-foreground/70"
            />
            <button
              type="button"
              onClick={() => remove(i)}
              disabled={disabled || (list.length === 1 && !text)}
              aria-label={`Remove condition ${i + 1}`}
              className="tp-focus-ring mt-1.5 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      {list.length < MAX && (
        <button
          type="button"
          onClick={() => add()}
          disabled={disabled}
          className="tp-focus-ring mt-2 ml-7 inline-flex items-center gap-1 rounded text-[12.5px] font-semibold text-primary hover:underline disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add a condition
        </button>
      )}
    </div>
  );
}

function ResponseLine({ item }) {
  if (!item.response) return <p className="mt-1 text-[12.5px] italic text-muted-foreground">Not answered yet</p>;
  const cant = item.response === 'cant_meet';
  const Icon = cant ? XCircle : CheckCircle2;
  return (
    <p className={`mt-1 text-[13px] leading-relaxed ${cant ? 'text-red-800 dark:text-red-200' : 'text-emerald-800 dark:text-emerald-200'}`}>
      <Icon className="mr-1 inline h-3.5 w-3.5 -translate-y-px" aria-hidden="true" />
      <span className="font-semibold">{RESPONSE_LABEL[item.response]}</span>
      {item.answer ? <span className="text-foreground/85">{' — '}{item.answer}</span> : null}
    </p>
  );
}

/** The conditions with their answers. `variant="agreed"` once the request is approved. */
export function ConditionsReview({ conditions, title = null, variant = 'review', className = '' }) {
  const c = readConditions(conditions);
  if (!c) return null;
  const cant = c.items.filter((i) => i.response === 'cant_meet').length;
  const heading = title || (variant === 'agreed' ? 'Agreed conditions' : c.submittedAt ? `Conditions and ${c.submittedByName || 'IT'}'s answers` : 'Conditions');
  return (
    <section className={`border-l-2 border-amber-400 pl-3.5 dark:border-amber-500/60 ${className}`} data-testid="conditions-review" aria-label={heading}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        <ListChecks className="h-3.5 w-3.5" aria-hidden="true" /> {heading}
      </p>
      {c.note && <p className="mt-1 text-[13px] italic text-muted-foreground">“{c.note}”</p>}
      <ol className="mt-1.5 space-y-2.5">
        {c.items.map((item, n) => (
          <li key={item.id || n} className="flex gap-2">
            <span className="w-5 shrink-0 text-right text-[13px] font-semibold tabular-nums text-muted-foreground">{n + 1}.</span>
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">{item.text}</p>
              {(c.submittedAt || item.response) && <ResponseLine item={item} />}
            </div>
          </li>
        ))}
      </ol>
      {variant !== 'agreed' && c.submittedAt && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          Answered by {c.submittedByName || 'IT'}{c.submittedAt ? ` · ${formatDayTime(c.submittedAt)}` : ''}
          {cant > 0 && <span className="font-semibold text-red-700 dark:text-red-300"> · {cant} can&apos;t be met as asked</span>}
        </p>
      )}
    </section>
  );
}

/**
 * The technician answers on the ticket. Save keeps a draft; Send puts the
 * request back with the approver. "Ask the requester" loops them in first.
 */
export function ConditionsAnswerForm({ conditions, approverName = 'the approver', requesterName = null, busy = false, onSave, onSubmit, onAskRequester = null }) {
  const c = readConditions(conditions);
  // Seeded once (the parent keys this form by round), so a live refresh of the
  // ticket never wipes what is being typed.
  const [answers, setAnswers] = useState(() => Object.fromEntries((c?.items || []).map((i) => [i.id, { response: i.response || null, answer: i.answer || '' }])));
  const [error, setError] = useState(null);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [saved, setSaved] = useState(false);
  if (!c) return null;

  const list = c.items.map((i) => ({ ...i, ...(answers[i.id] || {}) }));
  const missing = list.filter((i) => !i.response || (i.response === 'cant_meet' && !String(i.answer || '').trim()));
  const set = (id, patch) => { setAnswers((a) => ({ ...a, [id]: { ...(a[id] || {}), ...patch } })); setSaved(false); setError(null); };
  const payload = () => list.map((i) => ({ id: i.id, response: i.response, answer: String(i.answer || '').trim() || null }));
  const run = async (fn, after) => {
    try { await fn(); after?.(); } catch (err) { setError(err?.response?.data?.message || err?.message || 'Could not save. Try again.'); }
  };

  return (
    <section className="mt-2 rounded-xl border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-500/30 dark:bg-amber-500/10" data-testid="conditions-answer-form" aria-label="Answer the conditions">
      <p className="text-[13.5px] font-semibold text-foreground">
        {approverName} will approve on {c.items.length === 1 ? 'one condition' : `${c.items.length} conditions`}. It isn&apos;t approved until you answer {c.items.length === 1 ? 'it' : 'each one'}.
      </p>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">Your answers go straight back to {approverName}. Say plainly when something can&apos;t be done; that is what they need to decide.</p>
      {c.note && <p className="mt-2 text-[13px] italic text-muted-foreground">“{c.note}”</p>}
      <ol className="mt-3 space-y-3">
        {list.map((item, n) => (
          <li key={item.id} className="rounded-lg border border-border bg-card p-3">
            <p className="flex gap-2 text-[13.5px] leading-relaxed text-foreground">
              <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-muted-foreground">{n + 1}.</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{item.text}</span>
            </p>
            <div className="mt-2 pl-7">
              <div role="radiogroup" aria-label={`Condition ${n + 1}: can it be met?`} className="flex flex-wrap gap-1.5">
                {[
                  { k: 'can_meet', label: 'Can be met', Icon: CheckCircle2, on: 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100' },
                  { k: 'cant_meet', label: "Can't be met as asked", Icon: XCircle, on: 'border-red-400 bg-red-50 text-red-800 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-100' },
                ].map((o) => (
                  <button
                    key={o.k}
                    type="button"
                    role="radio"
                    aria-checked={item.response === o.k}
                    disabled={busy}
                    onClick={() => set(item.id, { response: o.k })}
                    className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-semibold ${item.response === o.k ? o.on : 'border-border bg-card text-foreground/85 hover:bg-muted/60'}`}
                  >
                    <o.Icon className="h-3.5 w-3.5" aria-hidden="true" /> {o.label}
                  </button>
                ))}
              </div>
              <textarea
                rows={2}
                value={item.answer || ''}
                disabled={busy}
                onChange={(e) => set(item.id, { answer: e.target.value })}
                aria-label={`Condition ${n + 1}: your answer`}
                placeholder={item.response === 'cant_meet' ? "Why it can't be met, and what we can do instead (required)" : 'How it will be met (optional)'}
                className="tp-focus-ring mt-2 w-full resize-y rounded-lg border border-input bg-card px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/70"
              />
            </div>
          </li>
        ))}
      </ol>

      {onAskRequester && (
        <div className="mt-3">
          {!asking ? (
            <button type="button" onClick={() => setAsking(true)} disabled={busy} className="tp-focus-ring inline-flex items-center gap-1.5 rounded text-[12.5px] font-semibold text-primary hover:underline">
              <Users className="h-3.5 w-3.5" aria-hidden="true" /> Need the requester{requesterName ? ` (${requesterName})` : ''} to answer something first?
            </button>
          ) : (
            <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-2.5 dark:border-violet-500/30 dark:bg-violet-500/10">
              <label htmlFor="conditions-ask-requester" className="text-[12.5px] font-semibold text-foreground">Ask {requesterName || 'the requester'}</label>
              <textarea
                id="conditions-ask-requester"
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. Which Power BI models would you connect, and do any hold client data?"
                className="tp-focus-ring mt-1 w-full resize-y rounded-lg border border-input bg-card px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/70"
              />
              <p className="mt-1 text-[11.5px] text-muted-foreground">They answer by replying to the e-mail. The answer lands here for you; {approverName} is not asked to decide until you send your answers.</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || !question.trim()}
                  onClick={() => run(() => onAskRequester(question.trim()), () => { setQuestion(''); setAsking(false); })}
                  className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" /> Send to {requesterName || 'the requester'}
                </button>
                <button type="button" onClick={() => setAsking(false)} className="tp-focus-ring rounded-lg px-2 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-muted">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-sm text-red-700 dark:text-red-200">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> <span>{error}</span>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || missing.length > 0}
          onClick={() => run(() => onSubmit(payload()))}
          className="tp-focus-ring inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
          Send answers to {approverName}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => onSave(payload()), () => setSaved(true))}
          className="tp-focus-ring rounded-[10px] border border-border bg-card px-3 py-2 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-50"
        >
          {saved ? 'Saved' : 'Save for later'}
        </button>
        {missing.length > 0 && (
          <span className="text-[12px] text-muted-foreground">
            {missing.length === list.length ? 'Answer each condition to send' : `${missing.length} still to answer`}
          </span>
        )}
      </div>
    </section>
  );
}
