import { useEffect, useRef, useState, useCallback } from 'react';
import { getAuthToken, getWorkspaceId } from '../services/api';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000') + '/api';

/**
 * Low-level SSE stream reader.  Shared by both the hook and imperative callers.
 *
 * @param {string}        url       Relative API path (e.g. '/assignment/trigger/123?stream=true')
 * @param {object}        opts
 * @param {string}        [opts.method]   HTTP method (default 'POST')
 * @param {object|null}   [opts.body]     JSON body
 * @param {AbortSignal}   [opts.signal]   AbortController signal
 * @param {Function}      opts.onEvent    Called for every parsed SSE event
 * @returns {Promise<void>}
 */
export async function readSSEStream(url, { method = 'POST', body = null, signal, onEvent } = {}) {
  const authToken = getAuthToken();
  const wsId = getWorkspaceId();

  const fetchOpts = {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(wsId ? { 'X-Workspace-Id': String(wsId) } : {}),
    },
    signal,
  };
  if (body) fetchOpts.body = JSON.stringify(body);

  const response = await fetch(`${API_BASE}${url}`, fetchOpts);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reading = true;

  while (reading) {
    const { done, value } = await reader.read();
    if (done) { reading = false; break; }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip malformed */ }
    }
  }
  if (buffer.startsWith('data: ')) {
    try { onEvent(JSON.parse(buffer.slice(6))); } catch { /* skip */ }
  }
}

/**
 * React hook wrapping readSSEStream with lifecycle management (timer, abort, status).
 *
 * Good for components that start streaming on mount/prop change.
 * For imperative start (e.g. re-run button), use readSSEStream directly.
 *
 * @param {object}   opts
 * @param {string}   opts.url        Relative API path (e.g. '/assignment/trigger/123?stream=true')
 * @param {string}   [opts.method]   HTTP method (default 'POST')
 * @param {object}   [opts.body]     JSON body to send
 * @param {Function} opts.onEvent    Called for every parsed SSE event object
 * @param {Function} [opts.onDone]   Called when the stream finishes (after reader closes, status set)
 * @param {boolean}  [opts.enabled]  Set false to defer; stream starts when this flips to true (default true)
 * @param {any[]}    [opts.deps]     Extra dependency array values that re-trigger the stream
 * @returns {{ status, elapsedSec, error, abort }}
 */
export function useStreamingFetch({
  url,
  method = 'POST',
  body,
  onEvent,
  onDone,
  enabled = true,
  deps = [],
}) {
  const [status, setStatus] = useState('idle'); // idle | connecting | running | completed | cancelled | error
  const [error, setError] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  // startedAt is state (not ref) so the timer effect can react to a fresh
  // stream starting. Using a ref here was the original bug — the timer
  // effect lived inside the same setup effect that re-set startTime, so
  // tearing it down + restarting it on every dep change kept the interval
  // from ever firing its first tick.
  const [startedAt, setStartedAt] = useState(null);

  const abortRef = useRef(null);
  const stopRequestedRef = useRef(false);
  const statusRef = useRef('idle');
  const onEventRef = useRef(onEvent);
  const onDoneRef = useRef(onDone);
  onEventRef.current = onEvent;
  onDoneRef.current = onDone;

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Independent ticking timer. Runs whenever there is an active stream and
  // the consumer has not signalled stop via `controls.stopTimer()`. This is
  // intentionally separated from the SSE setup effect so that any extra
  // re-render of the SSE setup never resets the visible elapsed counter.
  useEffect(() => {
    if (startedAt === null) return undefined;
    if (status !== 'connecting' && status !== 'running') return undefined;
    if (stopRequestedRef.current) return undefined;
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt, status]);

  useEffect(() => {
    if (!enabled || !url) return undefined;

    const abortController = new AbortController();
    abortRef.current = abortController;
    stopRequestedRef.current = false;

    statusRef.current = 'connecting';
    setStatus('connecting');
    setError(null);
    setElapsedSec(0);
    setStartedAt(Date.now());

    const stopTimer = () => {
      stopRequestedRef.current = true;
    };

    const controls = { setStatus: (s) => { statusRef.current = s; setStatus(s); }, setError, stopTimer };

    (async () => {
      try {
        statusRef.current = 'running';
        setStatus('running');

        await readSSEStream(url, {
          method,
          body,
          signal: abortController.signal,
          onEvent: (event) => onEventRef.current?.(event, controls),
        });

        if (statusRef.current === 'running') {
          statusRef.current = 'completed';
          setStatus('completed');
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          statusRef.current = 'error';
          setStatus('error');
          setError(err.message);
        }
      } finally {
        stopTimer();
        onDoneRef.current?.(statusRef.current);
      }
    })();

    return () => {
      abortController.abort();
      stopTimer();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, url, method, ...deps]);

  return { status, elapsedSec, error, abort };
}
