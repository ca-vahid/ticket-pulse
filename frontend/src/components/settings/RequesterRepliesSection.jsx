import { useEffect, useState } from 'react';
import { AlertTriangle, Check, MessageSquareReply } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';

/**
 * Settings → Ticket Ops → When a requester replies (13 Oct 2026; one page
 * since 14 Oct 2026, plans/REQUESTER_REPLY_SETTINGS_PLAN.md).
 *
 * What Ticket Pulse does on its own after a requester replies, per workspace:
 *  - Reopen the ticket: a tick list of the workspace's statuses. Saved on, it
 *    replaces the "Reopen on requester reply" mail workflow, which is archived
 *    (never deleted) and named here. Off, the page says plainly when nothing
 *    reopens tickets any more, and offers to bring the workflow back.
 *  - A thank-you or out-of-office reply does not reopen (+ the monthly limit
 *    for reading replies).
 *  - The owner-away and new-request switches (13 Oct 2026).
 * Switches save at once; the reopen block has its own Save because saving it
 * on archives a workflow. Plain words only — no codes, no JSON.
 */
const FOLLOW_UP_SWITCHES = [
  {
    key: 'rerouteWhenOwnerAway',
    label: 'Send the ticket back for assignment when its owner is away',
    help: 'When a requester replies and the owner is away for more than one working day, the owner is cleared and the ticket goes through assignment again, with a private note saying why. A single day off, working from home and half days do not count.',
  },
  {
    key: 'suggestNewRequest',
    label: 'Suggest a new ticket when a reply is really a new request',
    help: 'When a reply reopens a ticket that was resolved more than a day ago and asks for something else, the ticket shows a suggestion to split the reply into its own ticket. Nothing is split until a person says so.',
  },
];
const REOPEN_LABEL = 'Reopen the ticket';
const THANKS_LABEL = 'A thank-you or out-of-office reply does not reopen';

function Switch({ checked, disabled, label, onClick }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      aria-label={`${label} ${checked ? 'on' : 'off'}`}
      onClick={onClick}
      disabled={disabled}
      className={`tp-focus-ring relative inline-flex h-5 w-9 shrink-0 rounded-full disabled:opacity-60 ${checked ? 'bg-primary' : 'bg-muted-foreground/40'}`}
    >
      <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-card shadow" style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }} aria-hidden="true" />
    </button>
  );
}

const quoted = (names) => {
  const list = names.map((n) => `“${n}”`);
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};
const shortDay = (at) => {
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;
};
const money = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : null);

function Notice({ tone = 'info', children, testId }) {
  const tones = {
    info: 'text-muted-foreground',
    warn: 'text-amber-800 dark:text-amber-200',
  };
  return (
    <p className={`mt-2 flex items-start gap-1.5 text-xs ${tones[tone]}`} data-testid={testId}>
      {tone === 'warn' && <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />}
      <span>{children}</span>
    </p>
  );
}

export default function RequesterRepliesSection() {
  const [ctx, setCtx] = useState(null); // null = loading
  const [draft, setDraft] = useState(null); // the reopen block while it is being changed: { on, statuses }
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null); // one line after a save of the reopen block

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => ticketsAPI.getRequesterReplySettings())
      .then((res) => { if (!cancelled) setCtx((res?.data?.data ?? res?.data) || {}); })
      .catch(() => { if (!cancelled) setCtx({}); });
    return () => { cancelled = true; };
  }, []);

  const loading = ctx === null;
  const statuses = Array.isArray(ctx?.statuses) ? ctx.statuses : [];
  const savedStatuses = Array.isArray(ctx?.reopenStatuses) ? ctx.reopenStatuses : [];
  const suggested = Array.isArray(ctx?.suggestedReopenStatuses) ? ctx.suggestedReopenStatuses : [];
  const liveWorkflows = Array.isArray(ctx?.reopenWorkflows) ? ctx.reopenWorkflows : [];
  const retired = Array.isArray(ctx?.retiredWorkflows) ? ctx.retiredWorkflows : [];
  const capChoices = Array.isArray(ctx?.replyCheckCapChoices) && ctx.replyCheckCapChoices.length ? ctx.replyCheckCapChoices : [5, 10, 25, 50];
  const reopenSaved = ctx?.reopenOnReply === true;
  const reopenShown = draft ? draft.on : reopenSaved;
  const ticked = draft ? draft.statuses : savedStatuses;
  const isTicked = (name) => ticked.some((s) => s.toLowerCase() === name.toLowerCase());

  const save = async (key, patch) => {
    if (loading || busy) return null;
    setBusy(key);
    setError(null);
    setSaved(null);
    try {
      const res = await ticketsAPI.updateRequesterReplySettings(patch);
      setCtx((res?.data?.data ?? res?.data) || {});
      return res?.data || {};
    } catch (e) {
      setError(e.response?.data?.message || e.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  // ---- the reopen block (draft + Save) ----
  const startDraft = (over = {}) => {
    const statusesNow = savedStatuses.length ? savedStatuses : suggested;
    setDraft({ on: reopenSaved, statuses: [...statusesNow], ...over });
    setSaved(null);
  };
  const toggleReopen = () => {
    if (loading || busy) return;
    if (!draft) startDraft({ on: !reopenSaved });
    else setDraft({ ...draft, on: !draft.on });
  };
  const toggleStatus = (name) => {
    if (loading || busy) return;
    const base = draft || { on: reopenSaved, statuses: [...savedStatuses] };
    const has = base.statuses.some((s) => s.toLowerCase() === name.toLowerCase());
    setDraft({ ...base, statuses: has ? base.statuses.filter((s) => s.toLowerCase() !== name.toLowerCase()) : [...base.statuses, name] });
    setSaved(null);
  };
  const saveReopen = async () => {
    if (!draft) return;
    const body = await save('reopen', draft.on ? { reopenOnReply: true, reopenStatuses: draft.statuses } : { reopenOnReply: false });
    if (!body) return;
    setDraft(null);
    const names = (body.retirement?.retired || []).map((w) => w.name);
    setSaved(draft.on
      ? (names.length ? `Saved. ${quoted(names)} ${names.length === 1 ? 'is' : 'are'} archived in Mail Workflows (not deleted); this page reopens tickets now.` : 'Saved.')
      : 'Saved. This page no longer reopens tickets.');
  };
  const restore = async (wf) => {
    if (loading || busy) return;
    setBusy(`restore-${wf.id}`);
    setError(null);
    setSaved(null);
    try {
      const res = await ticketsAPI.restoreRequesterReplyWorkflow(wf.id);
      setCtx((res?.data?.data ?? res?.data) || {});
      setSaved(`“${wf.name}” is back in Mail Workflows${wf.wasEnabled ? ' and switched on' : ''}.`);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setBusy(null);
    }
  };

  const dirty = draft && (draft.on !== reopenSaved
    || (draft.on && (draft.statuses.length !== savedStatuses.length || draft.statuses.some((s) => !savedStatuses.some((x) => x.toLowerCase() === s.toLowerCase())))));
  const noneTicked = draft?.on && draft.statuses.length === 0;
  const liveReopenOnly = liveWorkflows.filter((w) => w.shape === 'reopen_only');
  const liveReopenPlus = liveWorkflows.filter((w) => w.shape === 'reopen_plus' && w.isEnabled);
  const workflowReopens = liveWorkflows.some((w) => w.isEnabled);

  const budget = ctx?.replyCheckBudget || {};
  const spent = money(budget.spentUsd);

  return (
    <section className="tp-card rounded-xl p-4" aria-label="When a requester replies">
      <div className="flex items-center gap-2 mb-1">
        <MessageSquareReply className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">When a requester replies</h3>
      </div>
      <p className="text-xs text-muted-foreground/75 mb-3">What Ticket Pulse does on its own after a requester replies.</p>

      <ul className="divide-y divide-border/60">
        {/* Reopen the ticket */}
        <li className="py-2.5 first:pt-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground/85">{REOPEN_LABEL}</p>
              <p className="text-xs text-muted-foreground mt-0.5">A reply to a ticket in one of the ticked statuses puts it back to Open.</p>
            </div>
            <Switch checked={reopenShown} disabled={loading || busy !== null} label={REOPEN_LABEL} onClick={toggleReopen} />
          </div>

          {reopenShown && (
            <fieldset className="mt-2.5" disabled={loading || busy !== null}>
              <legend className="text-xs font-semibold text-foreground/85 mb-1.5">Reopen from</legend>
              {statuses.length === 0 ? (
                <p className="text-xs text-muted-foreground">No statuses to choose from.</p>
              ) : (
                <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {statuses.map((s) => (
                    <label key={s.name} className="flex cursor-pointer items-center gap-2 text-sm text-foreground/85">
                      <input
                        type="checkbox"
                        checked={isTicked(s.name)}
                        onChange={() => toggleStatus(s.name)}
                        className="tp-focus-ring h-4 w-4 rounded border-input accent-primary"
                      />
                      <span>{s.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          )}

          {/* What it replaces / what still reopens */}
          {draft && draft.on && !reopenSaved && liveReopenOnly.length > 0 && (
            <Notice>Saving archives the mail workflow {quoted(liveReopenOnly.map((w) => w.name))} (it is not deleted). This page reopens tickets from then on.</Notice>
          )}
          {!draft && reopenSaved && retired.length > 0 && (
            <Notice testId="reopen-replaced">
              Replaces the mail workflow {quoted(retired.map((w) => w.name))}, archived {shortDay(retired[retired.length - 1].at) || 'when this was saved'} (not deleted).
            </Notice>
          )}
          {reopenShown && liveReopenPlus.length > 0 && (
            <Notice>
              {quoted(liveReopenPlus.map((w) => w.name))} also reopens tickets and does more, so it stays on in Mail Workflows.
            </Notice>
          )}
          {draft && !draft.on && reopenSaved && (
            <Notice tone="warn">After saving, nothing reopens tickets when a requester replies. The archived mail workflow stays archived until you bring it back.</Notice>
          )}
          {!draft && !reopenSaved && !loading && (
            workflowReopens ? (
              // QA 10-15 #11: "Do I need to turn this on?" — no; say so first, then what turning it on changes.
              <Notice testId="workflow-reopens">
                You do not need to turn this on: the mail workflow {quoted(liveWorkflows.filter((w) => w.isEnabled).map((w) => w.name))} already reopens tickets.
                Turn it on only if you want Ticket Pulse to do it instead; saving archives that workflow (it can be brought back), and the statuses ticked here decide what reopens.
              </Notice>
            ) : (
              <div data-testid="nothing-reopens">
                <Notice tone="warn">Nothing reopens tickets when a requester replies in this workspace.</Notice>
                {retired.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-5">
                    {retired.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => restore(w)}
                        disabled={busy !== null}
                        className="tp-focus-ring rounded text-xs font-semibold text-primary hover:underline disabled:opacity-60"
                      >
                        Bring back “{w.name}”
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          )}

          {draft && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={saveReopen}
                disabled={!dirty || noneTicked || busy !== null}
                className="tp-focus-ring rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                {busy === 'reopen' ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                disabled={busy !== null}
                className="tp-focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              {noneTicked && <span className="text-xs text-muted-foreground">Tick at least one status.</span>}
            </div>
          )}
          {saved && (
            <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-300" role="status">
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> {saved}
            </p>
          )}
        </li>

        {/* A thank-you or out-of-office reply does not reopen */}
        <li className="py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground/85">{THANKS_LABEL}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                A reply to a resolved or closed ticket that only says thanks, or is an automatic out-of-office, leaves it closed. The conversation gets one quiet line that notifies nobody. When the reply is unclear, the ticket reopens.
              </p>
            </div>
            <Switch
              checked={ctx?.ignoreThanks === true}
              disabled={loading || busy !== null}
              label={THANKS_LABEL}
              onClick={() => save('ignoreThanks', { ignoreThanks: !(ctx?.ignoreThanks === true) })}
            />
          </div>
          {ctx?.ignoreThanks === true && (
            <>
              {!reopenSaved && workflowReopens && (
                <Notice>While the mail workflow reopens tickets, this works when its step has “Ignore a thank-you or out-of-office reply” switched on.</Notice>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-xs font-semibold text-foreground/85">Monthly limit for reading replies</span>
                <div className="w-24">
                  <FancySelect
                    value={String(ctx?.replyCheckMonthlyCapUsd ?? 10)}
                    onChange={(v) => save('cap', { replyCheckMonthlyCapUsd: Number(v) })}
                    options={capChoices.map((n) => ({ value: String(n), label: `$${n}` }))}
                    disabled={loading || busy !== null}
                    aria-label="Monthly limit for reading replies"
                    className="h-8"
                  />
                </div>
                <span className="text-xs text-muted-foreground" data-testid="reply-check-spend">
                  {spent
                    ? `This month: ${spent}${Number.isFinite(Number(budget.checks)) ? `, ${budget.checks} ${budget.checks === 1 ? 'reply' : 'replies'} read` : ''}. At the limit, replies reopen.`
                    : 'This month: not known yet. Until it is, replies reopen.'}
                </span>
              </div>
            </>
          )}
        </li>

        {FOLLOW_UP_SWITCHES.map((s) => (
          <li key={s.key} className="flex items-start justify-between gap-3 py-2.5 last:pb-0">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground/85">{s.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.help}</p>
            </div>
            <Switch
              checked={ctx?.[s.key] === true}
              disabled={loading || busy !== null}
              label={s.label}
              onClick={() => save(s.key, { [s.key]: !(ctx?.[s.key] === true) })}
            />
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-red-600 dark:text-red-300 mt-2" role="alert">{error}</p>}
    </section>
  );
}
