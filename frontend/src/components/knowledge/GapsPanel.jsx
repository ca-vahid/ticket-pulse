import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity, ChevronRight, FileText, Lightbulb, ListPlus, RefreshCw, SearchX, Sparkles,
} from 'lucide-react';
import { knowledgeGrowthAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { timeAgo } from '../tickets/ticketUi';
import { EmptyState, Loading } from './knowledgeUi';
import { IconTile, StatusBadge, TabActions } from './builderUi';
import { agoWords } from './knowledgeFormat';
import DraftFromTicketsDialog from './DraftFromTicketsDialog';
import { reasonLine } from './knowledgeGrowthFormat';

/**
 * Knowledge → Gaps (Auto-help P1): the questions that keep arriving that
 * Knowledge cannot answer, per playbook. Each group is a set of tickets
 * that ask the same thing (grouped by meaning), with its typical ticket as
 * the title, a few distinguishing words, how many, when last seen and a few
 * example tickets (subject only). "Draft an article" writes a draft from the
 * group's RESOLVED tickets (verified solutions + public replies, never
 * internal notes, names removed) and opens it for a person to check.
 */
const WINDOWS = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 180 days' },
];

function ClusterRow({ cluster, playbookId, canManage, busyKey, onDraft }) {
  const [open, setOpen] = useState(false);
  const examples = open ? cluster.examples : cluster.examples.slice(0, 3);
  const busy = busyKey === cluster.key;
  const canDraft = canManage && cluster.resolvedCount > 0;
  return (
    <li className="px-4 py-3.5" data-testid="gap-cluster">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{cluster.title}</p>
            <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="gap-count">
              {cluster.count} ticket{cluster.count === 1 ? '' : 's'}
            </span>
          </div>
          {cluster.keywords?.length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">{cluster.keywords.join(' · ')}</p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground/75">
            {[
              cluster.lastSeenAt ? `Last seen ${agoWords(cluster.lastSeenAt)}` : null,
              cluster.resolvedCount ? `${cluster.resolvedCount} resolved` : 'none resolved yet',
              reasonLine(cluster.reasons),
            ].filter(Boolean).join(' · ')}
          </p>
          <ul className="mt-2 space-y-0.5" aria-label="Example tickets">
            {examples.map((t) => (
              <li key={t.id} className="flex min-w-0 items-baseline gap-2 text-xs">
                <span className="w-16 flex-shrink-0 tabular-nums text-muted-foreground/75">{t.ref}</span>
                <Link to={`/tickets/${t.id}`} className="tp-focus-ring min-w-0 truncate rounded text-foreground/85 hover:text-primary hover:underline">
                  {t.subject}
                </Link>
              </li>
            ))}
          </ul>
          {cluster.examples.length > 3 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="tp-focus-ring mt-1 inline-flex items-center gap-1 rounded text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
              {open ? 'Fewer examples' : `${cluster.examples.length - 3} more example${cluster.examples.length - 3 === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
        <div className="flex flex-shrink-0 flex-col gap-1 sm:w-48 sm:items-end">
          {cluster.article ? (
            <Link
              to={`/knowledge/articles/${cluster.article.id}`}
              className="tp-focus-ring inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium text-primary hover:bg-muted sm:justify-end"
              data-testid="gap-open-draft"
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              {cluster.article.status === 'draft' ? 'Open the draft' : 'Open the article'}
            </Link>
          ) : canManage ? (
            <button
              type="button"
              onClick={() => onDraft(cluster, playbookId)}
              disabled={!canDraft || Boolean(busyKey)}
              title={cluster.resolvedCount ? undefined : 'None of these tickets is resolved yet — there is nothing to learn from'}
              className="tp-focus-ring inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50"
              data-testid="gap-draft"
            >
              {busy ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />}
              {busy ? 'Drafting…' : 'Draft an article'}
            </button>
          ) : null}
          {busy && <p className="text-[11px] text-muted-foreground sm:text-right" role="status">Reading {Math.min(cluster.resolvedCount, 12)} solved ticket{cluster.resolvedCount === 1 ? '' : 's'}…</p>}
          {cluster.article && <p className="truncate text-[11px] text-muted-foreground/75 sm:max-w-48 sm:text-right" title={cluster.article.title}>{cluster.article.title}</p>}
        </div>
      </div>
    </li>
  );
}

function PlaybookGaps({ group, canManage, busyKey, onDraft }) {
  const [showOneOffs, setShowOneOffs] = useState(false);
  const repeated = group.clusters.filter((c) => c.count > 1);
  const oneOffs = group.clusters.filter((c) => c.count <= 1);
  return (
    <section aria-label={`Gaps for ${group.playbookName}`} className="tp-card overflow-hidden" data-testid="gap-playbook">
      <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3.5">
        <IconTile icon={Lightbulb} size="sm" tone="amber" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-foreground">
            <Link to={`/knowledge/playbooks/${group.playbookId}`} className="tp-focus-ring rounded hover:underline">{group.playbookName}</Link>
          </h3>
          <p className="text-xs text-muted-foreground">
            {`${group.tickets} ticket${group.tickets === 1 ? '' : 's'} · ${repeated.length} repeated question${repeated.length === 1 ? '' : 's'}${oneOffs.length ? ` · ${oneOffs.length} one-off` : ''}`}
          </p>
        </div>
        {!group.enabled && <StatusBadge tone="muted">Playbook off</StatusBadge>}
      </div>
      {repeated.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {repeated.map((c) => <ClusterRow key={c.key} cluster={c} playbookId={group.playbookId} canManage={canManage} busyKey={busyKey} onDraft={onDraft} />)}
        </ul>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">No question came up twice. The one-offs are below.</p>
      )}
      {oneOffs.length > 0 && (
        <div className="border-t border-border/60 px-3 py-2">
          <button
            type="button"
            onClick={() => setShowOneOffs((v) => !v)}
            aria-expanded={showOneOffs}
            className="tp-focus-ring inline-flex items-center gap-1 rounded px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showOneOffs ? 'rotate-90' : ''}`} aria-hidden="true" />
            {oneOffs.length} one-off question{oneOffs.length === 1 ? '' : 's'}
          </button>
          {showOneOffs && (
            <ul className="mt-2 divide-y divide-border/60 rounded-lg border border-border/70 animate-fadeIn">
              {oneOffs.map((c) => <ClusterRow key={c.key} cluster={c} playbookId={group.playbookId} canManage={canManage} busyKey={busyKey} onDraft={onDraft} />)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export default function GapsPanel({ canManage = false, canRefresh = canManage }) {
  const navigate = useNavigate();
  const [days, setDays] = useState('90');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const [draftError, setDraftError] = useState(null);
  const [pickOpen, setPickOpen] = useState(false);

  const load = useCallback(async ({ refresh = false } = {}) => {
    setRefreshing(refresh);
    setError(null);
    try {
      const res = await knowledgeGrowthAPI.gaps({ days, ...(refresh ? { refresh: 1 } : {}) });
      setData(res?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not load the gaps');
    } finally {
      setRefreshing(false);
    }
  }, [days]);

  useEffect(() => { setData(null); load(); }, [load]);

  const draft = async (cluster, playbookId) => {
    setBusyKey(cluster.key);
    setDraftError(null);
    try {
      const res = await knowledgeGrowthAPI.draftFromTickets({
        ticketIds: cluster.ticketIds, playbookId, topic: cluster.title, kind: 'gap',
      });
      const id = res?.data?.article?.id;
      if (id) navigate(`/knowledge/articles/${id}`, { state: { afterDraft: { used: res?.data?.used || null } } });
    } catch (err) {
      setDraftError(err?.message || 'The draft could not be written');
    } finally {
      setBusyKey(null);
    }
  };

  const groups = data?.playbooks || [];
  return (
    <div className="space-y-5" data-testid="gaps-panel">
      {canManage && (
        <TabActions>
          <button
            type="button"
            onClick={() => setPickOpen(true)}
            className="tp-focus-ring inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground/85 hover:bg-muted"
          >
            <ListPlus className="h-4 w-4 text-primary" aria-hidden="true" /> Draft from tickets…
          </button>
        </TabActions>
      )}
      <div className="tp-card flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:p-4">
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
          Questions Auto-help could not answer from Knowledge, and tickets in a playbook&rsquo;s area it did not pick up — grouped by what they ask.
        </p>
        <div className="flex items-center gap-2">
          <div className="w-40"><FancySelect value={days} onChange={setDays} options={WINDOWS} aria-label="Time window" /></div>
          {canRefresh && (
            <button
              type="button"
              onClick={() => load({ refresh: true })}
              disabled={refreshing || !data}
              aria-label="Recalculate the gaps"
              title="Recalculate"
              className="tp-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {draftError && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{draftError}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      {!data && !error ? <Loading label="Finding the gaps…" /> : data && groups.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={SearchX} title="No gaps found">
            Nothing Auto-help tried to answer in this window ended for lack of knowledge. Gaps show up here once playbooks run on new tickets (or on a backtest).
          </EmptyState>
        </div>
      ) : data && (
        <>
          {groups.map((g) => <PlaybookGaps key={g.playbookId} group={g} canManage={canManage} busyKey={busyKey} onDraft={draft} />)}
          <p className="px-1 text-[11px] text-muted-foreground/75">
            {data.totals?.tickets || 0} tickets, grouped {data.mode === 'dense' ? 'by meaning' : 'by shared words'}
            {data.generatedAt ? ` · worked out ${timeAgo(data.generatedAt)}` : ''}.
            {' '}Drafts read resolved tickets only: verified solutions and public replies — never internal notes — with names, e-mail addresses and phone numbers removed.
          </p>
        </>
      )}
      <DraftFromTicketsDialog open={pickOpen} onClose={() => setPickOpen(false)} />
    </div>
  );
}
