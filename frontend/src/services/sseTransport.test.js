// Realtime plan Phase 2 — hand-rolled fetch-SSE transport unit tests:
// the incremental stream parser (chunk-split edge cases) and the connection
// contract (hello-within-budget, observable HTTP status, 401→refresh→retry).
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createSseParser,
  openFetchSse,
  fetchPollOnce,
  SseTransportError,
} from './sseTransport';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- parser

describe('createSseParser', () => {
  const collect = () => {
    const events = [];
    const parser = createSseParser((evt) => events.push(evt));
    return { events, parser };
  };

  test('parses a simple named event', () => {
    const { events, parser } = collect();
    parser.push('event: heartbeat\ndata: {"ts":1}\n\n');
    expect(events).toEqual([{ event: 'heartbeat', data: '{"ts":1}', id: null, retry: null }]);
  });

  test('an event split mid-line across chunks reassembles', () => {
    const { events, parser } = collect();
    parser.push('event: sync-comp');
    parser.push('leted\ndata: {"a"');
    parser.push(':1}\n');
    expect(events).toHaveLength(0); // no blank line yet — not dispatched
    parser.push('\n');
    expect(events).toEqual([{ event: 'sync-completed', data: '{"a":1}', id: null, retry: null }]);
  });

  test('multi-line data joins with newlines', () => {
    const { events, parser } = collect();
    parser.push('data: line1\ndata: line2\ndata: line3\n\n');
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2\nline3', id: null, retry: null }]);
  });

  test('CRLF and bare CR line endings are handled', () => {
    const { events, parser } = collect();
    parser.push('event: a\r\ndata: x\r\n\r\n');
    // Bare-CR terminated event; the final \r stays ambiguous until the next
    // chunk proves it isn't half of a CRLF.
    parser.push('event: b\rdata: y\r\r');
    parser.push(': next chunk resolves the trailing CR\n');
    expect(events.map((e) => [e.event, e.data])).toEqual([['a', 'x'], ['b', 'y']]);
  });

  test('a CRLF split across chunks does not produce a phantom empty line', () => {
    const { events, parser } = collect();
    parser.push('event: a\ndata: x\r');
    // If the \r were processed eagerly, the following \n would read as a
    // second newline → premature dispatch of a SECOND (empty) event.
    parser.push('\n\r\n');
    expect(events).toEqual([{ event: 'a', data: 'x', id: null, retry: null }]);
  });

  test('id and retry fields are captured; id persists across events', () => {
    const { events, parser } = collect();
    parser.push('retry: 5000\n\n');
    parser.push('id: ep1:41\nevent: ticket-change\ndata: {}\n\n');
    parser.push('event: presence\ndata: {}\n\n');
    expect(events[0].retry).toBe(5000);
    expect(events[1].id).toBe('ep1:41');
    // Last event id persists (spec) — the presence event inherits it.
    expect(events[2].id).toBe('ep1:41');
  });

  test('comment lines (heartbeat padding) are ignored', () => {
    const { events, parser } = collect();
    parser.push(':hb\n\n: another comment\nevent: a\ndata: 1\n\n');
    expect(events).toEqual([{ event: 'a', data: '1', id: null, retry: null }]);
  });

  test('field without a colon is treated as a field name with empty value', () => {
    const { events, parser } = collect();
    parser.push('data\n\n');
    expect(events).toEqual([{ event: 'message', data: '', id: null, retry: null }]);
  });

  test('a single leading space in the value is stripped, further spaces kept', () => {
    const { events, parser } = collect();
    parser.push('data:  two spaces\n\n');
    expect(events[0].data).toBe(' two spaces');
  });

  test('one chunk carrying many events dispatches each', () => {
    const { events, parser } = collect();
    parser.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n');
    expect(events.map((e) => e.event)).toEqual(['a', 'b', 'c']);
  });
});

// ------------------------------------------------------------ openFetchSse

function streamFrom(chunks) {
  const encoder = new TextEncoder();
  let controllerRef;
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
  return { stream, push: (chunk) => controllerRef.enqueue(new TextEncoder().encode(chunk)), close: () => controllerRef.close() };
}

function sseResponse(chunks, { status = 200 } = {}) {
  const { stream, push, close } = streamFrom(chunks);
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      body: stream,
      headers: new Map([['content-type', 'text/event-stream']]),
    },
    push,
    close,
  };
}

describe('openFetchSse', () => {
  test('sends Authorization + Last-Event-ID headers, dispatches events, tracks ids', async () => {
    const seen = [];
    const { response, close } = sseResponse(['event: hello\ndata: {"epoch":"e1"}\n\n', 'id: e1:7\nevent: ticket-change\ndata: {"x":1}\n\n']);
    const fetchImpl = vi.fn(async () => response);

    const handle = openFetchSse({
      url: 'http://x/api/sse/events?workspaceId=1',
      getToken: () => 'tok-1',
      lastEventId: 'e1:3',
      onEvent: (evt) => seen.push(evt),
      fetchImpl,
    });
    close();
    await expect(handle.finished).rejects.toMatchObject({ type: 'closed' });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.headers['Last-Event-ID']).toBe('e1:3');
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(seen.map((e) => e.event)).toEqual(['hello', 'ticket-change']);
    expect(seen[1].id).toBe('e1:7');
  });

  test('401 → refreshToken once → retry with the fresh token; second 401 is a typed auth failure', async () => {
    let token = 'stale';
    const refreshToken = vi.fn(async () => { token = 'fresh'; });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, body: null }));

    const handle = openFetchSse({
      url: 'http://x/api/sse/events?workspaceId=1',
      getToken: () => token,
      refreshToken,
      onEvent: () => {},
      fetchImpl,
    });
    await expect(handle.finished).rejects.toMatchObject({ type: 'auth', status: 401 });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh');
  });

  test('other 4xx are typed terminal failures (no retry hammering)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, body: null }));
    const handle = openFetchSse({ url: 'http://x', onEvent: () => {}, fetchImpl });
    await expect(handle.finished).rejects.toMatchObject({ type: 'terminal', status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('5xx and network rejections are typed network failures', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, body: null }));
    await expect(openFetchSse({ url: 'http://x', onEvent: () => {}, fetchImpl }).finished)
      .rejects.toMatchObject({ type: 'network', status: 503 });

    const rejecting = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(openFetchSse({ url: 'http://x', onEvent: () => {}, fetchImpl: rejecting }).finished)
      .rejects.toMatchObject({ type: 'network' });
  });

  test('headers-but-no-event within the hello budget aborts with no-hello (buffered-proxy signature)', async () => {
    vi.useFakeTimers();
    // A body that never produces a byte but honors the abort signal (as real
    // fetch bodies do).
    const fetchImpl = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
        }),
      },
    }));

    const handle = openFetchSse({
      url: 'http://x',
      onEvent: () => {},
      helloTimeoutMs: 5000,
      fetchImpl,
    });
    const assertion = expect(handle.finished).rejects.toMatchObject({ type: 'no-hello' });
    await vi.advanceTimersByTimeAsync(5100);
    await assertion;
  });

  test('no response headers within the connect budget aborts with timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const handle = openFetchSse({ url: 'http://x', onEvent: () => {}, connectTimeoutMs: 10000, fetchImpl });
    const assertion = expect(handle.finished).rejects.toMatchObject({ type: 'timeout' });
    await vi.advanceTimersByTimeAsync(10100);
    await assertion;
  });

  test('close() ends the stream with the non-failure aborted type', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: () => {
              if (!delivered) {
                delivered = true;
                return Promise.resolve({ done: false, value: encoder.encode('event: hello\ndata: {}\n\n') });
              }
              return new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
              });
            },
          };
        },
      },
    }));
    const seen = [];
    const handle = openFetchSse({ url: 'http://x', onEvent: (evt) => seen.push(evt), fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.map((e) => e.event)).toEqual(['hello']);
    handle.close();
    await expect(handle.finished).rejects.toMatchObject({ type: 'aborted' });
  });
});

// ------------------------------------------------------------ fetchPollOnce

describe('fetchPollOnce', () => {
  test('returns the parsed poll payload', async () => {
    const payload = { events: [{ id: 'e1:2', event: 'ticket-change', data: {} }], cursor: 'e1:2', epoch: 'e1' };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
    await expect(fetchPollOnce({ url: 'http://x', fetchImpl })).resolves.toEqual(payload);
    expect(fetchImpl.mock.calls[0][1].credentials).toBe('include');
  });

  test('401 → refresh once → retry; then typed auth failure', async () => {
    const refreshToken = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }));
    await expect(fetchPollOnce({ url: 'http://x', refreshToken, fetchImpl }))
      .rejects.toMatchObject({ type: 'auth' });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('4xx → typed terminal failure', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400 }));
    await expect(fetchPollOnce({ url: 'http://x', fetchImpl }))
      .rejects.toMatchObject({ type: 'terminal', status: 400 });
  });

  test('outer signal abort surfaces as the non-failure aborted type', async () => {
    const outer = new AbortController();
    const fetchImpl = vi.fn((url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const promise = fetchPollOnce({ url: 'http://x', signal: outer.signal, fetchImpl });
    outer.abort();
    await expect(promise).rejects.toMatchObject({ type: 'aborted' });
  });

  test('errors are SseTransportError instances', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(fetchPollOnce({ url: 'http://x', fetchImpl }))
      .rejects.toBeInstanceOf(SseTransportError);
  });
});
