/**
 * Bounded-concurrency worker pool.
 *
 * Runs `runner(job)` for every job in `jobs`, with at most `poolSize`
 * runners in flight at any given time. Returns once every job has either
 * completed or been swallowed via `onError` — the pool itself never throws
 * unless the caller signals cancellation.
 *
 * Design notes:
 *  - `runner` returning a rejected promise is treated as a per-job failure
 *    by default and routed to `onError(error, job)`. Siblings keep running.
 *  - If `isCancellationError(error)` returns true for any error, the pool
 *    stops draining the queue and the original error is re-thrown to the
 *    caller. This is how callers propagate AbortSignal-style cancellation
 *    without needing to plumb the signal through every job.
 *  - Pool size > the downstream concurrency cap (e.g. an HTTP rate limiter)
 *    is fine and often desired — workers idle only on cancellation, so
 *    extra workers just keep the limiter's queue fed without idle gaps.
 *  - Order of completion is not guaranteed; `runner` should not rely on it.
 *
 * @template J
 * @param {J[]} jobs Items to process. Empty array → resolves immediately.
 * @param {(job: J) => Promise<void>} runner Per-job worker.
 * @param {object} [options]
 * @param {number} [options.poolSize=4] Max in-flight runners. Clamped to
 *   `[1, jobs.length]`.
 * @param {(error: unknown) => boolean} [options.isCancellationError]
 *   Predicate that classifies an error as a cancellation. When it returns
 *   true the pool stops and the error is re-thrown.
 * @param {(error: unknown, job: J) => void} [options.onError] Receives any
 *   non-cancellation error a job rejects with. Defaults to a no-op so
 *   callers must opt in to seeing failures.
 * @returns {Promise<void>} Resolves once the queue is drained.
 */
export async function runJobsInPool(jobs, runner, options = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length === 0) return;

  const poolSize = Math.min(
    Math.max(1, options.poolSize ?? 4),
    list.length,
  );
  const isCancellationError = typeof options.isCancellationError === 'function'
    ? options.isCancellationError
    : () => false;
  const onError = typeof options.onError === 'function'
    ? options.onError
    : () => { /* swallow */ };

  let nextIdx = 0;
  let cancellationError = null;

  const worker = async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (cancellationError) return;
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= list.length) return;
      const job = list[idx];
      try {
        await runner(job);
      } catch (error) {
        if (isCancellationError(error)) {
          cancellationError = error;
          return;
        }
        try {
          onError(error, job);
        } catch {
          /* swallow secondary errors from the error handler itself */
        }
      }
    }
  };

  const workers = [];
  for (let w = 0; w < poolSize; w += 1) workers.push(worker());
  await Promise.all(workers);

  if (cancellationError) throw cancellationError;
}
