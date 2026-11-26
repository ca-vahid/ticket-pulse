import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { workspaceAPI } from '../../services/api';
import FreshServiceSwitchView from './FreshServiceSwitchView';

/**
 * Container for the FreshService switch of one workspace (25 Nov 2026):
 * loads GET /workspaces/:id/freshservice, sets Connected / Shadow at once,
 * starts the guided Off job and polls its progress every 2 s until it ends.
 * The view (FreshServiceSwitchView) is props-in only.
 */

const POLL_MS = 2000;
// A "done" record without finishedAt whose process died would never finish: stop after ~1 min.
const MAX_UNFINISHED_DONE_POLLS = 30;
const errorText = (err, fallback) => err?.response?.data?.message || err?.data?.message || err?.message || fallback;

export default function FreshServiceSwitchPanel({ workspaceId, onModeChanged = null }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const settledRef = useRef(false); // the current job's polling has ended

  const load = useCallback(async () => {
    try {
      const res = await workspaceAPI.getFreshService(workspaceId);
      setData(res?.data || null);
      setLoadError(null);
      return res?.data || null;
    } catch (err) {
      setLoadError(errorText(err, 'Could not load the FreshService settings'));
      return null;
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  // Poll the Off job while it runs; reload everything when it ends. "Ends"
  // means the record is finished: once the mode is Off the job already reads
  // done while its second adoption pass is still writing (finishedAt unset),
  // so keep polling a little longer for that pass's note.
  const job0 = data?.job;
  const running = job0?.state === 'running' || (job0?.state === 'done' && !job0?.finishedAt && !settledRef.current);
  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    let unfinishedDonePolls = 0;
    const tick = async () => {
      try {
        const res = await workspaceAPI.getFreshServiceOff(workspaceId);
        const job = res?.data || null;
        if (cancelled) return;
        const stillWriting = job?.state === 'done' && !job.finishedAt && unfinishedDonePolls < MAX_UNFINISHED_DONE_POLLS;
        if (stillWriting) unfinishedDonePolls += 1;
        if (job?.state === 'running' || stillWriting) {
          setData((d) => (d ? { ...d, job } : d));
          pollRef.current = setTimeout(tick, POLL_MS);
        } else {
          settledRef.current = true; // finished, or gave up waiting: do not start polling again
          const fresh = await load();
          if (!cancelled && fresh) {
            setData({ ...fresh, job: job || fresh.job });
            onModeChanged?.(workspaceId, fresh.mode);
          }
        }
      } catch {
        if (!cancelled) pollRef.current = setTimeout(tick, POLL_MS * 2);
      }
    };
    pollRef.current = setTimeout(tick, POLL_MS);
    return () => { cancelled = true; clearTimeout(pollRef.current); };
  }, [running, workspaceId, load, onModeChanged]);

  const setMode = async (mode) => {
    setBusy(true);
    setError(null);
    try {
      await workspaceAPI.setFreshServiceMode(workspaceId, mode);
      const fresh = await load();
      onModeChanged?.(workspaceId, fresh?.mode || mode);
    } catch (err) {
      setError(errorText(err, 'The mode could not be changed'));
    } finally {
      setBusy(false);
    }
  };

  const startOff = async (confirmName) => {
    setBusy(true);
    setError(null);
    try {
      const res = await workspaceAPI.startFreshServiceOff(workspaceId, confirmName);
      settledRef.current = false;
      setData((d) => (d ? { ...d, job: res?.data || { state: 'running', step: 'check' } } : d));
    } catch (err) {
      setError(errorText(err, 'FreshService could not be switched off'));
    } finally {
      setBusy(false);
    }
  };

  if (loadError && !data) return <p className="text-sm text-destructive" role="alert">{loadError}</p>;
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading FreshService…
      </p>
    );
  }
  return <FreshServiceSwitchView data={data} busy={busy} error={error} onSetMode={setMode} onStartOff={startOff} />;
}
