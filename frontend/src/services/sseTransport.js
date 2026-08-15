// Fetch-based SSE transport (realtime plan Phase 2, hand-rolled).
//
// Why not native EventSource: it cannot send an Authorization header (token
// leaks into proxy logs via ?token=), cannot observe HTTP status codes (a 401
// looks identical to a network blip), and gives no timeout control — a proxy
// that forwards headers then buffers the body pins it at "connecting" forever.
// Why not @microsoft/fetch-event-source: unmaintained for ~5 years (see
// docs/research/REALTIME_RELIABILITY_NOTES.md §3) and we override all of its
// retry logic anyway — the parser is ~100 lines.

export const HELLO_TIMEOUT_MS = 5000;
export const CONNECT_TIMEOUT_MS = 10000;

/** Typed transport failure — `type` drives the ladder's reaction. */
export class SseTransportError extends Error {
  constructor(type, message, status = null) {
    super(message || type);
    this.name = 'SseTransportError';
    // 'auth'      → 401 even after a refresh (credentials dead)
    // 'terminal'  → other 4xx (workspace_forbidden, bad request) — do NOT hammer
    // 'no-hello'  → headers arrived but no server event within the budget
    //               (the proxy-buffered-stream signature)
    // 'timeout'   → no response headers within the connect budget
    // 'network'   → fetch rejected (offline, DNS, connection refused, 5xx)
    // 'closed'    → the stream ended (server restart/deploy)
    // 'aborted'   → we closed it deliberately (not a failure)
    this.type = type;
    this.status = status;
  }
}

/**
 * Incremental text/event-stream parser (WHATWG spec): handles events split
 * across chunks mid-line, multi-line `data:` fields, CRLF/CR/LF line endings,
 * comments, and the `id:`/`retry:` fields.
 *
 * @param {(evt: { event: string, data: string, id: string|null, retry: number|null }) => void} onEvent
 * @returns {{ push(chunk: string): void, end(): void, reset(): void }}
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let eventType = '';
  let dataLines = [];
  let eventId = null;
  let retry = null;
  let sawAnyField = false;

  const dispatch = () => {
    if (!sawAnyField && dataLines.length === 0) {
      // Blank line with no accumulated fields — nothing to dispatch.
      eventType = '';
      return;
    }
    onEvent({
      event: eventType || 'message',
      data: dataLines.join('\n'),
      id: eventId,
      retry,
    });
    eventType = '';
    dataLines = [];
    retry = null;
    sawAnyField = false;
    // Per spec the last event id PERSISTS across events — do not reset it.
  };

  const processLine = (line) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment (heartbeat padding etc.)

    let field = line;
    let value = '';
    const colon = line.indexOf(':');
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
    case 'event':
      eventType = value;
      sawAnyField = true;
      break;
    case 'data':
      dataLines.push(value);
      sawAnyField = true;
      break;
    case 'id':
      // Per spec: ignore ids containing NUL.
      if (!value.includes('\u0000')) eventId = value;
      sawAnyField = true;
      break;
    case 'retry':
      if (/^\d+$/.test(value)) retry = Number(value);
      sawAnyField = true;
      break;
    default:
      // Unknown field — ignored per spec.
      break;
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      // Split on \r\n, \r, or \n. A trailing \r is ambiguous (the next chunk
      // may start with \n) — keep it in the buffer until more data arrives.
      let searchFrom = 0;
      for (;;) {
        const nl = buffer.indexOf('\n', searchFrom);
        const cr = buffer.indexOf('\r', searchFrom);
        let lineEnd = -1;
        let nextStart = -1;
        if (cr !== -1 && (nl === -1 || cr < nl)) {
          if (cr === buffer.length - 1) break; // ambiguous trailing \r
          lineEnd = cr;
          nextStart = buffer[cr + 1] === '\n' ? cr + 2 : cr + 1;
        } else if (nl !== -1) {
          lineEnd = nl;
          nextStart = nl + 1;
        } else {
          break;
        }
        processLine(buffer.slice(searchFrom, lineEnd));
        searchFrom = nextStart;
      }
      buffer = buffer.slice(searchFrom);
    },
    end() {
      // Stream ended: a buffered final line without a trailing newline is NOT
      // processed per spec (incomplete line), and any un-terminated event is
      // discarded (no trailing blank line = never dispatched).
      buffer = '';
    },
    reset() {
      buffer = '';
      eventType = '';
      dataLines = [];
      eventId = null;
      retry = null;
      sawAnyField = false;
    },
  };
}

/**
 * Open ONE fetch-based SSE connection attempt and pump events until it dies.
 *
 * - `Authorization: Bearer` header (no token in the URL).
 * - `Last-Event-ID` header on reconnects (server replays the gap).
 * - Connect budget: response headers within `connectTimeoutMs`.
 * - Hello budget: the FIRST server event within `helloTimeoutMs` of headers —
 *   otherwise abort with 'no-hello' (converts a buffered stream into a
 *   detectable failure).
 * - 401 → one refreshToken() → one retry; a second 401 is a typed 'auth'
 *   failure. Other 4xx are typed 'terminal' (no hammering).
 *
 * @returns {{ close(): void, finished: Promise<never> }} `finished` always
 *   rejects with an SseTransportError describing why the stream ended
 *   ('aborted' when close() was called).
 */
export function openFetchSse({
  url,
  getToken = () => null,
  refreshToken = null,
  lastEventId = null,
  helloTimeoutMs = HELLO_TIMEOUT_MS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  onEvent,
  onOpen = null,
  fetchImpl = null,
}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const controller = new AbortController();
  let abortReason = null; // 'closed-by-us' | 'timeout' | 'no-hello'
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    abortReason = abortReason || 'closed-by-us';
    controller.abort();
  };

  const finished = (async () => {
    let refreshed = false;

    for (;;) {
      const headers = { Accept: 'text/event-stream' };
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;

      const connectTimer = setTimeout(() => {
        abortReason = 'timeout';
        controller.abort();
      }, connectTimeoutMs);

      let response;
      try {
        response = await doFetch(url, {
          headers,
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(connectTimer);
        if (abortReason === 'closed-by-us') throw new SseTransportError('aborted', 'closed');
        if (abortReason === 'timeout') throw new SseTransportError('timeout', 'no response headers within budget');
        throw new SseTransportError('network', err?.message || 'fetch failed');
      }
      clearTimeout(connectTimer);

      if (response.status === 401) {
        if (!refreshed && typeof refreshToken === 'function') {
          refreshed = true;
          try {
            await refreshToken();
          } catch { /* fall through — retry may still work on the cookie */ }
          if (closed) throw new SseTransportError('aborted', 'closed');
          continue; // one retry with (hopefully) fresh credentials
        }
        throw new SseTransportError('auth', 'unauthorized after refresh', 401);
      }
      if (response.status >= 400 && response.status < 500) {
        throw new SseTransportError('terminal', `HTTP ${response.status}`, response.status);
      }
      if (!response.ok || !response.body) {
        throw new SseTransportError('network', `HTTP ${response.status}`, response.status);
      }

      if (onOpen) onOpen(response);

      // Headers are in — now REQUIRE a first server event within the hello
      // budget. A proxy that scans/buffers the stream never delivers it.
      let sawFirstEvent = false;
      const helloTimer = setTimeout(() => {
        if (!sawFirstEvent) {
          abortReason = 'no-hello';
          controller.abort();
        }
      }, helloTimeoutMs);

      const parser = createSseParser((evt) => {
        if (!sawFirstEvent) {
          sawFirstEvent = true;
          clearTimeout(helloTimer);
        }
        if (evt.id) lastEventId = evt.id;
        onEvent(evt);
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        clearTimeout(helloTimer);
        if (abortReason === 'closed-by-us') throw new SseTransportError('aborted', 'closed');
        if (abortReason === 'no-hello') throw new SseTransportError('no-hello', 'no server event within budget');
        throw new SseTransportError('network', err?.message || 'stream read failed');
      }
      clearTimeout(helloTimer);
      parser.end();
      // Server ended the stream (deploy/restart) — a failure for the ladder,
      // but a soft one.
      throw new SseTransportError('closed', 'stream ended');
    }
  })();

  return { close, finished };
}

/**
 * One poll request against GET /api/sse/poll (long-poll when waitMs > 0,
 * short-poll with waitMs = 0). Same auth + typed-failure semantics as the
 * SSE connect. Resolves `{ events, cursor, epoch, resync? }`.
 */
export async function fetchPollOnce({
  url,
  getToken = () => null,
  refreshToken = null,
  signal = null,
  timeoutMs = 40000,
  fetchImpl = null,
}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let refreshed = false;

  for (;;) {
    const headers = { Accept: 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new SseTransportError('aborted', 'closed');
      }
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let response;
    try {
      response = await doFetch(url, {
        headers,
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new SseTransportError('aborted', 'closed');
      if (timedOut) throw new SseTransportError('timeout', 'poll timed out');
      throw new SseTransportError('network', err?.message || 'fetch failed');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }

    if (response.status === 401) {
      if (!refreshed && typeof refreshToken === 'function') {
        refreshed = true;
        try {
          await refreshToken();
        } catch { /* retry may still work on the cookie */ }
        continue;
      }
      throw new SseTransportError('auth', 'unauthorized after refresh', 401);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new SseTransportError('terminal', `HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
      throw new SseTransportError('network', `HTTP ${response.status}`, response.status);
    }

    try {
      return await response.json();
    } catch (err) {
      throw new SseTransportError('network', err?.message || 'invalid poll payload');
    }
  }
}
