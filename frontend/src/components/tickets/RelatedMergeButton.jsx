import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, GitMerge, Loader2, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

/**
 * Merge a related ticket into the one that is open (Vahid, 17 Oct 2026): an
 * agent's reply that FreshService turned into a new ticket ("Re: anyone
 * working today?") sits under Related next to the real one. The small merge
 * icon on its row opens a confirmation that says exactly what will happen,
 * then calls the ordinary merge (conversation copied in, tags combined, the
 * other ticket linked and closed). A FreshService-born ticket can also be
 * deleted in FreshService in the same call — it goes to FreshService's trash
 * and can be restored there.
 */
export default function RelatedMergeButton({ source, target, canDeleteFs = false, onMerged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fsBorn = source?.origin === 'freshservice';
  const [deleteFs, setDeleteFs] = useState(fsBorn && canDeleteFs);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setError(null);
    setDeleteFs(fsBorn && canDeleteFs);
    dialogRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape' && !busy) setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await ticketsAPI.mergeInto(source.id, target.id, { deleteFsSource: fsBorn && deleteFs });
      const data = res?.data?.data ?? res?.data ?? {};
      setOpen(false);
      onMerged?.({ source, fsDelete: data.fsDelete || null });
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'The merge did not go through');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Merge ${source.displayRef} into ${target.displayRef}`}
        aria-label={`Merge ${source.displayRef} into ${target.displayRef}`}
        className="tp-focus-ring flex-shrink-0 rounded-md p-1 text-muted-foreground/60 hover:bg-blue-50 hover:text-blue-700 dark:hover:bg-blue-500/15 dark:hover:text-blue-200"
        data-testid={`related-merge-${source.id}`}
      >
        <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="related-merge-title">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={() => !busy && setOpen(false)} aria-hidden="true" />
          <div ref={dialogRef} tabIndex={-1} className="relative w-full max-w-lg rounded-xl border border-border bg-card shadow-soft" data-testid="related-merge-dialog">
            <div className="flex items-start gap-3 border-b border-border p-4">
              <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
                <GitMerge className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="related-merge-title" className="text-base font-bold text-foreground">
                  Merge {source.displayRef} into {target.displayRef}?
                </h2>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={source.subject || ''}>{source.subject || '(no subject)'}</p>
              </div>
              <button type="button" onClick={() => !busy && setOpen(false)} className="tp-focus-ring rounded-lg p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 p-4 text-sm text-foreground/85">
              <ul className="list-disc space-y-1 pl-5">
                <li>Its conversation is copied into {target.displayRef}, keeping who wrote what and when.</li>
                <li>Tags are combined. Attachments stay on {source.displayRef}; a note on {target.displayRef} says where they are.</li>
                {fsBorn
                  ? <li>{source.displayRef} gets a note pointing to {target.displayRef}.</li>
                  : <li>{source.displayRef} is closed with a note pointing to {target.displayRef}.</li>}
              </ul>
              {fsBorn && (
                <label className={`flex items-start gap-2 rounded-lg border border-border p-3 ${canDeleteFs ? 'cursor-pointer' : 'opacity-70'}`}>
                  <input
                    type="checkbox"
                    checked={deleteFs}
                    disabled={!canDeleteFs || busy}
                    onChange={(e) => setDeleteFs(e.target.checked)}
                    className="tp-focus-ring mt-0.5 rounded border-input text-blue-600 dark:text-blue-300"
                    data-testid="related-merge-delete-fs"
                  />
                  <span>
                    <span className="block font-semibold text-foreground">Also delete {source.displayRef} in FreshService</span>
                    <span className="block text-xs text-muted-foreground">
                      {canDeleteFs
                        ? 'It goes to FreshService’s trash and can be restored there.'
                        : 'Deleting needs reviewer or admin access; it will be merged and left in FreshService.'}
                    </span>
                  </span>
                </label>
              )}
              {error && (
                <p className="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-300" role="alert">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" /> {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border p-3">
              <button type="button" onClick={() => setOpen(false)} disabled={busy} className="tp-focus-ring inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={confirm} disabled={busy} className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50" data-testid="related-merge-confirm">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <GitMerge className="h-4 w-4" aria-hidden="true" />}
                {fsBorn && deleteFs ? 'Merge and delete' : 'Merge'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
