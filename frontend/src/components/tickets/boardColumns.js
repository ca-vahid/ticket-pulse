import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ticketsAPI } from '../../services/api';
import { PARKED_STATUS, baseStatusOf, statusNamesForBase } from './statusDefs';

/**
 * Board columns fetch their own tickets (QA 10-27 #4).
 *
 * The board used to slice ONE page of the list (50 newest) into Open /
 * Pending / Closed. With Open + Pending + Closed ticked and 223 closed
 * tickets in the date window, the 50 newest were nearly all closed: Pending
 * showed "0 on page" although the rail counted 2. Each column now asks the
 * list endpoint for its own statuses (the rail's other filters, sort and
 * search unchanged), shows that column's true total, and loads more on its
 * own.
 *
 * Columns follow the status filter: a column whose statuses are all out of
 * scope is not shown (Closed keeps its "hidden by current filters" note and
 * "Show closed", QA 08-04 #15/#16). The Closed column holds Resolved too
 * (QA 07-27 #2); with only Resolved-base statuses ticked it is titled
 * "Resolved" and a drop there resolves instead of closing.
 */

export const BOARD_PAGE = 50;
// The list endpoint's page cap (tickets.routes.js maxPageSize).
const MAX_PAGE = 200;
const LEGACY_PENDING = ['Waiting on Customer', 'Waiting on Third Party'];
// Stat-card segments carry their own status scope (mirrors buildListWhere).
const SEGMENT_BUCKETS = {
  open: ['open', 'pending'],
  unassigned: ['open', 'pending'],
  awaiting: ['open', 'pending'],
  due_today: ['open'],
  overdue: ['open'],
  resolved: ['closed'],
  parked: ['pending'],
  deleted: [],
};

/**
 * Which statuses each column asks for. `statuses` is the rail's status pick
 * ([] = every status); `allCount` is how many options the rail has (every
 * workspace status + Parked), so ticking all of them reads as "every status".
 */
export function boardColumnScopes({ statusDefs, statuses = [], segment = 'all', allCount = null }) {
  const members = {
    open: statusNamesForBase(statusDefs, 'Open'),
    pending: [...new Set([...statusNamesForBase(statusDefs, 'Pending'), ...LEGACY_PENDING])],
    closed: statusNamesForBase(statusDefs, ['Resolved', 'Closed']),
  };
  const segmentOn = segment && segment !== 'all';
  const everything = !segmentOn && (statuses.length === 0 || (allCount != null && statuses.length >= allCount));
  const segmentBuckets = segmentOn ? (SEGMENT_BUCKETS[segment] || ['open', 'pending', 'closed']) : null;

  return ['open', 'pending', 'closed'].map((key) => {
    let names;
    let parked = false;
    if (segmentOn) {
      const inSegment = segmentBuckets.includes(key);
      names = inSegment && segment !== 'parked' ? members[key] : [];
      parked = segment === 'parked' && key === 'pending';
    } else if (everything) {
      names = members[key];
      parked = key === 'pending';
    } else {
      names = members[key].filter((name) => statuses.includes(name));
      parked = key === 'pending' && statuses.includes(PARKED_STATUS);
    }
    const statusParam = [...names, ...(parked ? [PARKED_STATUS] : [])].join(',');
    const scope = { key, statuses: names, parked, statusParam, inScope: statusParam.length > 0 };
    if (key === 'closed') {
      const resolvedIn = names.some((n) => baseStatusOf(statusDefs, n) === 'Resolved');
      const closedIn = names.some((n) => baseStatusOf(statusDefs, n) === 'Closed');
      if (resolvedIn && !closedIn) { scope.label = 'Resolved'; scope.dropStatus = 'Resolved'; }
      else if (resolvedIn && closedIn) scope.note = 'incl. Resolved';
    }
    return scope;
  });
}

/** The list query a column sends: the page's filters, its own statuses. */
export function columnQuery(baseParams, scope, { page = 1, pageSize = BOARD_PAGE } = {}) {
  const {
    page: _page, pageSize: _pageSize, facets: _facets, status: _status, parkedSplit: _split, ...rest
  } = baseParams || {};
  return { ...rest, status: scope.statusParam, parkedSplit: '1', page, pageSize };
}

/**
 * Per-column fetch with "Load more". `refreshKey` changes whenever the page's
 * own list refetches (live updates, edits, drops), and the columns follow,
 * keeping how many cards each had loaded.
 */
export function useBoardColumns({ enabled, baseParams, scopes, refreshKey }) {
  const [columns, setColumns] = useState({});
  const loadedRef = useRef({});
  const baseKey = JSON.stringify(baseParams || {});
  const scopeKey = JSON.stringify((scopes || []).map((s) => [s.key, s.statusParam]));
  const tokenRef = useRef(0);
  const lastFilterKey = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const filterKey = `${baseKey}|${scopeKey}`;
    const filtersChanged = lastFilterKey.current !== filterKey;
    lastFilterKey.current = filterKey;
    if (filtersChanged) loadedRef.current = {};
    const token = ++tokenRef.current;
    let cancelled = false;
    const live = (scopes || []).filter((s) => s.inScope);
    setColumns((prev) => {
      const next = {};
      for (const s of live) {
        const keep = !filtersChanged && prev[s.key];
        next[s.key] = keep ? { ...prev[s.key], refreshing: true } : { items: [], total: 0, loading: true, error: null };
      }
      return next;
    });
    for (const scope of live) {
      const size = Math.min(MAX_PAGE, Math.max(BOARD_PAGE, loadedRef.current[scope.key] || 0));
      ticketsAPI.list(columnQuery(baseParams, scope, { pageSize: size }))
        .then((res) => {
          if (cancelled || token !== tokenRef.current) return;
          const items = res?.data?.items || [];
          loadedRef.current[scope.key] = items.length;
          setColumns((prev) => ({ ...prev, [scope.key]: { items, total: res?.data?.total ?? items.length, loading: false, refreshing: false, error: null } }));
        })
        .catch((err) => {
          if (cancelled || token !== tokenRef.current) return;
          setColumns((prev) => ({ ...prev, [scope.key]: { ...(prev[scope.key] || { items: [], total: 0 }), loading: false, refreshing: false, error: err?.message || 'Could not load this column' } }));
        });
    }
    return () => { cancelled = true; };
    // baseParams/scopes are keyed by value (baseKey/scopeKey).
  }, [enabled, baseKey, scopeKey, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback((key) => {
    const scope = (scopes || []).find((s) => s.key === key);
    const current = columns[key];
    if (!scope || !current || current.loadingMore) return;
    const loaded = current.items.length;
    // Next whole page after what is loaded (pages are BOARD_PAGE long).
    const page = Math.floor(loaded / BOARD_PAGE) + 1;
    const token = tokenRef.current;
    setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loadingMore: true } }));
    ticketsAPI.list(columnQuery(baseParams, scope, { page, pageSize: BOARD_PAGE }))
      .then((res) => {
        if (token !== tokenRef.current) return;
        setColumns((prev) => {
          const col = prev[key] || { items: [] };
          const seen = new Set(col.items.map((t) => t.id));
          const items = [...col.items, ...(res?.data?.items || []).filter((t) => !seen.has(t.id))];
          loadedRef.current[key] = items.length;
          return { ...prev, [key]: { ...col, items, total: res?.data?.total ?? col.total, loadingMore: false } };
        });
      })
      .catch(() => {
        if (token !== tokenRef.current) return;
        setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loadingMore: false } }));
      });
  }, [scopes, columns, baseParams]);

  return useMemo(() => ({ columns, loadMore }), [columns, loadMore]);
}
