import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, Minus, Sparkles } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { PRIORITY_LABELS, formatDayTime } from './ticketUi';
import { confidenceTier } from './AutofillModal';

/**
 * "Autofill run" card on the ticket's AI & Routing tab (Autofill v2).
 *
 * When a ticket was composed from a paste, the intake run that read it is
 * linked at create time (`intakeRunId`). This card is the record of that
 * read: when, who, which model, how long / how many tokens — and, behind
 * "Show proposal", every field the model proposed next to what the agent
 * actually kept. Collapsed by default; renders nothing when the ticket has
 * no run (most tickets).
 */

const TIER_CHIP = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30',
  medium: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  low: 'bg-muted text-muted-foreground border-border',
};

const fmtTokens = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
};

const fmtDuration = (ms) => {
  const v = Number(ms);
  if (!Number.isFinite(v)) return null;
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
};

const statusOf = (m) => (m && typeof m === 'object' ? String(m.status || 'none') : 'none');

/**
 * Was this field kept? `resolved.applied` may be an array of field keys or a
 * map of key → truthy/falsy. Returns true / false / null (unknown).
 */
export function keptState(resolved, key) {
  const applied = resolved?.applied;
  if (Array.isArray(applied)) return applied.map(String).includes(key);
  if (applied && typeof applied === 'object') {
    if (!(key in applied)) return null;
    return Boolean(applied[key]);
  }
  return null;
}

/** The proposal rows a run's `result` boils down to. */
export function proposalRows(result) {
  const r = result || {};
  const conf = r.confidence || {};
  const rq = r.requesterMatch;
  const as = r.assigneeMatch;
  const rqStatus = statusOf(rq);
  const asStatus = statusOf(as);
  const rows = [
    { key: 'subject', label: 'Subject', value: r.subject || null, confidence: conf.subject },
    { key: 'description', label: 'Request', value: r.description?.request || r.descriptionText || (typeof r.description === 'string' ? r.description : null), confidence: conf.description },
    {
      key: 'requester',
      label: 'Requester',
      value: rqStatus === 'matched' && rq.candidate
        ? `${rq.candidate.name || rq.candidate.email}${rq.candidate.name && rq.candidate.email ? ` · ${rq.candidate.email}` : ''}`
        : (r.requesterNameOrEmail || null),
      note: rqStatus === 'matched'
        ? `matched from ${rq.candidate?.source === 'directory' ? 'the directory' : 'known requesters'}`
        : rqStatus === 'ambiguous'
          ? `${Array.isArray(rq.candidates) ? rq.candidates.length : 'several'} people matched — left for the agent`
          : (r.requesterNameOrEmail ? 'no match — left for the agent' : null),
      confidence: conf.requester,
    },
    {
      key: 'assignee',
      label: 'Assignee',
      value: asStatus === 'matched' && as.technician ? as.technician.name : (r.assigneeHint?.name || null),
      note: asStatus === 'matched'
        ? (r.assigneeHint?.reason ? `from: “${r.assigneeHint.reason}”` : 'matched a workspace member')
        : asStatus === 'ambiguous'
          ? 'more than one member fits — left for the agent'
          : (r.assigneeHint?.name ? 'no workspace member matched' : 'not named in the material'),
      confidence: conf.assignee,
    },
    {
      key: 'category',
      label: 'Category',
      value: r.categoryHint || null,
      note: r.categoryLevel === 'top' ? 'category only — subcategory left for the agent' : (r.categoryLevel === 'leaf' ? 'with subcategory' : null),
      confidence: conf.category,
    },
    { key: 'priority', label: 'Priority', value: r.priorityHint != null ? (PRIORITY_LABELS[Number(r.priorityHint)] ? `${PRIORITY_LABELS[Number(r.priorityHint)]} (P${r.priorityHint})` : String(r.priorityHint)) : null, confidence: conf.priority },
    { key: 'type', label: 'Type', value: r.typeHint || null, confidence: conf.type },
  ];
  return rows;
}

function RunBlock({ run, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const result = run.result && typeof run.result === 'object' ? run.result : {};
  const rows = proposalRows(result);
  const hasKept = rows.some((row) => keptState(run.resolved, row.key) !== null);
  const tokens = [fmtTokens(run.inputTokens), fmtTokens(run.outputTokens)];
  const stats = [
    formatDayTime(run.createdAt),
    run.actorName ? `by ${run.actorName}` : null,
    run.model || run.provider || null,
    fmtDuration(run.durationMs),
    tokens[0] || tokens[1] ? `${tokens[0] || '0'} in / ${tokens[1] || '0'} out tokens` : null,
  ].filter(Boolean);
  const panelId = `autofill-run-${run.id}-proposal`;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20" data-testid="autofill-run">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/85">Run #{run.id}</span>
          {stats.length > 0 && <span> · {stats.join(' · ')}</span>}
          {run.requestSummary && <span className="block text-[11px] text-muted-foreground/75 truncate">{run.requestSummary}</span>}
        </p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="tp-focus-ring inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-[11px] font-semibold text-foreground/85 hover:bg-muted/50"
        >
          {open ? 'Hide proposal' : 'Show proposal'}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div id={panelId} className="border-t border-border/60 px-3 py-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground/75">
                <th scope="col" className="text-left font-semibold py-1 pr-2 w-24">Field</th>
                <th scope="col" className="text-left font-semibold py-1 pr-2">Proposed</th>
                <th scope="col" className="text-left font-semibold py-1 pr-2 w-16">Conf.</th>
                {hasKept && <th scope="col" className="text-left font-semibold py-1 w-14">Kept</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((row) => {
                const kept = keptState(run.resolved, row.key);
                const tier = row.value != null ? confidenceTier(row.confidence) : null;
                return (
                  <tr key={row.key} className="align-top" data-testid={`autofill-run-row-${row.key}`}>
                    <th scope="row" className="text-left font-semibold text-foreground/85 py-1.5 pr-2">{row.label}</th>
                    <td className="py-1.5 pr-2 text-foreground break-words">
                      {row.value != null && String(row.value).trim() !== ''
                        ? <span className="line-clamp-3">{String(row.value)}</span>
                        : <span className="italic text-muted-foreground/75">—</span>}
                      {row.note && <span className="block text-[11px] text-muted-foreground/75">{row.note}</span>}
                    </td>
                    <td className="py-1.5 pr-2">
                      {tier && (
                        <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${TIER_CHIP[tier]}`}>{tier}</span>
                      )}
                    </td>
                    {hasKept && (
                      <td className="py-1.5">
                        {kept === true && <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-300 font-semibold"><Check className="w-3.5 h-3.5" aria-hidden="true" /> kept</span>}
                        {kept === false && <span className="inline-flex items-center gap-0.5 text-muted-foreground"><Minus className="w-3.5 h-3.5" aria-hidden="true" /> no</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {result.sourceSummary && (
            <p className="mt-2 text-[11px] text-muted-foreground/75">Material read: {result.sourceSummary}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function AutofillRunCard({ ticketId, showAdminLink = false }) {
  const [runs, setRuns] = useState(null);

  useEffect(() => {
    if (!ticketId) return undefined;
    let alive = true;
    ticketsAPI.intakeRuns(ticketId)
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
        setRuns(list);
      })
      .catch(() => { if (alive) setRuns([]); });
    return () => { alive = false; };
  }, [ticketId]);

  if (!runs || runs.length === 0) return null;

  return (
    <section className="tp-card rounded-xl p-4 mb-4" aria-label="Autofill run" data-testid="autofill-run-card">
      <div className="flex flex-wrap items-center gap-2 mb-2.5">
        <Sparkles className="w-4 h-4 text-indigo-500" aria-hidden="true" />
        <h2 className="text-sm font-bold text-foreground">Autofill run</h2>
        {runs.length > 1 && <span className="text-xs text-muted-foreground/75">({runs.length})</span>}
        <p className="basis-full sm:basis-auto sm:ml-auto text-[11px] text-muted-foreground/75">
          This ticket was drafted from a paste — what the model proposed vs what was kept.
          {showAdminLink && <> <Link to="/settings#ai-usage" className="tp-focus-ring rounded underline-offset-2 hover:underline text-indigo-600 dark:text-indigo-300">All runs</Link></>}
        </p>
      </div>
      <div className="space-y-2">
        {runs.map((run, i) => <RunBlock key={run.id ?? i} run={run} />)}
      </div>
    </section>
  );
}
