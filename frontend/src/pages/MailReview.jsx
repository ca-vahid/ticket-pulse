import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import MailReviewView, { ReviewToast, TABS } from '../components/mailReview/MailReviewView';
import MailDetailsPanel from '../components/mailReview/MailDetailsPanel';
import { isAcceptable, isSureBulk, resultSentence } from '../components/mailReview/mailReviewText';
import { ticketsAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import { isWorkspaceAdmin, useWorkspaceRole } from '../components/nav/navDestinations';
import { useDelayedFlag } from '../hooks/useDelayedFlag';

/**
 * Tickets → Mail review (plans/MAIL_TRIAGE_PLAN.md, 11 Nov 2026): the held
 * e-mail queue as a page. Each mail carries the AI's suggestion; a person
 * accepts it, picks another ticket, makes a new ticket or says it needs none.
 *
 * Nothing asks "are you sure?": every action is applied at once, lands in
 * Done and shows a toast with Undo for 8 seconds. Updates are optimistic and
 * roll back with the server's message when they fail. A refetch never blanks
 * the list; it dims after 150 ms.
 */
const LOG_PAGE = 50;
const TOAST_MS = 8000;
const EMPTY_LIST = { rows: null, error: null };
const message = (err) => err?.response?.data?.message || err?.message || 'That did not work. Try again.';
const typingTarget = (el) => Boolean(el?.closest?.('input, textarea, select, [contenteditable="true"], [data-mr-popover]'));

export default function MailReview() {
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { width: layoutWidth } = useLayoutWidth();
  const wsRole = useWorkspaceRole();
  const isAdmin = isWorkspaceAdmin(user, wsRole);
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab = TABS.some((t) => t.key === tabParam) ? tabParam : 'waiting';

  const [lists, setLists] = useState({ waiting: EMPTY_LIST, done: EMPTY_LIST, log: EMPTY_LIST });
  const [meta, setMeta] = useState({});
  const [fetching, setFetching] = useState(0);
  const [logFilters, setLogFilters] = useState({});
  const [logInfo, setLogInfo] = useState({ stats: null, hasMore: false, nextBefore: null, loadingMore: false });
  const [focusedId, setFocusedId] = useState(null);
  const [openForm, setOpenForm] = useState(null); // { heldId, kind: 'pick' | 'new' }
  const [detailsItem, setDetailsItem] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [rejudging, setRejudging] = useState(false);
  const [rowErrors, setRowErrors] = useState({});
  const [doneErrors, setDoneErrors] = useState({});
  const [undoBusyId, setUndoBusyId] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [announce, setAnnounce] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const moveFocus = useRef(null);
  const live = useRef({});
  const dim = useDelayedFlag(fetching > 0 && lists[tab].rows !== null);

  const say = useCallback((text, extra = {}) => {
    setAnnounce(text);
    setToast({ text, ...extra, at: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async (which, { filters = null, before = null } = {}) => {
    setFetching((n) => n + 1);
    try {
      const params = { tab: which };
      if (which === 'log') Object.assign(params, { limit: LOG_PAGE, ...(filters || {}), ...(before ? { before } : {}) });
      const res = await ticketsAPI.mailReviewList(params);
      const rows = res?.data || [];
      const m = res?.meta || {};
      setLists((cur) => ({
        ...cur,
        [which]: { rows: before ? [...(cur[which].rows || []), ...rows] : rows, error: null },
      }));
      setMeta((cur) => {
        const next = { ...cur };
        for (const k of ['waiting', 'doneToday', 'mode', 'sureCount']) if (m[k] !== undefined) next[k] = m[k];
        return next;
      });
      if (which === 'log') {
        setLogInfo((cur) => ({
          stats: m.stats?.last30 || m.last30 || (before ? cur.stats : null),
          // The server's cursor wins; without one, a full page means there may be more.
          hasMore: m.nextBefore !== undefined ? m.nextBefore !== null : m.hasMore ?? rows.length >= LOG_PAGE,
          nextBefore: m.nextBefore ?? null,
          loadingMore: false,
        }));
      }
    } catch (err) {
      // Keep what is on screen; say what went wrong above it.
      setLists((cur) => ({ ...cur, [which]: { rows: cur[which].rows, error: message(err) } }));
      if (which === 'log') setLogInfo((cur) => ({ ...cur, loadingMore: false }));
    } finally {
      setFetching((n) => n - 1);
    }
  }, []);

  // Waiting always loads (the header counts come with it); the other tabs load when opened.
  useEffect(() => { load('waiting'); }, [load, currentWorkspace?.id]);
  useEffect(() => {
    if (tab === 'done') load('done');
    if (tab === 'log') load('log', { filters: logFilters });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, load, currentWorkspace?.id]);

  const waitingRows = lists.waiting.rows;
  useEffect(() => {
    if (!waitingRows?.length) { if (focusedId !== null) setFocusedId(null); return; }
    if (!waitingRows.some((r) => r.heldId === focusedId)) setFocusedId(waitingRows[0].heldId);
  }, [waitingRows, focusedId]);
  useEffect(() => {
    // The ref names the row to focus, so a late effect for another row cannot take it.
    if (focusedId === null || moveFocus.current !== focusedId) return;
    moveFocus.current = null;
    const el = document.querySelector(`[data-held-id="${focusedId}"]`);
    el?.focus?.({ preventScroll: true });
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [focusedId, waitingRows]);

  const setTab = (next) => {
    setOpenForm(null);
    setSearchParams(next === 'waiting' ? {} : { tab: next }, { replace: true });
  };

  const ensureDetail = useCallback((heldId) => {
    setDetailError(null);
    setDetail((cur) => (cur && cur.heldId === heldId ? cur : null));
    Promise.resolve()
      .then(() => ticketsAPI.mailReviewGet(heldId))
      .then((res) => { if (res?.data) setDetail(res.data); })
      .catch((err) => setDetailError(message(err)));
  }, []);

  const openDetails = useCallback((item) => {
    setOpenForm(null);
    setDetailsItem(item);
    ensureDetail(item.heldId);
  }, [ensureDetail]);

  const toggleForm = useCallback((item, kind) => {
    setRowErrors((cur) => ({ ...cur, [item.heldId]: undefined }));
    if (!kind) { setOpenForm(null); return; }
    setOpenForm({ heldId: item.heldId, kind });
    if (kind === 'pick') ensureDetail(item.heldId);
  }, [ensureDetail]);

  /** Apply one decision: the row leaves at once and comes back, with the reason, if the server refuses. */
  const resolve = useCallback(async (item, body, ticket = null) => {
    const rows = live.current.waitingRows || [];
    const index = rows.findIndex((r) => r.heldId === item.heldId);
    if (index < 0) return;
    const next = rows[index + 1] || rows[index - 1] || null;
    const hadFocus = Boolean(document.activeElement?.closest?.(`[data-held-id="${item.heldId}"]`));
    setOpenForm(null);
    setRowErrors((cur) => ({ ...cur, [item.heldId]: undefined }));
    setLists((cur) => ({ ...cur, waiting: { ...cur.waiting, rows: (cur.waiting.rows || []).filter((r) => r.heldId !== item.heldId) } }));
    setMeta((cur) => ({ ...cur, waiting: Math.max(0, (cur.waiting ?? rows.length) - 1), doneToday: (cur.doneToday ?? 0) + 1 }));
    if (next) { moveFocus.current = hadFocus ? next.heldId : null; setFocusedId(next.heldId); }
    const payload = { ...body, ...(item.suggestion?.decisionId ? { decisionId: item.suggestion.decisionId } : {}) };
    try {
      const res = await ticketsAPI.mailReviewResolve(item.heldId, payload);
      const made = res?.data?.resolution?.ticket || ticket;
      say(resultSentence(body, made), { undoIds: [item.heldId] });
      setLists((cur) => ({ ...cur, done: EMPTY_LIST }));
    } catch (err) {
      setLists((cur) => {
        const now = cur.waiting.rows || [];
        if (now.some((r) => r.heldId === item.heldId)) return cur;
        const back = [...now];
        back.splice(Math.min(index, back.length), 0, item);
        return { ...cur, waiting: { ...cur.waiting, rows: back } };
      });
      setMeta((cur) => ({ ...cur, waiting: (cur.waiting ?? 0) + 1, doneToday: Math.max(0, (cur.doneToday ?? 1) - 1) }));
      setRowErrors((cur) => ({ ...cur, [item.heldId]: message(err) }));
      setFocusedId(item.heldId);
      setAnnounce(`Not done: ${message(err)}`);
    }
  }, [say]);

  const accept = useCallback((item) => {
    const s = item.suggestion;
    if (!isAcceptable(s)) return;
    if (s.action === 'attach') resolve(item, { action: 'attach', ticketId: s.ticket.id, reopen: Boolean(s.reopen) }, s.ticket);
    else if (s.action === 'create') resolve(item, { action: 'create', ...(s.requester?.email ? { requesterEmail: s.requester.email } : {}) });
    else resolve(item, { action: 'no_ticket' });
  }, [resolve]);
  const pick = useCallback((item, ticket, reopen) => resolve(item, { action: 'attach', ticketId: ticket.id, reopen: Boolean(reopen) }, ticket), [resolve]);
  const create = useCallback((item, requesterEmail) => resolve(item, { action: 'create', ...(requesterEmail ? { requesterEmail } : {}) }), [resolve]);
  const noTicket = useCallback((item) => resolve(item, { action: 'no_ticket' }), [resolve]);

  const sureRows = useMemo(() => (waitingRows || []).filter((r) => isSureBulk(r.suggestion)), [waitingRows]);
  const bulkAccept = async () => {
    const ids = sureRows.map((r) => r.heldId);
    if (!ids.length) return;
    const before = lists.waiting.rows;
    setBulkOpen(false);
    setBulkBusy(true);
    setLists((cur) => ({ ...cur, waiting: { ...cur.waiting, rows: (cur.waiting.rows || []).filter((r) => !ids.includes(r.heldId)) } }));
    try {
      const res = await ticketsAPI.mailReviewBulkAccept(ids);
      const accepted = res?.data?.accepted || [];
      const skipped = res?.data?.skipped || [];
      const text = `Accepted ${accepted.length} ${accepted.length === 1 ? 'suggestion' : 'suggestions'}.`
        + (skipped.length ? ` ${skipped.length} left waiting: ${skipped[0].reason || 'not applied'}.` : '');
      say(text, { undoIds: accepted });
      setLists((cur) => ({ ...cur, done: EMPTY_LIST }));
      await load('waiting');
    } catch (err) {
      setLists((cur) => ({ ...cur, waiting: { rows: before, error: message(err) } }));
    } finally {
      setBulkBusy(false);
    }
  };

  /** Undo from the toast: put the mail back in Waiting. */
  const undoToast = async (t) => {
    setToast(null);
    const results = await Promise.allSettled((t.undoIds || []).map((id) => ticketsAPI.mailReviewUndo(id)));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) say(message(failed.reason), { error: true });
    else say(t.undoIds.length === 1 ? 'Undone. The e-mail is back in Waiting.' : `Undone. ${t.undoIds.length} e-mails are back in Waiting.`);
    setLists((cur) => ({ ...cur, done: EMPTY_LIST }));
    await load('waiting');
    if (live.current.tab === 'done') load('done');
  };

  /** Undo on a Done row. A 409 means it is no longer safe; the server says why in plain words. */
  const undoDone = async (item) => {
    setUndoBusyId(item.heldId);
    setDoneErrors((cur) => ({ ...cur, [item.heldId]: undefined }));
    try {
      await ticketsAPI.mailReviewUndo(item.heldId);
      setLists((cur) => ({ ...cur, done: { ...cur.done, rows: (cur.done.rows || []).filter((r) => r.heldId !== item.heldId) } }));
      say(`Undone. “${item.subject || 'The e-mail'}” is back in Waiting.`);
      load('waiting');
    } catch (err) {
      setDoneErrors((cur) => ({ ...cur, [item.heldId]: message(err) }));
      setAnnounce(`Not undone: ${message(err)}`);
    } finally {
      setUndoBusyId(null);
    }
  };

  const rejudge = async (item) => {
    setRejudging(true);
    try {
      const res = await ticketsAPI.mailReviewRejudge(item.heldId);
      const fresh = res?.data;
      if (fresh) {
        setLists((cur) => ({ ...cur, waiting: { ...cur.waiting, rows: (cur.waiting.rows || []).map((r) => (r.heldId === fresh.heldId ? { ...r, ...fresh } : r)) } }));
        setDetailsItem((cur) => (cur && cur.heldId === fresh.heldId ? { ...cur, ...fresh } : cur));
      }
      ensureDetail(item.heldId);
      setAnnounce('Judged again.');
    } catch (err) {
      setDetailError(message(err));
    } finally {
      setRejudging(false);
    }
  };

  // The key handler reads the latest state through a ref, so it is bound once.
  live.current = { tab, waitingRows, focusedId, openForm, detailsItem, accept, noTicket, toggleForm, openDetails };
  useEffect(() => {
    const onKey = (e) => {
      const st = live.current;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        setBulkOpen(false);
        if (st.openForm) setOpenForm(null);
        else if (st.detailsItem) setDetailsItem(null);
        return;
      }
      // Never steal keys from a field, a menu, the ticket list or the details panel.
      if (typingTarget(e.target) || st.detailsItem || st.openForm) return;
      if (e.key === '?') { e.preventDefault(); setShowKeys((v) => !v); return; }
      if (st.tab !== 'waiting' || !st.waitingRows?.length) return;
      const rows = st.waitingRows;
      const at = Math.max(0, rows.findIndex((r) => r.heldId === st.focusedId));
      const row = rows[at];
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 'j' || key === 'k') {
        e.preventDefault();
        const to = rows[Math.min(rows.length - 1, Math.max(0, at + (key === 'j' ? 1 : -1)))];
        if (to.heldId === st.focusedId) {
          const el = document.querySelector(`[data-held-id="${to.heldId}"]`);
          el?.focus?.({ preventScroll: true });
          el?.scrollIntoView?.({ block: 'nearest' });
        } else {
          moveFocus.current = to.heldId;
          setFocusedId(to.heldId);
        }
      } else if (key === 'a') { e.preventDefault(); st.accept(row); }
      else if (key === 'n') { e.preventDefault(); st.toggleForm(row, 'new'); }
      else if (key === 'd') { e.preventDefault(); st.noTicket(row); }
      else if (key === 'Enter' && !e.target?.closest?.('button, a')) { e.preventDefault(); st.openDetails(row); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const changeLogFilters = (next) => {
    setLogFilters(next);
    load('log', { filters: next });
  };
  const moreLog = () => {
    const rows = lists.log.rows || [];
    if (!rows.length) return;
    setLogInfo((cur) => ({ ...cur, loadingMore: true }));
    load('log', { filters: logFilters, before: logInfo.nextBefore ?? rows[rows.length - 1].id });
  };

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[58px]">
      <AppHeader activePage="tickets" />
      <main className={applyWidth('max-w-6xl mx-auto px-4 sm:px-6 py-5 pb-24 lg:pb-6', layoutWidth)}>
        <MailReviewView
          workspaceName={currentWorkspace?.name || ''}
          tab={tab}
          onTab={setTab}
          meta={meta}
          isAdmin={isAdmin}
          viewerEmail={user?.email || ''}
          waiting={lists.waiting}
          done={lists.done}
          log={lists.log}
          dim={dim}
          focusedId={focusedId}
          openForm={openForm}
          detail={detail}
          detailError={detailError}
          rowErrors={rowErrors}
          sureRows={sureRows}
          bulkBusy={bulkBusy}
          bulkOpen={bulkOpen}
          onBulkToggle={() => setBulkOpen((v) => !v)}
          onBulkAccept={bulkAccept}
          onFocusRow={(item) => setFocusedId(item.heldId)}
          onAccept={accept}
          onOpenForm={toggleForm}
          onPick={pick}
          onCreate={create}
          onNoTicket={noTicket}
          onDetails={openDetails}
          doneErrors={doneErrors}
          undoBusyId={undoBusyId}
          onUndoDone={undoDone}
          logFilters={logFilters}
          onLogFilter={changeLogFilters}
          logStats={logInfo.stats}
          logHasMore={logInfo.hasMore}
          logLoadingMore={logInfo.loadingMore}
          onLogMore={moreLog}
          showKeys={showKeys}
          onToggleKeys={() => setShowKeys((v) => !v)}
          announce={announce}
        />
      </main>
      {detailsItem && (
        <MailDetailsPanel
          item={detailsItem}
          detail={detail}
          error={detailError}
          mode={meta.mode || 'off'}
          isAdmin={isAdmin}
          rejudging={rejudging}
          onRejudge={rejudge}
          onClose={() => setDetailsItem(null)}
        />
      )}
      <ReviewToast toast={toast} onUndo={undoToast} onDismiss={() => setToast(null)} />
      <MobileTabBar />
    </div>
  );
}
