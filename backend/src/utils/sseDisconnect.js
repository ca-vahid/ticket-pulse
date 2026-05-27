export function attachSseDisconnectAbort({ req, res, abortController, onDisconnect }) {
  let endingNormally = false;
  let disconnected = false;

  const markEndingNormally = () => {
    endingNormally = true;
  };

  const abortIfPremature = () => {
    if (endingNormally || res.writableEnded || disconnected) return;
    disconnected = true;
    onDisconnect?.();
    abortController.abort();
  };

  // For streaming responses, req.close can fire once the request body is done
  // even though the SSE response is still open. Watch response close instead.
  res.on('close', abortIfPremature);
  req.on('aborted', abortIfPremature);

  return markEndingNormally;
}
