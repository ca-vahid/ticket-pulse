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
const errorText = (err, fallback) => err?.response?.data?.message || err?.data?.message || err?.message || fallback;

export default function FreshServiceSwitchPanel({ workspaceId, onModeChanged = null }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

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

  // Poll the Off job while it runs; reload everything when it ends.
  const running = data?.job?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await workspaceAPI.getFreshServiceOff(workspaceId);
        const job = res?.data || null;
        if (cancelled) return;
        if (job?.state === 'running') {
          setData((d) => (d ? { ...d, job } : d));
          pollRef.current = setTimeout(tick, POLL_MS);
        } else {
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
