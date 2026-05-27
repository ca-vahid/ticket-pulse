import { EventEmitter } from 'events';
import { attachSseDisconnectAbort } from '../src/utils/sseDisconnect.js';

function createHarness() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;
  const abortController = new AbortController();
  let disconnects = 0;
  const markEnding = attachSseDisconnectAbort({
    req,
    res,
    abortController,
    onDisconnect: () => { disconnects++; },
  });

  return { req, res, abortController, markEnding, get disconnects() { return disconnects; } };
}

describe('attachSseDisconnectAbort', () => {
  it('does not abort when the request stream closes but the SSE response remains open', () => {
    const harness = createHarness();

    harness.req.emit('close');

    expect(harness.abortController.signal.aborted).toBe(false);
    expect(harness.disconnects).toBe(0);
  });

  it('aborts when the response closes before the stream ends normally', () => {
    const harness = createHarness();

    harness.res.emit('close');

    expect(harness.abortController.signal.aborted).toBe(true);
    expect(harness.disconnects).toBe(1);
  });

  it('does not abort when the response closes after a normal stream end', () => {
    const harness = createHarness();

    harness.markEnding();
    harness.res.emit('close');

    expect(harness.abortController.signal.aborted).toBe(false);
    expect(harness.disconnects).toBe(0);
  });

  it('aborts when the request is explicitly aborted', () => {
    const harness = createHarness();

    harness.req.emit('aborted');

    expect(harness.abortController.signal.aborted).toBe(true);
    expect(harness.disconnects).toBe(1);
  });
});
