/**
 * Mail Workflows editor — leave guard + local draft autosave (QA 11-05 #3).
 *
 * The editor keeps its working copy in memory until "Save & publish". This
 * module stops that copy from being lost by accident:
 *
 *  - `useLeaveGuard` holds every way out of the editor while it has unsaved
 *    changes. The app uses <BrowserRouter> (not a data router), so React
 *    Router's `useBlocker` is not available. Instead:
 *      · in-app navigation (side rail, links, header buttons — anything that
 *        calls `navigate()`) is held by wrapping the router's navigator
 *        (push / replace / go) while dirty;
 *      · the browser's Back button is held by a same-address "guard" history
 *        entry: Back lands on the entry beneath it (same page, nothing
 *        changes), the guard is put back and the dialog asks;
 *      · reload, tab close and full-page jumps (the workspace switch reloads
 *        the page) get the browser's own `beforeunload` prompt — the one
 *        browser dialog that cannot be replaced.
 *    Limit: a long-press Back that jumps several entries at once leaves the
 *    page; the autosaved draft below is the net for that case.
 *  - The local draft: while dirty the working copy is written to
 *    localStorage every few seconds (per workspace + workflow id, with the
 *    saved version it was based on). Reopening the workflow offers it back as
 *    an inline line, never automatically.
 */
import { useCallback, useContext, useEffect, useRef } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { AlertCircle, FilePen, History, X } from 'lucide-react';
import { formatPacificFull, formatPacificWhen } from '../../utils/ticketDates';

export const WORKFLOW_DRAFT_AUTOSAVE_MS = 3000;
const DRAFT_KEY_PREFIX = 'tp:wf-draft:v1';
export const LEAVE_GUARD_STATE_KEY = 'tpWfLeaveGuard';

/* ------------------------------------------------------------------ */
/* Local draft storage                                                 */
/* ------------------------------------------------------------------ */

/** One draft per workspace + workflow. New workflows are created on the server
 * before the editor opens, so there is always an id (no "new" slot needed). */
export function workflowDraftStorageKey(workspaceId, workflowId) {
  if (workflowId === null || workflowId === undefined || workflowId === '') return null;
  return `${DRAFT_KEY_PREFIX}:ws${workspaceId ?? 'current'}:wf${workflowId}`;
}

/** Short stable hash of a definition fingerprint — "the version it was based on". */
export function hashFingerprint(text) {
  const value = String(text || '');
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 33) ^ value.charCodeAt(index)) >>> 0;
  }
  return `${value.length.toString(36)}-${hash.toString(36)}`;
}

export function readStoredWorkflowDraft(key) {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || !record.definition || typeof record.definition !== 'object') return null;
    return record;
  } catch {
    return null;
  }
}

export function writeStoredWorkflowDraft(key, record) {
  if (!key || !record) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false; // private window, quota, blocked storage — the guard still works
  }
}

export function clearStoredWorkflowDraft(key) {
  if (!key) return;
  try { window.localStorage.removeItem(key); } catch { /* nothing to clear */ }
}

/**
 * QA 11-05b #1c: every local draft this browser holds for one workspace,
 * newest first — `{ key, workflowId, savedAt, definition }`. Blocked or
 * broken storage gives an empty list.
 */
export function listStoredWorkflowDrafts(workspaceId) {
  const prefix = `${DRAFT_KEY_PREFIX}:ws${workspaceId ?? 'current'}:wf`;
  const out = [];
  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const workflowId = key.slice(prefix.length);
      if (!/^\d+$/.test(workflowId)) continue;
      const record = readStoredWorkflowDraft(key);
      if (!record) continue;
      out.push({ key, workflowId, savedAt: record.savedAt || null, definition: record.definition });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
}

/**
 * What to offer for a stored draft, given the saved definition now on the
 * server. Returns null when there is nothing worth offering (no draft, or the
 * draft is the same as what is saved).
 *
 * `stale` — the workflow was saved after the draft was started, so restoring
 * would replace those newer saved changes. Never restored automatically.
 */
export function draftRestoreOffer({ record, savedFingerprint, fingerprintOf }) {
  if (!record || !record.definition) return null;
  const draftPrint = fingerprintOf(record.definition);
  if (!draftPrint || draftPrint === savedFingerprint) return null;
  return {
    definition: record.definition,
    savedAt: record.savedAt || null,
    stale: Boolean(record.baseHash) && record.baseHash !== hashFingerprint(savedFingerprint),
  };
}

const PACIFIC_STAMP = (() => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Vancouver',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
})();

/** "Tue 20 Oct, 9:14 AM" in Pacific time. */
export function formatDraftStamp(iso) {
  if (!iso || !PACIFIC_STAMP) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(PACIFIC_STAMP.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${parts.dayPeriod || ''}`.trim();
}

/* ------------------------------------------------------------------ */
/* Leave guard                                                         */
/* ------------------------------------------------------------------ */

export function onLeaveGuardEntry() {
  try {
    return window.history.state?.[LEAVE_GUARD_STATE_KEY] === true;
  } catch {
    return false;
  }
}

/** A copy of the current history state without the guard marker. */
export function historyStateWithoutGuard() {
  try {
    const state = window.history.state;
    if (!state || typeof state !== 'object') return state ?? null;
    const { [LEAVE_GUARD_STATE_KEY]: _omit, ...rest } = state;
    return rest;
  } catch {
    return null;
  }
}

function currentAddress() {
  return `${window.location.pathname}${window.location.search}`;
}

function pushGuardEntry() {
  try {
    window.history.pushState(
      { ...(window.history.state || {}), [LEAVE_GUARD_STATE_KEY]: true },
      '',
      `${currentAddress()}${window.location.hash}`,
    );
    return currentAddress();
  } catch {
    return null;
  }
}

function targetPathname(to) {
  if (typeof to === 'string') {
    try { return new URL(to, window.location.href).pathname; } catch { return to; }
  }
  return to?.pathname || null;
}

/**
 * Hold every way out while `active`. `isInside(pathname)` says which
 * addresses still keep the editor mounted (its own tabs). `onBlocked` gets
 * `{ kind: 'navigate' | 'back', proceed }`; call `leave(proceed)` to go.
 */
export function useLeaveGuard({ active, isInside = () => false, onBlocked }) {
  const navigationContext = useContext(UNSAFE_NavigationContext);
  const navigator = navigationContext?.navigator || null;
  const onBlockedRef = useRef(onBlocked);
  const isInsideRef = useRef(isInside);
  const bypassRef = useRef(false);
  const guardedAddressRef = useRef(null);
  onBlockedRef.current = onBlocked;
  isInsideRef.current = isInside;

  // Reload / tab close / full-page jumps: the browser's own prompt.
  useEffect(() => {
    if (!active) return undefined;
    bypassRef.current = false;
    const handler = (event) => {
      if (bypassRef.current) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);

  // In-app navigation: everything that goes through the router's navigator.
  useEffect(() => {
    if (!active || !navigator || typeof navigator.push !== 'function') return undefined;
    const original = { push: navigator.push, replace: navigator.replace, go: navigator.go };
    const leaves = (to) => {
      const pathname = targetPathname(to);
      return Boolean(pathname) && !isInsideRef.current(pathname);
    };
    navigator.push = (to, ...rest) => {
      if (bypassRef.current || !leaves(to)) return original.push(to, ...rest);
      onBlockedRef.current?.({
        kind: 'navigate',
        // Leaving from the guard entry replaces it, so Back from the next page
        // returns to the editor instead of a dead duplicate of it.
        proceed: () => (onLeaveGuardEntry() ? original.replace(to, ...rest) : original.push(to, ...rest)),
      });
      return undefined;
    };
    navigator.replace = (to, ...rest) => {
      if (bypassRef.current || !leaves(to)) return original.replace(to, ...rest);
      onBlockedRef.current?.({ kind: 'navigate', proceed: () => original.replace(to, ...rest) });
      return undefined;
    };
    if (typeof original.go === 'function') {
      navigator.go = (delta) => {
        if (bypassRef.current || !(Number(delta) < 0)) return original.go(delta);
        onBlockedRef.current?.({ kind: 'back', proceed: () => original.go(onLeaveGuardEntry() ? delta - 1 : delta) });
        return undefined;
      };
    }
    return () => {
      navigator.push = original.push;
      navigator.replace = original.replace;
      if (original.go) navigator.go = original.go;
    };
  }, [active, navigator]);

  // Browser Back: a guard entry at the same address.
  useEffect(() => {
    if (!active) return undefined;
    guardedAddressRef.current = onLeaveGuardEntry() ? currentAddress() : pushGuardEntry();
    const onPop = () => {
      if (bypassRef.current) return;
      if (onLeaveGuardEntry()) { guardedAddressRef.current = currentAddress(); return; }
      // A jump of several entries already left the editor's address — it
      // cannot be held from here; the autosaved draft covers it.
      if (currentAddress() !== guardedAddressRef.current) return;
      guardedAddressRef.current = pushGuardEntry();
      onBlockedRef.current?.({
        kind: 'back',
        // Past the guard and the entry beneath it: where Back meant to go.
        proceed: () => window.history.go(-2),
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [active]);

  /** Run a confirmed exit without the guard catching it again. */
  const leave = useCallback((proceed) => {
    bypassRef.current = true;
    if (typeof proceed === 'function') proceed();
  }, []);

  /** After a save that stays on the page: drop the guard entry so the next
   * Back does what it says instead of landing on a duplicate address. */
  const consumeGuardEntry = useCallback(() => {
    if (!onLeaveGuardEntry()) return;
    bypassRef.current = true;
    try { window.history.back(); } catch { /* harmless duplicate entry */ }
  }, []);

  return { leave, consumeGuardEntry };
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

/**
 * "Leave without saving?" — Keep editing is the focused default and the
 * primary button; Save draft and leave saves without publishing; Discard
 * throws the unsaved changes away.
 */
export function LeaveWithoutSavingDialog({
  open,
  workflowName = '',
  saving = false,
  error = null,
  saveBlockedReason = null,
  onKeepEditing,
  onSaveAndLeave,
  onDiscard,
}) {
  const keepRef = useRef(null);
  useEffect(() => {
    if (open) keepRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !saving) {
        event.stopPropagation();
        onKeepEditing?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, saving, onKeepEditing]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm dark:bg-black/70" data-testid="workflow-leave-dialog-backdrop">
      <button
        type="button"
        aria-label="Keep editing"
        tabIndex={-1}
        className="absolute inset-0 cursor-default"
        onClick={saving ? undefined : onKeepEditing}
      />
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="workflow-leave-title"
        aria-describedby="workflow-leave-body"
        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-card/70 bg-card shadow-2xl dark:border-white/10"
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h3 id="workflow-leave-title" className="text-base font-semibold text-foreground">Leave without saving?</h3>
            <p id="workflow-leave-body" className="mt-1 text-sm leading-5 text-muted-foreground">
              {workflowName ? <><span className="font-medium text-foreground/85">{workflowName}</span> has changes that are not saved. </> : 'This workflow has changes that are not saved. '}
              A copy is kept in this browser, but other people and other devices will not see it.
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Save draft and leave keeps the changes on the server without publishing. The live version keeps running until you publish.
            </p>
            {saveBlockedReason && (
              <p className="mt-2 text-xs leading-5 text-amber-800 dark:text-amber-200">Can not save yet: {saveBlockedReason}</p>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300">{error}</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/50 px-5 py-3">
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            className="tp-focus-ring mr-auto inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-500/15"
            data-testid="workflow-leave-discard"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onSaveAndLeave}
            disabled={saving || Boolean(saveBlockedReason)}
            title={saveBlockedReason || 'Save as an unpublished draft, then leave'}
            className="tp-focus-ring inline-flex h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-semibold text-foreground/85 hover:bg-muted disabled:opacity-50"
            data-testid="workflow-leave-save"
          >
            {saving ? 'Saving…' : 'Save draft and leave'}
          </button>
          <button
            ref={keepRef}
            type="button"
            onClick={onKeepEditing}
            disabled={saving}
            className="tp-focus-ring inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
            data-testid="workflow-leave-keep"
          >
            Keep editing
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * QA 11-05b #1d: the quiet line on a workflow whose SAVED draft is not
 * published — "This workflow has unpublished changes (saved Thu 5 Nov,
 * 3:12 PM by Alex Rivera). · Publish". There is no diff view for workflows,
 * so there is no "Compare". `onPublish` null hides the action (e.g. while the
 * editor has unsaved edits, the main Save & publish button covers it).
 */
export function UnpublishedChangesLine({
  neverPublished = false,
  savedAt = null,
  savedBy = null,
  onPublish = null,
  publishDisabledReason = null,
  publishing = false,
  now = new Date(),
}) {
  const when = savedAt ? formatPacificWhen(savedAt, now) : null;
  const saved = when || savedBy ? ` (saved${when ? ` ${when}` : ''}${savedBy ? ` by ${savedBy}` : ''})` : '';
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5 text-xs text-muted-foreground"
      data-testid="workflow-unpublished-line"
    >
      <FilePen className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-300" aria-hidden="true" />
      <span title={savedAt ? formatPacificFull(savedAt) : undefined}>
        {neverPublished ? 'This workflow has never been published' : 'This workflow has unpublished changes'}{saved}.
      </span>
      {onPublish && (
        <>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onPublish}
            disabled={publishing || Boolean(publishDisabledReason)}
            title={publishDisabledReason || 'Publish the saved draft as a new version'}
            className="tp-focus-ring rounded font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
            data-testid="workflow-unpublished-publish"
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </>
      )}
    </div>
  );
}

/** Inline "Unsaved changes from Tue 5 Nov, 3:12 PM · Restore · Discard". */
export function DraftRestoreLine({ offer, onRestore, onDiscard, onDismiss }) {
  if (!offer) return null;
  const stamp = formatDraftStamp(offer.savedAt);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-l-2 border-amber-500 bg-amber-50/70 py-1 pl-2.5 pr-1 text-xs text-amber-900 dark:border-amber-400 dark:bg-amber-500/10 dark:text-amber-100"
      data-testid="workflow-draft-restore"
    >
      <History className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium">Unsaved changes{stamp ? ` from ${stamp}` : ''}</span>
      {offer.stale && (
        <span className="text-amber-800 dark:text-amber-200" data-testid="workflow-draft-stale">
          This workflow was saved since — your draft is from an older version.
        </span>
      )}
      <span className="text-amber-700/60 dark:text-amber-200/50" aria-hidden="true">·</span>
      <button type="button" onClick={onRestore} className="tp-focus-ring rounded font-semibold text-primary hover:underline" data-testid="workflow-draft-restore-button">
        Restore
      </button>
      <span className="text-amber-700/60 dark:text-amber-200/50" aria-hidden="true">·</span>
      <button type="button" onClick={onDiscard} className="tp-focus-ring rounded font-semibold text-foreground/85 hover:underline" data-testid="workflow-draft-discard-button">
        Discard
      </button>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Hide for now" className="tp-focus-ring ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-amber-800/70 hover:bg-amber-100 dark:text-amber-200/70 dark:hover:bg-amber-500/20">
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
