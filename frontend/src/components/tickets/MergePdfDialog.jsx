import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FileStack, Loader2, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { formatBytes } from './ticketUi';
import {
  MERGE_LIMIT_BYTES, MergeError, PAGE_SIZES, buildMergedPdf, defaultPageSize, mergeBlocker, mergeKind, mergedFileName, normalisePdfName,
} from './attachmentMerge';
import { attachmentName } from './attachmentNames';

const KIND_LABEL = { pdf: 'PDF', jpg: 'Picture', png: 'Picture' };

/**
 * The step before a merge (QA 11-23 #5): put the files in order (up / down),
 * name the PDF, pick the page size for pictures, then merge and attach.
 * Errors stay in the dialog so the agent can take the bad file out and retry.
 */
export default function MergePdfDialog({ ticketId, items: initialItems, onClose, onDone, loadPdfLib }) {
  const [items, setItems] = useState(initialItems);
  // 4.4.08: the default name follows the first file's shown name (its vendor name when it has one).
  const [name, setName] = useState(() => mergedFileName(initialItems[0] ? attachmentName(initialItems[0]) : null));
  const [nameTouched, setNameTouched] = useState(false);
  const [pageSize, setPageSize] = useState(() => defaultPageSize());
  const [phase, setPhase] = useState('ready'); // ready | reading | building | attaching
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState(null);
  const [announce, setAnnounce] = useState('');
  const abortRef = useRef(null);
  const rootRef = useRef(null);
  const nameRef = useRef(null);

  const running = phase !== 'ready';
  const blocker = useMemo(() => mergeBlocker(items), [items]);
  const totalBytes = items.reduce((sum, a) => sum + (Number(a.sizeBytes) || 0), 0);
  const hasPictures = items.some((a) => mergeKind(a) !== 'pdf');
  const finalName = normalisePdfName(name);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  // The default name follows the first file until the agent edits it.
  useEffect(() => {
    if (!nameTouched) setName(mergedFileName(items[0] ? attachmentName(items[0]) : null));
  }, [items, nameTouched]);

  const close = () => {
    if (phase === 'attaching') return;
    abortRef.current?.abort();
    onClose?.();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab' || !rootRef.current) return;
    const focusable = [...rootRef.current.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const move = (index, delta) => {
    const to = index + delta;
    if (running || to < 0 || to >= items.length) return;
    const next = [...items];
    const [it] = next.splice(index, 1);
    next.splice(to, 0, it);
    setItems(next);
    setError(null);
    setAnnounce(`${attachmentName(it)} moved to position ${to + 1} of ${next.length}.`);
  };

  const remove = (index) => {
    if (running || items.length <= 2) return;
    const it = items[index];
    setItems(items.filter((_, i) => i !== index));
    setError(null);
    setAnnounce(`${attachmentName(it)} taken out. ${items.length - 1} files left.`);
  };

  const merge = async () => {
    if (running || blocker || !finalName) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setProgress({ done: 0, total: items.length });
    setPhase('reading');
    try {
      const { bytes, pageCount } = await buildMergedPdf(items, {
        fetchBytes: (a, { signal }) => ticketsAPI.attachmentBytes(ticketId, a.id, { signal }),
        onProgress: (done, total) => {
          setProgress({ done, total });
          if (done === total) setPhase('building');
        },
        signal: ctrl.signal,
        pageSize,
        loadPdfLib,
      });
      if (ctrl.signal.aborted) return;
      setPhase('attaching');
      const file = new File([bytes], finalName, { type: 'application/pdf' });
      try {
        await ticketsAPI.uploadAttachments(ticketId, [file]);
      } catch (err) {
        const why = String(err?.response?.data?.message || err?.message || '').trim().replace(/[.!]+$/, '');
        throw new MergeError(`The PDF was made but could not be attached${why ? `: ${why}` : ''}. Try again.`);
      }
      onDone?.({ fileName: finalName, pageCount, fileCount: items.length });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof MergeError ? err.message : `Could not merge the files: ${err?.message || 'unknown error'}`);
      setPhase('ready');
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  const statusText = phase === 'reading'
    ? `Reading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
    : phase === 'building' ? 'Building the PDF…'
      : phase === 'attaching' ? 'Attaching to the ticket…' : '';

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 animate-fadeIn sm:items-center" role="dialog" aria-modal="true" aria-labelledby="merge-pdf-title" aria-describedby="merge-pdf-desc" data-testid="merge-pdf-dialog" onKeyDown={onKeyDown} ref={rootRef}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={running ? undefined : close} aria-hidden="true" />
      <div className="relative tp-card w-full max-w-lg rounded-2xl p-5 shadow-soft animate-scaleIn">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
            <FileStack className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="merge-pdf-title" className="text-base font-bold text-foreground">Merge into one PDF</h2>
            <p id="merge-pdf-desc" className="mt-0.5 text-sm text-muted-foreground">
              {items.length} files become one PDF, in this order. The originals stay on the ticket.
            </p>
          </div>
        </div>

        <ol className="mt-4 max-h-64 divide-y divide-border overflow-y-auto border-y border-border settings-scrollbar" aria-label="Files in merge order" data-testid="merge-pdf-order">
          {items.map((a, i) => (
            <li key={a.id} className="flex items-center gap-2 py-2">
              <span className="w-5 flex-none text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground" title={attachmentName(a)}>{attachmentName(a)}</span>
                <span className="block text-[11px] text-muted-foreground">{KIND_LABEL[mergeKind(a)] || 'Not a PDF or picture'} · {formatBytes(a.sizeBytes)}</span>
              </span>
              <button type="button" onClick={() => move(i, -1)} aria-disabled={i === 0 || running} aria-label={`Move ${attachmentName(a)} up`} title="Move up"
                className={`tp-focus-ring flex-none rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground ${i === 0 ? 'opacity-40' : ''}`}>
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => move(i, 1)} aria-disabled={i === items.length - 1 || running} aria-label={`Move ${attachmentName(a)} down`} title="Move down"
                className={`tp-focus-ring flex-none rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground ${i === items.length - 1 ? 'opacity-40' : ''}`}>
                <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => remove(i)} aria-disabled={items.length <= 2 || running} aria-label={`Take ${attachmentName(a)} out of the merge`} title={items.length <= 2 ? 'A merge needs at least two files' : 'Take out'}
                className={`tp-focus-ring flex-none rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground ${items.length <= 2 ? 'opacity-40' : ''}`}>
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
        <p className="sr-only" aria-live="polite">{announce}</p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="font-semibold text-foreground">File name</span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
              disabled={running}
              aria-invalid={!finalName || undefined}
              className="tp-focus-ring mt-1 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground disabled:opacity-60"
            />
            {!finalName && <span className="mt-1 block text-xs text-red-700 dark:text-red-300">Give the PDF a name.</span>}
          </label>

          {hasPictures && (
            <fieldset className="text-sm">
              <legend className="font-semibold text-foreground">Pictures fit on</legend>
              <div className="mt-1 flex gap-4">
                {Object.entries(PAGE_SIZES).map(([key, s]) => (
                  <label key={key} className="inline-flex items-center gap-1.5 text-foreground">
                    <input type="radio" name="merge-page-size" value={key} checked={pageSize === key} onChange={() => setPageSize(key)} disabled={running} className="accent-blue-600" />
                    {s.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <p className="text-xs text-muted-foreground">
            {formatBytes(totalBytes)} of the {formatBytes(MERGE_LIMIT_BYTES)} a merge can take.
          </p>
        </div>

        {(blocker || error) && (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300" data-testid="merge-pdf-error">{blocker || error}</p>
        )}
        {statusText && (
          <p role="status" aria-live="polite" className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-foreground" data-testid="merge-pdf-progress">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /> {statusText}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={close} disabled={phase === 'attaching'}
            className="tp-focus-ring rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/50 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={merge} disabled={running || Boolean(blocker) || !finalName} data-testid="merge-pdf-confirm"
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-60">
            {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileStack className="h-4 w-4" aria-hidden="true" />}
            Merge and attach
          </button>
        </div>
      </div>
    </div>
  );
}
