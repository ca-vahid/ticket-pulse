import { useState, useEffect, useCallback, useRef } from 'react';
import { dataCache } from '../services/dataCache';

/**
 * React hook wrapping DataCache for race-safe, stale-while-revalidate fetching.
 *
 * - `isLoading` is true only on a complete cache miss (no data to show).
 * - `isRefreshing` is true when background revalidation is happening.
 * - Sequence checks prevent stale responses from overwriting newer state.
 */
export function useCachedFetch(cacheKey, fetchFn, { ttl, softTtl, enabled = true } = {}) {
  const [data, setData] = useState(() => (enabled ? dataCache.peek(cacheKey) : null));
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const seqRef = useRef(0);

  const doFetch = useCallback(async () => {
    if (!enabled || !cacheKey) return;

    const mySeq = ++seqRef.current;
    const cached = dataCache.peek(cacheKey);
    if (cached) {
      setData(cached);
      setIsLoading(false);
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      const result = await dataCache.getOrFetch(cacheKey, fetchFn, { ttl, softTtl });
      // Race guard: only apply if this is still the latest request
      if (mySeq === seqRef.current) {
        setData(result.data);
        setIsRefreshing(false);
        setIsLoading(false);
      }
    } catch (err) {
      if (mySeq === seqRef.current) {
        setError(err);
        setIsRefreshing(false);
        setIsLoading(false);
      }
    }
  }, [cacheKey, fetchFn, ttl, softTtl, enabled]);

  useEffect(() => {
    doFetch();
  }, [doFetch]);

  // Listen for external invalidations (e.g. SSE) and re-fetch
  useEffect(() => {
    if (!enabled || !cacheKey) return;
    return dataCache.subscribe(() => {
      if (!dataCache.peek(cacheKey)) {
        doFetch();
      }
    });
  }, [cacheKey, doFetch, enabled]);

  const refetch = useCallback(() => {
    dataCache.invalidateByKeys([cacheKey]);
    return doFetch();
  }, [cacheKey, doFetch]);

  return { data, isLoading, isRefreshing, error, refetch };
}
