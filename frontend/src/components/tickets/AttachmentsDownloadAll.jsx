import { AlertTriangle, FolderArchive, Loader2, X, XCircle } from 'lucide-react';
import { formatBytes } from './ticketUi';

/** "Download all" controls for the Attachments tab; state comes from useDownloadAll. */
const quietBtn = 'tp-focus-ring inline-flex items-center gap-1.5 rounded-md border border-input bg-card px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground';

export function DownloadAllButton({ state, filterLabel }) {
  const { running, progressText, count, start, cancel, phase } = state;
  if (!running && count < 2) return null;
  const what = filterLabel ? `the ${count} files listed under “${filterLabel}”` : `all ${count} files`;
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={start}
        disabled={phase === 'confirm'}
        aria-busy={running || undefined}
        aria-label={running ? `Cancel download all (${progressText})` : `Download ${what} as one zip`}
        title={running ? 'Click to cancel' : `Download ${what} as one zip`}
        className={`${quietBtn} disabled:opacity-60`}
        data-testid="attachments-download-all"
      >
        {running
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          : <FolderArchive className="h-3.5 w-3.5" aria-hidden="true" />}
        <span className="tabular-nums">{running ? progressText : 'Download all'}</span>
      </button>
      {running && (
        <button type="button" onClick={cancel} aria-label="Cancel download all" title="Cancel"
          className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      <span className="sr-only" role="status" aria-live="polite">{progressText}</span>
    </span>
  );
}

const TONE = {
  warn: { rule: 'border-amber-500', Icon: AlertTriangle, icon: 'text-amber-600 dark:text-amber-400' },
  error: { rule: 'border-destructive', Icon: XCircle, icon: 'text-destructive' },
  info: { rule: 'border-border', Icon: FolderArchive, icon: 'text-muted-foreground' },
};

/** Size confirmation and the after-the-fact result line, under the header. */
export function DownloadAllPanel({ state }) {
  const { phase, note, totalBytes, count, confirm, cancel, dismiss } = state;
  if (phase === 'confirm') {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 border-amber-500 py-1 pl-3 text-[13px] text-foreground" role="group" aria-label="Confirm large download">
        <AlertTriangle className="h-4 w-4 flex-none text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          These {count} files add up to {formatBytes(totalBytes)}. The zip is built in your browser and may take a while.
        </span>
        <span className="flex items-center gap-2">
          <button type="button" onClick={confirm} className="tp-focus-ring rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90">
            Zip anyway
          </button>
          <button type="button" onClick={cancel} className="tp-focus-ring rounded-md px-2.5 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
            Cancel
          </button>
        </span>
      </div>
    );
  }
  if (!note) return null;
  const t = TONE[note.tone] || TONE.info;
  return (
    <div className={`mt-3 flex items-start gap-2 border-l-2 ${t.rule} py-1 pl-3 text-[13px] text-foreground`} role="status" aria-live="polite" data-testid="attachments-download-all-note">
      <t.Icon className={`mt-0.5 h-4 w-4 flex-none ${t.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>{note.text}</p>
        {note.missing?.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {note.missing.map((m, i) => (
              <li key={`${m.fileName}-${i}`} className="truncate" title={m.fileName}>
                <span className="text-foreground/85">{m.fileName}</span> · {m.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" onClick={dismiss} aria-label="Dismiss" title="Dismiss"
        className="tp-focus-ring flex-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
