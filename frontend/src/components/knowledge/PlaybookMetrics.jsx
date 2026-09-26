import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BookMarked, Check, ChevronDown, CircleSlash, Lock } from 'lucide-react';
import { IconTile, StatusBadge } from './builderUi';
import { OUTCOME_WORD, csatWords, nPct, usd } from './autoHelpWords';

/**
 * Per-playbook Auto-help numbers (plans/AUTO_HELP_P1_PLAN.md §3) — always
 * with N, per playbook, never per person. Shadow review, what agents did
 * with suggestions, how sent answers ended, CSAT on the tickets Auto-help
 * closed, cost, and the auto-mode readiness gate criterion by criterion.
 */
const MODE_LABEL = { shadow: 'Shadow', approve: 'Approve', auto: 'Auto' };
const OUTCOME_ORDER = ['resolved_silence', 'resolved_confirmed', 'help_requested', 'reopened', 'agent_took_over', 'no_reply_left_open', 'loop_stopped'];

/** One metric tile: a small label over plain words (always with N). */
function Stat({ label, children, testid }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/45 px-3 py-2.5" data-testid={testid}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 text-xs leading-relaxed text-foreground/85">{children}</div>
    </div>
  );
}

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

function PlaybookBlock({ p, autoModeAllowed }) {
  const [open, setOpen] = useState(false);
  const met = (p.readiness?.criteria || []).filter((c) => c.met).length;
  const total = (p.readiness?.criteria || []).length;
  const outcomes = OUTCOME_ORDER.filter((k) => p.outcomes?.[k]?.n);
  const a = p.approve || {};
  return (
    <article className="tp-card p-4" data-testid="playbook-metrics">
      <div className="flex items-center gap-3">
        <IconTile icon={BookMarked} size="sm" />
        <div className="min-w-0 flex-1">
          <Link to={`/knowledge/playbooks/${p.playbookId}`} className="tp-focus-ring block truncate rounded text-[15px] font-semibold text-foreground hover:underline">
            {p.playbookName || `Playbook #${p.playbookId}`}
          </Link>
          <span className="text-xs text-muted-foreground">{MODE_LABEL[p.mode] || 'Shadow'} mode{p.sensitive ? ' · sensitive (approve-only)' : ''}</span>
        </div>
        <StatusBadge tone={p.readyForApprove ? 'success' : 'muted'}>{p.readyForApprove ? 'Approve bar met' : `${p.runs} run${p.runs === 1 ? '' : 's'}`}</StatusBadge>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Stat label="Shadow drafts and reviews" testid="stat-review">
          <span className="tabular-nums">
            {p.runs} run{p.runs === 1 ? '' : 's'} · drafted {p.draftedPct ?? 0} % (N={p.runs}) · {p.reviewed} reviewed
            {p.reviewed ? ` · good ${p.goodPct} % (N=${p.reviewed})` : ''} · wrong {p.wrong}
          </span>
          <span className={`block ${p.readyForApprove ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>
            Approve-mode bar (≥{p.bar?.minReviewed ?? 30} reviewed, ≥{p.bar?.minGoodPct ?? 85} % good): {p.readyForApprove ? 'met' : 'not met yet'}
          </span>
        </Stat>

        <Stat label="Agents with suggestions" testid="stat-decisions">
          {a.decided ? (
            <>
              Unchanged {nPct(a.unchanged)} · edited {nPct(a.edited)}
              {a.edited?.medianEditDistance !== null && a.edited?.medianEditDistance !== undefined && a.edited?.n ? ` (median change ${Math.round(a.edited.medianEditDistance * 100)} %)` : ''}
              {' '}· dismissed {nPct(a.dismissed)} <span className="text-muted-foreground">(N={a.decided})</span>
            </>
          ) : <span className="text-muted-foreground">{p.staged ? `${p.staged} suggested, none decided yet` : 'No suggestions yet'}</span>}
        </Stat>

        <Stat label={`Sent answers${p.sent ? ` (N=${p.sent})` : ''}`} testid="stat-outcomes">
          {p.sent ? (
            <>
              {outcomes.map((k, i) => (
                <span key={k}>{i ? ' · ' : ''}{OUTCOME_WORD[k]} {nPct(p.outcomes[k])}</span>
              ))}
              {p.waiting ? <span>{outcomes.length ? ' · ' : ''}still waiting {p.waiting}</span> : null}
            </>
          ) : <span className="text-muted-foreground">Nothing sent yet</span>}
        </Stat>

        <Stat label="Stayed quiet" testid="stat-stayed-quiet">
          {p.stayedQuiet ? (
            <span className="tabular-nums">{p.stayedQuiet} run{p.stayedQuiet === 1 ? '' : 's'} hit a stay-quiet rule <span className="text-muted-foreground">(N={p.runs})</span></span>
          ) : <span className="text-muted-foreground">No run hit a stay-quiet rule</span>}
        </Stat>

        <Stat label="CSAT where Auto-help closed it" testid="stat-csat">
          <span className={p.csat?.n ? '' : 'text-muted-foreground'}>{csatWords(p.csat)}</span>
        </Stat>

        <Stat label="Model cost" testid="stat-cost">
          {p.cost?.runsWithCost ? (
            <>{usd(p.cost.perRunUsd)} per run <span className="text-muted-foreground">(N={p.cost.runsWithCost})</span> · {usd(p.cost.monthUsd)} this month</>
          ) : <span className="text-muted-foreground">Not measured yet</span>}
        </Stat>

        <Stat label="Ready for auto mode" testid="stat-readiness">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="tp-focus-ring -ml-1 inline-flex items-center gap-1 rounded px-1 text-xs text-foreground/85 hover:text-foreground"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            {p.readiness?.met ? 'Every line met' : `${met} of ${total} lines met`}
          </button>
        </Stat>
      </div>
      {open && (
        <div className="mt-2 rounded-lg bg-muted/40 px-3 py-2.5 animate-fadeIn">
          <ReadinessList readiness={p.readiness} autoModeAllowed={autoModeAllowed} />
        </div>
      )}
    </article>
  );
}

export default function PlaybookMetrics({ items, autoModeAllowed = false }) {
  if (!items?.length) return null;
  return (
    <section aria-label="Auto-help by playbook" data-testid="runs-summary">
      <h2 className="mb-2 px-1 text-[13px] font-semibold text-foreground">By playbook</h2>
      <div className="grid gap-3 2xl:grid-cols-2">
        {items.map((p) => <PlaybookBlock key={p.playbookId} p={p} autoModeAllowed={autoModeAllowed} />)}
      </div>
    </section>
  );
}
