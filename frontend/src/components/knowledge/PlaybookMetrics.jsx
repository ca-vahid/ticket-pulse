import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, CircleSlash, Lock } from 'lucide-react';
import { OUTCOME_WORD, csatWords, nPct, usd } from './autoHelpWords';

/**
 * Knowledge → Activity → By playbook (compact, 29 Sep 2026; was seven tiles
 * per playbook). One row per playbook — always with N, per playbook, never
 * per person. A row opens the rest: what agents did with suggestions, how
 * sent answers ended, CSAT where Auto-help closed it, and the auto-mode
 * readiness lines.
 */
const MODE_LABEL = { shadow: 'Shadow', approve: 'Approve', auto: 'Auto' };
const OUTCOME_ORDER = ['resolved_silence', 'resolved_confirmed', 'help_requested', 'reopened', 'agent_took_over', 'no_reply_left_open', 'loop_stopped'];

function criterionValue(c) {
  if (c.key === 'not_sensitive') return c.met ? 'not sensitive' : 'marked sensitive';
  if (c.value === null || c.value === undefined) return 'no data yet';
  const pctKeys = ['good', 'unchanged', 'reopen'];
  const v = pctKeys.includes(c.key) ? `${c.value} %` : `${c.value}`;
  return c.n !== null && c.n !== undefined && pctKeys.includes(c.key) ? `${v} (N=${c.n})` : v;
}

export function ReadinessList({ readiness, autoModeAllowed = false }) {
  if (!readiness?.criteria?.length) return null;
  return (
    <div className="space-y-1.5" data-testid="readiness-list">
      <ul className="space-y-1">
        {readiness.criteria.map((c) => (
          <li key={c.key} className="flex items-start gap-2 text-xs">
            {c.met
              ? <Check className="mt-px h-3.5 w-3.5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              : <CircleSlash className="mt-px h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/75" aria-hidden="true" />}
            <span className="min-w-0 flex-1 text-foreground/85">{c.label}</span>
            <span className={`whitespace-nowrap tabular-nums ${c.met ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>
              <span className="sr-only">{c.met ? 'met' : 'not met'}: </span>{criterionValue(c)}
            </span>
          </li>
        ))}
      </ul>
      {!autoModeAllowed && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden="true" />
          Auto sending is switched off in this build — even a playbook that meets every line stays in approve mode.
        </p>
      )}
    </div>
  );
}

/** A labelled line inside an opened row. */
function DetailLine({ label, children, testid }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs sm:flex-row sm:gap-3" data-testid={testid}>
      <span className="w-40 flex-shrink-0 font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground/85">{children}</span>
    </div>
  );
}

function PlaybookDetails({ p, autoModeAllowed }) {
  const outcomes = OUTCOME_ORDER.filter((k) => p.outcomes?.[k]?.n);
  const a = p.approve || {};
  return (
    <div className="space-y-2 animate-fadeIn">
      <DetailLine label="Approve-mode bar" testid="stat-review">
        ≥{p.bar?.minReviewed ?? 30} reviewed and ≥{p.bar?.minGoodPct ?? 85} % good — {p.readyForApprove ? 'met' : `not met yet (${p.reviewed} reviewed${p.reviewed ? `, ${p.goodPct} % good` : ''})`}
        {p.wrong ? ` · wrong ${p.wrong}` : ''}
      </DetailLine>
      <DetailLine label="Agents with suggestions" testid="stat-decisions">
        {a.decided ? (
          <>
            Unchanged {nPct(a.unchanged)} · edited {nPct(a.edited)}
            {a.edited?.medianEditDistance !== null && a.edited?.medianEditDistance !== undefined && a.edited?.n ? ` (median change ${Math.round(a.edited.medianEditDistance * 100)} %)` : ''}
            {' '}· dismissed {nPct(a.dismissed)} <span className="text-muted-foreground">(N={a.decided})</span>
          </>
        ) : <span className="text-muted-foreground">{p.staged ? `${p.staged} suggested, none decided yet` : 'None — shadow mode never suggests'}</span>}
      </DetailLine>
      <DetailLine label={`Sent answers${p.sent ? ` (N=${p.sent})` : ''}`} testid="stat-outcomes">
        {p.sent ? (
          <>
            {outcomes.map((k, i) => <span key={k}>{i ? ' · ' : ''}{OUTCOME_WORD[k]} {nPct(p.outcomes[k])}</span>)}
            {p.waiting ? <span>{outcomes.length ? ' · ' : ''}still waiting {p.waiting}</span> : null}
          </>
        ) : <span className="text-muted-foreground">Nothing sent</span>}
      </DetailLine>
      <DetailLine label="Model cost" testid="stat-cost-detail">
        {p.cost?.runsWithCost
          ? <>{usd(p.cost.perRunUsd)} per run <span className="text-muted-foreground">(N={p.cost.runsWithCost})</span> · {usd(p.cost.monthUsd)} this month</>
          : <span className="text-muted-foreground">Not measured yet</span>}
      </DetailLine>
      <DetailLine label="CSAT where it closed" testid="stat-csat">
        <span className={p.csat?.n ? '' : 'text-muted-foreground'}>{csatWords(p.csat)}</span>
      </DetailLine>
      <DetailLine label="Ready for auto mode" testid="stat-readiness">
        <ReadinessList readiness={p.readiness} autoModeAllowed={autoModeAllowed} />
      </DetailLine>
    </div>
  );
}

function PlaybookRow({ p, autoModeAllowed }) {
  const [open, setOpen] = useState(false);
  const name = p.playbookName || `Removed playbook #${p.playbookId}`;
  const drafted = p.drafted ?? Math.round(((p.draftedPct ?? 0) / 100) * p.runs);
  const cell = 'px-2 py-2.5 align-middle tabular-nums';
  return (
    <Fragment>
      <tr className="border-t border-border/60" data-testid="playbook-metrics">
        <td className="py-2.5 pl-3 pr-2 align-middle">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} details for ${name}`}
            className="tp-focus-ring rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
        </td>
        <td className="min-w-[10rem] py-2.5 pr-2 align-middle">
          {p.playbookName
            ? <Link to={`/knowledge/playbooks/${p.playbookId}`} className="tp-focus-ring rounded text-sm font-medium text-foreground hover:underline">{name}</Link>
            : <span className="text-sm text-muted-foreground">{name}</span>}
          <span className="block text-[11px] text-muted-foreground">{MODE_LABEL[p.mode] || 'Shadow'}{p.sensitive ? ' · sensitive' : ''}</span>
        </td>
        <td className={cell}>{p.runs}</td>
        <td className={cell}>{drafted} <span className="text-muted-foreground">of {p.runs}</span></td>
        <td className={cell} data-testid="stat-stayed-quiet">{p.stayedQuiet || 0} <span className="text-muted-foreground">of {p.runs}</span></td>
        <td className={cell}>
          {p.reviewed ? <>{p.reviewed} <span className="text-muted-foreground">· {p.goodPct} % good</span></> : <span className="text-muted-foreground">0</span>}
        </td>
        <td className={`${cell} whitespace-nowrap`} data-testid="stat-cost">
          {p.cost?.runsWithCost ? <>{usd(p.cost.perRunUsd)} <span className="text-muted-foreground">(N={p.cost.runsWithCost})</span></> : <span className="text-muted-foreground">—</span>}
        </td>
        <td className={`${cell} whitespace-nowrap pr-4 text-xs ${p.readyForApprove ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>
          {p.readyForApprove ? 'Ready' : `${p.reviewed} of ${p.bar?.minReviewed ?? 30} reviews`}
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/30">
          <td />
          <td colSpan={7} className="py-3 pr-4"><PlaybookDetails p={p} autoModeAllowed={autoModeAllowed} /></td>
        </tr>
      )}
    </Fragment>
  );
}

export default function PlaybookMetrics({ items, autoModeAllowed = false }) {
  if (!items?.length) return null;
  const th = 'px-2 py-2 font-medium';
  return (
    <section aria-label="Auto-help by playbook" data-testid="runs-summary" className="tp-card overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="w-8 py-2 pl-3"><span className="sr-only">Details</span></th>
            <th scope="col" className="py-2 pr-2 font-medium">Playbook</th>
            <th scope="col" className={th}>Runs</th>
            <th scope="col" className={th} title="Runs where Auto-help wrote an answer (shadow: recorded, never sent)">Drafted</th>
            <th scope="col" className={th} title="Runs where a “stay quiet when” rule applied">Stayed quiet</th>
            <th scope="col" className={th}>Reviewed</th>
            <th scope="col" className={th}>Cost / run</th>
            <th scope="col" className={`${th} pr-4`} title="Approve mode needs enough reviewed drafts, most of them good">Approve mode</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => <PlaybookRow key={p.playbookId} p={p} autoModeAllowed={autoModeAllowed} />)}
        </tbody>
      </table>
    </section>
  );
}
