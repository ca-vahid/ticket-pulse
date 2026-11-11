import { Link } from 'react-router-dom';
import { Activity, ArrowLeft, CheckCheck, Keyboard, X } from 'lucide-react';
import WaitingRow from './WaitingRow';
import DoneList from './DoneList';
import LogList from './LogList';
import { MODE_WORD } from './mailReviewText';

/**
 * The Mail review page without its data fetching (pages/MailReview.jsx owns
 * that): the header line, the text tabs, the three lists, the toast and the
 * keyboard hint. Plain text and icons, no pills, no box per row.
 */
export const TABS = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done' },
  { key: 'log', label: 'Log' },
];

export const SHORTCUTS = [
  ['J / K', 'next / previous e-mail'],
  ['A', 'accept the suggestion'],
  ['N', 'new ticket'],
  ['D', 'no ticket needed'],
  ['Enter', 'details'],
  ['Esc', 'close'],
  ['?', 'show or hide this list'],
];

const EMPTY = {
  waiting: 'Nothing waiting. Held e-mail shows up here when Ticket Pulse can’t tell which ticket it belongs to.',
  done: 'Nothing was dealt with in the last 14 days.',
};

function Loading({ label }) {
  return (
    <div className="flex justify-center py-14">
      <Activity className="h-7 w-7 animate-spin text-primary motion-off:animate-none" aria-label={label} />
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <span className="whitespace-nowrap">
      {label} <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </span>
  );
}

export function ReviewToast({ toast, onUndo, onDismiss }) {
  if (!toast) return null;
  return (
    <div
      className="fixed inset-x-3 bottom-20 z-[55] mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground shadow-soft lg:bottom-6"
      data-testid="mr-toast"
    >
      <span className={`min-w-0 flex-1 ${toast.error ? 'text-red-700 dark:text-red-300' : ''}`}>{toast.text}</span>
      {toast.undoIds?.length > 0 && !toast.error && (
        <button type="button" onClick={() => onUndo?.(toast)} className="tp-focus-ring rounded px-1 font-semibold text-primary hover:underline" data-testid="mr-toast-undo">
          Undo
        </button>
      )}
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export default function MailReviewView({
  workspaceName = '', tab = 'waiting', onTab, meta = {}, isAdmin = false, viewerEmail = '',
  waiting = { rows: null, error: null }, done = { rows: null, error: null }, log = { rows: null, error: null },
  dim = false, focusedId = null, openForm = null, detail = null, detailError = null, rowErrors = {},
  sureRows = [], bulkBusy = false, onBulkAccept,
  onFocusRow, onAccept, onOpenForm, onPick, onCreate, onNoTicket, onDetails,
  doneErrors = {}, undoBusyId = null, onUndoDone,
  logFilters = {}, onLogFilter, logStats = null, logHasMore = false, logLoadingMore = false, onLogMore,
  showKeys = false, onToggleKeys, announce = '',
}) {
  const mode = meta.mode || 'off';
  const current = tab === 'done' ? done : tab === 'log' ? log : waiting;
  const counts = { waiting: meta.waiting ?? waiting.rows?.length, done: done.rows?.length };

  return (
    <div data-testid="mail-review">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h1 className="text-lg font-semibold text-foreground">
          Mail review{workspaceName ? <span className="font-normal text-muted-foreground"> · {workspaceName}</span> : null}
        </h1>
        <p className="flex flex-wrap gap-x-5 gap-y-0.5 text-sm text-muted-foreground sm:ml-auto" data-testid="mr-stats">
          <Stat label="Waiting" value={meta.waiting ?? '–'} />
          <Stat label="Done today" value={meta.doneToday ?? '–'} />
          <Stat label="AI:" value={MODE_WORD[mode] || 'Off'} />
        </p>
      </div>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Held e-mail that Ticket Pulse could not file on its own. Add each one to a ticket, make a new ticket, or say it needs none.
        {' '}<Link to="/tickets" className="tp-focus-ring inline-flex items-center gap-1 rounded text-primary hover:underline"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Tickets</Link>
      </p>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border">
        <div role="tablist" aria-label="Mail review" className="flex gap-5">
          {TABS.map((t) => {
            const on = t.key === tab;
            const n = counts[t.key];
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`mr-tab-${t.key}`}
                aria-selected={on}
                aria-controls="mr-tabpanel"
                onClick={() => onTab?.(t.key)}
                className={`tp-focus-ring -mb-px rounded-t border-b-2 px-0.5 pb-2 pt-1 text-sm ${on ? 'border-primary font-semibold text-foreground' : 'border-transparent font-medium text-muted-foreground hover:text-foreground'}`}
              >
                {t.label}
                {n !== undefined && n !== null && <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{n}</span>}
              </button>
            );
          })}
        </div>
        {tab === 'waiting' && (
          <div className="flex flex-wrap items-center gap-1 pb-1">
            {sureRows.length > 0 && (
              <button
                type="button"
                disabled={bulkBusy}
                onClick={onBulkAccept}
                title={`Adds to a ticket or makes a new one for the ${sureRows.length} the AI is sure about. Each lands in Done, with Undo.`}
                className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary hover:bg-muted disabled:opacity-50"
                data-testid="mr-bulk"
              >
                <CheckCheck className="h-4 w-4" aria-hidden="true" />
                Accept all sure suggestions ({sureRows.length})
              </button>
            )}
            <button
              type="button"
              onClick={onToggleKeys}
              aria-expanded={showKeys}
              aria-controls="mr-keys"
              className="tp-focus-ring hidden h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
              data-testid="mr-keys-toggle"
            >
              <Keyboard className="h-4 w-4" aria-hidden="true" /> Keyboard
            </button>
          </div>
        )}
      </div>

      {tab === 'waiting' && showKeys && (
        <dl id="mr-keys" className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4" data-testid="mr-keys">
          {SHORTCUTS.map(([k, what]) => (
            <div key={k} className="flex gap-1.5">
              <dt className="font-mono font-semibold text-foreground/85">{k}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      )}

      <div
        id="mr-tabpanel"
        role="tabpanel"
        aria-labelledby={`mr-tab-${tab}`}
        aria-busy={dim || undefined}
        className={`pt-1 ${dim ? 'opacity-60' : ''}`}
        data-testid="mr-panel"
      >
        {current.error && <p role="alert" className="px-3 py-3 text-sm text-red-700 dark:text-red-300 sm:px-4">{current.error}</p>}
        {current.rows === null && !current.error && <Loading label="Loading held e-mail" />}

        {tab === 'waiting' && waiting.rows && (
          waiting.rows.length === 0 ? (
            !waiting.error && <p className="px-3 py-12 text-center text-sm text-muted-foreground sm:px-4" data-testid="mr-empty">{EMPTY.waiting}</p>
          ) : (
            <ul className="divide-y divide-border/60" aria-label="Held e-mail waiting for a decision" data-testid="mr-waiting">
              {waiting.rows.map((item) => (
                <WaitingRow
                  key={item.heldId}
                  item={item}
                  mode={mode}
                  focused={item.heldId === focusedId}
                  error={rowErrors[item.heldId] || null}
                  openForm={openForm && openForm.heldId === item.heldId ? openForm.kind : null}
                  detail={detail && detail.heldId === item.heldId ? detail : null}
                  detailError={openForm && openForm.heldId === item.heldId ? detailError : null}
                  viewerEmail={viewerEmail}
                  onFocus={onFocusRow}
                  onAccept={onAccept}
                  onOpenForm={onOpenForm}
                  onPick={onPick}
                  onCreate={onCreate}
                  onNoTicket={onNoTicket}
                  onDetails={onDetails}
                />
              ))}
            </ul>
          )
        )}

        {tab === 'done' && done.rows && (
          done.rows.length === 0
            ? !done.error && <p className="px-3 py-12 text-center text-sm text-muted-foreground sm:px-4">{EMPTY.done}</p>
            : <DoneList rows={done.rows} errors={doneErrors} busyId={undoBusyId} onUndo={onUndoDone} onDetails={onDetails} />
        )}

        {tab === 'log' && log.rows && (
          <div className="pt-2">
            <LogList
              rows={log.rows}
              filters={logFilters}
              onFilter={onLogFilter}
              stats={logStats}
              hasMore={logHasMore}
              loadingMore={logLoadingMore}
              onLoadMore={onLogMore}
              isAdmin={isAdmin}
            />
          </div>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite" data-testid="mr-live">{announce}</p>
    </div>
  );
}
