import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { urgentResponseAPI } from '../../../services/api';
import FancySelect from '../../common/FancySelect';
import { ConfirmDialog } from '../../knowledge/knowledgeUi';
import { SectionTitle, StatusDot } from '../../onboarding/onboardingUi';
import { StatusBanner } from '../SettingsLayoutPrimitives';
import { CARD_CLASS, TextButton } from './urgentResponseUi';
import { LAYER_LABEL, STAT_GROUPS, fmtWhen } from './urgentResponseFormat';

/**
 * Log: what the rules did (Live) and what they would have done (Shadow), with
 * the sentence the server wrote for each. The 30-day counts keep the two
 * apart. A live move can be undone from its row.
 */

const PAGE = 50;
const LAYER_OPTIONS = [{ value: '', label: 'Every step' }, ...Object.entries(LAYER_LABEL).map(([value, label]) => ({ value, label }))];
const KIND_OPTIONS = [
  { value: '', label: 'Live and shadow' },
  { value: 'false', label: 'Live only' },
  { value: 'true', label: 'Shadow only' },
];

export default function LogTab({ timezone = null }) {
  const [stats, setStats] = useState(null);
  const [layer, setLayer] = useState('');
  const [shadow, setShadow] = useState('');
  const [items, setItems] = useState(null);
  const [nextBefore, setNextBefore] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [undo, setUndo] = useState(null);
  const [status, setStatus] = useState(null);

  const loadStats = useCallback(() => {
    urgentResponseAPI.getStats(30).then((res) => setStats(res?.data || null)).catch(() => setStats(null));
  }, []);

  const params = useCallback((before) => ({
    limit: PAGE,
    ...(before ? { before } : {}),
    ...(layer ? { layer } : {}),
    ...(shadow ? { shadow } : {}),
  }), [layer, shadow]);

  const loadFirst = useCallback(() => {
    let alive = true;
    setError(null);
    urgentResponseAPI.getActions(params(null))
      .then((res) => { if (alive) { setItems(res?.data?.items || []); setNextBefore(res?.data?.nextBefore ?? null); } })
      .catch((err) => { if (alive) { setItems([]); setError(err?.message || 'Could not load the log'); } });
    return () => { alive = false; };
  }, [params]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => loadFirst(), [loadFirst]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await urgentResponseAPI.getActions(params(nextBefore));
      setItems((prev) => [...(prev || []), ...(res?.data?.items || [])]);
      setNextBefore(res?.data?.nextBefore ?? null);
    } catch (err) {
      setError(err?.message || 'Could not load more');
    } finally {
      setLoadingMore(false);
    }
  };

  const runUndo = async () => {
    const row = undo;
    setUndo(null);
    setStatus(null);
    try {
      await urgentResponseAPI.undoAction(row.id);
      setStatus({ ok: true, text: `${row.ticket?.displayRef || 'The ticket'} is back with ${row.from?.name || 'its previous owner'}.` });
      loadFirst();
      loadStats();
    } catch (err) {
      // 409: the ticket has moved on since; the server says why in plain words.
      setStatus({ ok: false, text: err?.message || 'Could not undo' });
    }
  };

  return (
    <div className="space-y-5">
      <section className={CARD_CLASS} aria-label="Last 30 days">
        <SectionTitle hint="Live is what happened. Shadow is what would have happened; nothing moved and nobody was told.">Last {stats?.days || 30} days</SectionTitle>
        {!stats ? <p className="text-sm text-muted-foreground">No numbers yet.</p> : (
          <table className="w-full max-w-xl text-left text-sm" data-testid="urgent-stats">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium"><span className="sr-only">What</span></th>
                <th scope="col" className="w-20 py-1 pr-3 text-right font-medium"><StatusDot tone="green" label="Live" /></th>
                <th scope="col" className="w-24 py-1 text-right font-medium"><StatusDot tone="amber" label="Shadow" /></th>
              </tr>
            </thead>
            {STAT_GROUPS.map((group) => (
              <tbody key={group.layer} className="divide-y divide-border" data-testid={`urgent-stats-${group.layer}`}>
                <tr>
                  <th scope="rowgroup" colSpan={3} className="pb-1 pt-3 text-xs font-semibold text-foreground">{group.label}</th>
                </tr>
                {group.rows.map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row" className="py-1.5 pl-3 pr-3 font-normal text-foreground/85">{label}</th>
                    <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">{stats.live?.[key] ?? 0}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{stats.shadow?.[key] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </section>

      <section className={CARD_CLASS} aria-label="Log">
        <SectionTitle
          action={(
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-52"><FancySelect value={layer} onChange={setLayer} options={LAYER_OPTIONS} aria-label="Filter by step" /></div>
              <div className="w-40"><FancySelect value={shadow} onChange={setShadow} options={KIND_OPTIONS} aria-label="Filter by live or shadow" /></div>
            </div>
          )}
        >
          Log
        </SectionTitle>
        {status && <p role="status" className={`mb-2 text-sm ${status.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>{status.text}</p>}
        {error && <StatusBanner type="error" className="mb-2">{error}</StatusBanner>}
        {items === null ? <p className="text-sm text-muted-foreground">Loading…</p> : !items.length ? (
          <p className="text-sm text-muted-foreground">{layer || shadow ? 'Nothing matches these filters.' : 'Nothing yet. Rows appear here as soon as a rule acts, in Shadow or Live.'}</p>
        ) : (
          <ol className="divide-y divide-border" data-testid="urgent-log">
            {items.map((row) => (
              <li key={row.id} className="grid gap-x-3 gap-y-0.5 py-2.5 text-sm sm:grid-cols-[8.5rem_6.5rem_minmax(0,1fr)_auto]" data-testid="urgent-log-row">
                <span className="text-xs text-muted-foreground">{fmtWhen(row.createdAt, timezone)}</span>
                <span className="min-w-0 truncate">
                  {row.ticket
                    ? <Link to={`/tickets/${row.ticket.id}`} title={row.ticket.subject || undefined} className="tp-focus-ring rounded font-medium text-primary hover:underline">{row.ticket.displayRef}</Link>
                    : <span className="text-muted-foreground">{LAYER_LABEL[row.layer] || '—'}</span>}
                </span>
                <span className="min-w-0 text-foreground/85">
                  {row.shadow && <StatusDot tone="amber" label="Shadow" className="mr-2 align-baseline" />}
                  {row.sentence}
                  {row.undoneAt && (
                    <span className="block text-xs text-muted-foreground">Undone by {row.undoneBy || 'someone'} at {fmtWhen(row.undoneAt, timezone)}</span>
                  )}
                </span>
                <span className="sm:text-right">
                  {row.undoable && !row.undoneAt && (
                    <TextButton onClick={() => setUndo(row)} aria-label={`Undo: ${row.ticket?.displayRef || 'this move'}`}>Undo</TextButton>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
        {nextBefore != null && items?.length > 0 && (
          <div className="mt-3">
            <TextButton onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</TextButton>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(undo)}
        title={undo ? `Move ${undo.ticket?.displayRef || 'this ticket'} back to ${undo.from?.name || 'its previous owner'}?` : ''}
        confirmLabel={undo?.from?.name ? `Move back to ${undo.from.name.split(' ')[0]}` : 'Move back'}
        onConfirm={runUndo}
        onCancel={() => setUndo(null)}
        testId="urgent-undo-confirm"
      >
        {undo && `It leaves ${undo.to?.name || 'its current owner'} and its clock stops. The undo is written to the Log and to the ticket.`}
      </ConfirmDialog>
    </div>
  );
}
