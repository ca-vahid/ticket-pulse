import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, RefreshCw, TicketPlus } from 'lucide-react';
import { notificationWorkflowAPI } from '../../services/api';

/**
 * Mail Workflows: the reopen-on-reply pieces (MEGA 11-14, Part A, contract §3–4).
 *
 *  - ReopenCheckNotice: "two workflows both reopen on a reply" / "nothing
 *    reopens on a reply" — on the list and in the editor of a reply workflow.
 *  - ReopenUpgradeBanner: an older reopen workflow can be brought up to the
 *    new shape. One button writes the update as the DRAFT (never published);
 *    the admin checks it and publishes.
 *  - NewTicketFromReplyEditor: the small editor of the "New ticket from this
 *    reply" step.
 *
 * Calm, short, no pills: an icon, one line per point, at most one button.
 */

/** The warnings from GET …/reopen-check; [] while loading or when the call fails. */
export function useReopenCheck(refreshKey) {
  const [check, setCheck] = useState(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => notificationWorkflowAPI.reopenCheck())
      .then((res) => { if (!cancelled) setCheck(res?.data || null); })
      .catch(() => { if (!cancelled) setCheck(null); });
    return () => { cancelled = true; };
  }, [refreshKey]);
  return check;
}

/** The reply workflows, as the key that says when the check is worth asking again. */
export function reopenCheckKey(workflows = [], triggerType = 'ticket.reply_received') {
  return (workflows || [])
    .filter((w) => w?.triggerType === triggerType)
    .map((w) => `${w.id}:${w.isEnabled ? 1 : 0}:${w.publishedVersion || 0}:${w.archivedAt ? 1 : 0}`)
    .join('|');
}

export function ReopenCheckNotice({ warnings = [], className = '' }) {
  const list = (Array.isArray(warnings) ? warnings : []).filter((w) => w && w.message);
  if (list.length === 0) return null;
  return (
    <div
      role="status"
      className={`border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200 ${className}`}
      data-testid="reopen-check-notice"
    >
      <ul className="space-y-1">
        {list.map((warning) => (
          <li key={warning.code || warning.message} className="flex items-start gap-2 text-xs" data-code={warning.code}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
            <span className="min-w-0 flex-1">{warning.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "This workflow can be updated": the changes as short sentences and one
 * button that writes them as the draft. `disabledReason` (unsaved edits on
 * screen) keeps the button off and says why.
 */
export function ReopenUpgradeBanner({ workflowId, disabledReason = null, onApplied, className = '' }) {
  const [offer, setOffer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setOffer(null);
    setError(null);
    if (!workflowId) return undefined;
    Promise.resolve()
      .then(() => notificationWorkflowAPI.getReopenUpgrade(workflowId))
      .then((res) => { if (!cancelled) setOffer(res?.data || null); })
      .catch(() => { if (!cancelled) setOffer(null); });
    return () => { cancelled = true; };
  }, [workflowId]);

  if (!offer?.available) return null;
  const changes = Array.isArray(offer.changes) ? offer.changes.filter(Boolean) : [];

  const apply = async () => {
    if (busy || disabledReason) return;
    setBusy(true);
    setError(null);
    try {
      const res = await notificationWorkflowAPI.applyReopenUpgrade(workflowId);
      setOffer(null);
      await onApplied?.(res?.data || {});
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'The update could not be written.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="This workflow can be updated"
      className={`border-blue-200 bg-blue-50/70 text-foreground dark:border-blue-500/30 dark:bg-blue-500/10 ${className}`}
      data-testid="reopen-upgrade-banner"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">This workflow can be updated</p>
          {changes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {changes.map((change) => (
                <li key={change} className="flex gap-1.5">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-blue-500/70" aria-hidden="true" />
                  <span>{change}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground/75">It lands as a draft. Nothing changes until you publish it.</p>
          {error && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{error}</p>}
        </div>
        <button
          type="button"
          onClick={apply}
          disabled={busy || Boolean(disabledReason)}
          title={disabledReason || 'Write the update as a draft of this workflow'}
          className="tp-focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy && <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Update as a draft
        </button>
      </div>
      {disabledReason && <p className="mt-1 pl-7 text-[11px] text-muted-foreground">{disabledReason}</p>}
    </section>
  );
}

/** The "New ticket from this reply" step (create_ticket_from_reply). */
export function NewTicketFromReplyEditor({ data = {}, onChange }) {
  return (
    <div className="space-y-3" data-testid="new-ticket-from-reply-editor">
      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <TicketPlus className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="text-xs leading-5 text-muted-foreground">
          Starts a new ticket from the reply, for the person who replied, linked to this one. This ticket stays closed and gets a line that points to the new one.
        </p>
      </div>
      <label className="block text-xs font-medium text-muted-foreground">
        Extra line on this ticket (optional)
        <input
          value={data.note || ''}
          onChange={(event) => onChange({ note: event.target.value })}
          placeholder="e.g. Closed over 14 days ago, so the reply became a new ticket."
          className="tp-focus-ring mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/75"
        />
      </label>
    </div>
  );
}
