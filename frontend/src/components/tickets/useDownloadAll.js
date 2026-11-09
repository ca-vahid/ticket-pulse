import { useCallback, useEffect, useRef, useState } from 'react';
import { ticketsAPI } from '../../services/api';
import { MISSING_FILES_NAME, SIZE_CONFIRM_BYTES, buildAttachmentsZip, zipFileName } from './attachmentZip';

/**
 * "Download all" (QA 11-06 #5): one zip of the files the Attachments tab is
 * listing. State lives in a hook so the button sits in the tab header and the
 * confirm / result line sits under it.
 */
export function useDownloadAll({ ticketId, attachments, ticketRef, subject }) {
  const [phase, setPhase] = useState('idle'); // idle | confirm | fetching | zipping
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [note, setNote] = useState(null); // { tone: 'warn'|'error'|'info', text, missing? }
  const abortRef = useRef(null);
  const listRef = useRef([]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const totalBytes = attachments.reduce((sum, a) => sum + (Number(a.sizeBytes) || 0), 0);
  const running = phase === 'fetching' || phase === 'zipping';

  const run = useCallback(async (list) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setNote(null);
    setProgress({ done: 0, total: list.length });
    setPhase('fetching');
    try {
      const { blob, included, missing } = await buildAttachmentsZip(list, {
        fetchBytes: (a, { signal }) => ticketsAPI.attachmentBytes(ticketId, a.id, { signal }),
        onProgress: (done, total) => {
          setProgress({ done, total });
          if (done === total) setPhase('zipping');
        },
        signal: ctrl.signal,
      });
      if (!blob) {
        setNote({ tone: 'error', text: `None of the ${list.length} files could be downloaded, so no zip was made.`, missing });
      } else {
        ticketsAPI.saveBlob(blob, zipFileName(ticketRef, subject));
        if (missing.length) {
          setNote({
            tone: 'warn',
            text: `Zip downloaded with ${included.length} of ${list.length} files. These could not be included (also listed in ${MISSING_FILES_NAME}):`,
            missing,
          });
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) setNote({ tone: 'info', text: 'Download all cancelled. Nothing was saved.' });
      else setNote({ tone: 'error', text: `Could not make the zip: ${err?.message || 'unknown error'}` });
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setPhase('idle');
    }
  }, [ticketId, ticketRef, subject]);

  const start = useCallback(() => {
    if (running) { abortRef.current?.abort(); return; }
    listRef.current = [...attachments];
    if (totalBytes > SIZE_CONFIRM_BYTES) { setNote(null); setPhase('confirm'); return; }
    run(listRef.current);
  }, [attachments, running, totalBytes, run]);

  const confirm = useCallback(() => run(listRef.current), [run]);
  const cancel = useCallback(() => {
    if (running) abortRef.current?.abort();
    else setPhase('idle');
  }, [running]);
  const dismiss = useCallback(() => setNote(null), []);

  const step = Math.min(progress.done + 1, progress.total);
  const progressText = phase === 'fetching'
    ? `Zipping ${step} of ${progress.total}…`
    : phase === 'zipping' ? 'Finishing zip…' : '';

  return { phase, running, progressText, note, totalBytes, count: attachments.length, start, confirm, cancel, dismiss };
}
