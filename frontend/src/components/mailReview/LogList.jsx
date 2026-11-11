import { Activity } from 'lucide-react';
import { formatPacificWhen } from '../../utils/ticketDates';
import { TicketRefLink } from './WaitingRow';
import {
  ACTION_WORD, CONFIDENCE_WORDS, MODE_WORD, OUTCOME_WORD, agreementSentence, finalSentence, money, suggestionSentence,
} from './mailReviewText';

/**
 * Mail review → Log: every judgement the AI made, newest first. The line on
 * top is the tuning number (how often people kept a "sure" suggestion). A row
 * a person changed shows both answers side by side: those rows are what the
 * prompt is tuned from. Model and cost are for admins.
 */
function Filter({ label, value, onChange, options }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="tp-focus-ring h-8 rounded-lg border border-transparent bg-transparent px-1 text-sm font-medium text-foreground hover:border-input"
      >
        <option value="">Any</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function ActionCell({ row }) {
  return (
    <>
      {row.action === 'attach' && row.ticket
        ? <>Add to <TicketRefLink ticket={row.ticket} />{row.reopen ? ', reopens it' : ''}</>
        : suggestionSentence(row)}
    </>
  );
}

export default function LogList({
  rows, filters = {}, onFilter, stats = null, hasMore = false, loadingMore = false, onLoadMore, isAdmin = false,
}) {
  const agreement = agreementSentence(stats);
  const set = (key) => (value) => onFilter?.({ ...filters, [key]: value });
  return (
    <div data-testid="mr-log">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-3 pb-2 sm:px-4">
        <p className="text-sm text-foreground/85" data-testid="mr-agreement">
          {agreement ? `${agreement} in the last 30 days.` : 'No sure suggestions have been kept or changed in the last 30 days yet.'}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Filter label="Outcome" value={filters.outcome || ''} onChange={set('outcome')} options={Object.entries(OUTCOME_WORD)} />
          <Filter label="Confidence" value={filters.confidence || ''} onChange={set('confidence')} options={CONFIDENCE_WORDS.map((c) => [c, c])} />
          <Filter label="Action" value={filters.action || ''} onChange={set('action')} options={Object.entries(ACTION_WORD)} />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-muted-foreground sm:px-4">No judgements match.</p>
      ) : (
        <table className="w-full table-fixed border-t border-border/60 text-left text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="w-[9.5rem] px-3 py-2 font-medium sm:px-4 max-sm:w-[5.5rem]">When</th>
              <th scope="col" className="px-2 py-2 font-medium">E-mail and what the AI said</th>
              <th scope="col" className="hidden w-[5.5rem] px-2 py-2 font-medium md:table-cell">Confidence</th>
              <th scope="col" className="hidden w-[11rem] px-2 py-2 font-medium md:table-cell">Outcome</th>
              {isAdmin && <th scope="col" className="hidden w-[9rem] px-2 py-2 font-medium lg:table-cell">Model</th>}
              {isAdmin && <th scope="col" className="hidden w-[4.5rem] px-2 py-2 text-right font-medium lg:table-cell sm:pr-4">Cost</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60 border-t border-border/60">
            {rows.map((row) => {
              const changed = row.outcome === 'changed';
              return (
                <tr key={row.id} className="align-top hover:bg-muted/40" data-testid="mr-log-row" data-outcome={row.outcome}>
                  <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground sm:px-4">{formatPacificWhen(row.createdAt)}</td>
                  <td className="px-2 py-2">
                    <p className="truncate font-medium text-foreground" title={row.fromEmail || undefined}>{row.subject || '(no subject)'}</p>
                    {changed ? (
                      <div className="mt-0.5 grid gap-x-6 gap-y-0.5 sm:grid-cols-2" data-testid="mr-log-changed">
                        <p className="min-w-0 text-foreground/85 [overflow-wrap:anywhere]"><span className="text-muted-foreground">AI: </span><ActionCell row={row} /></p>
                        <p className="min-w-0 text-foreground [overflow-wrap:anywhere]">
                          <span className="text-muted-foreground">{row.decidedBy || 'A person'}: </span>
                          {row.finalAction === 'attach' && row.finalTicket
                            ? <>Add to <TicketRefLink ticket={row.finalTicket} /></>
                            : finalSentence(row)}
                        </p>
                      </div>
                    ) : (
                      <p className="mt-0.5 text-foreground/85 [overflow-wrap:anywhere]"><ActionCell row={row} /></p>
                    )}
                    {row.error && <p className="mt-0.5 text-xs text-red-700 dark:text-red-300">{row.error}</p>}
                    <p className="mt-0.5 text-xs text-muted-foreground md:hidden">
                      {[row.confidence, OUTCOME_WORD[row.outcome] || row.outcome].filter(Boolean).join(' · ')}
                    </p>
                  </td>
                  <td className="hidden px-2 py-2 text-foreground/85 md:table-cell">{row.confidence || ''}</td>
                  <td className="hidden px-2 py-2 text-foreground/85 md:table-cell">
                    {OUTCOME_WORD[row.outcome] || row.outcome}
                    {row.mode === 'shadow' && <span className="block text-xs text-muted-foreground">{MODE_WORD.shadow}</span>}
                  </td>
                  {isAdmin && <td className="hidden truncate px-2 py-2 text-xs text-muted-foreground lg:table-cell">{row.model || ''}</td>}
                  {isAdmin && <td className="hidden px-2 py-2 text-right text-xs tabular-nums text-muted-foreground lg:table-cell sm:pr-4">{money(row.costUsd)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {hasMore && (
        <div className="border-t border-border/60 px-3 py-3 text-center sm:px-4">
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50"
            data-testid="mr-log-more"
          >
            {loadingMore && <Activity className="h-4 w-4 animate-spin motion-off:animate-none" aria-hidden="true" />}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
