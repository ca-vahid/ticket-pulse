import { useEffect, useRef, useState } from 'react';
import { ticketsAPI } from '../services/api';

const SAVE_AFTER_MS = 1500;
const MAX_CHARS = 250 * 1024; // larger drafts stay in this browser only
const OTHER = '(a different draft is on the server)';
const syncKey = (ticketId) => `tp_ticket_draft_sync_${ticketId}`;

function readSync(ticketId) {
  try { return JSON.parse(localStorage.getItem(syncKey(ticketId)) || 'null'); } catch { return null; }
}
function writeSync(ticketId, body) {
  try {
    if (body) localStorage.setItem(syncKey(ticketId), JSON.stringify({ body }));
    else localStorage.removeItem(syncKey(ticketId));
  } catch { /* storage unavailable: the draft still saves, lineage is just unknown */ }
}

/** The draft was sent outside the composer's own path (a held reply sent on leaving). */
export function forgetServerDraft(ticketId) {
  writeSync(ticketId, '');
  Promise.resolve().then(() => ticketsAPI.deleteDraft(ticketId)).catch(() => {});
}

/**
 * What to do with the draft on this computer (`local`), given the one on the
 * server and what this computer last saved there (`synced`).
 *   'keep'  — leave the composer as it is
 *   'adopt' — show the server's draft (written later, on another computer)
 *   'drop'  — the draft was sent or cleared elsewhere: empty the composer
 */
export function reconcileDraft({ local, server, synced }) {
  const l = local || '';
  const s = server || '';
  if (!s) return l && synced && synced === l ? 'drop' : 'keep';
  if (!l) return 'adopt';
  if (l === s) return 'keep';
  return synced && synced === l ? 'adopt' : 'keep';
}

/**
 * Keeps a person's unsent reply or note on the server (Nov 2026), so it
 * follows them to another computer. The browser stash stays the first line
 * (instant, works offline); this adds a copy on the server a moment after
 * they stop typing and removes it when the draft is sent or cleared.
 *
 * `restoredBody`: what the browser stash held when this ticket opened ('' for
 * nothing, undefined until it has been read).
 *
 * Nothing here ever blocks typing or sending: every call is best-effort.
 */
export function useServerDraft({
  ticketId, enabled, restoredBody, body, text, cc, mode, onAdopt, onDrop,
}) {
  const [readyFor, setReadyFor] = useState(null);
  const ready = readyFor === ticketId;
  const syncedRef = useRef('');
  const pendingRef = useRef(null); // { ticketId, payload } waiting for the timer
  const liveRef = useRef({});
  liveRef.current = { body, text, onAdopt, onDrop };

  // Flush what is waiting when the ticket changes or the page goes away.
  useEffect(() => () => {
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) Promise.resolve().then(() => ticketsAPI.saveDraft(p.ticketId, p.payload)).then(() => writeSync(p.ticketId, p.payload.body)).catch(() => {});
  }, [ticketId]);

  // On opening a ticket: compare with the server once.
  useEffect(() => {
    syncedRef.current = '';
    if (!enabled || !Number.isFinite(ticketId) || restoredBody === undefined) return undefined;
    let alive = true;
    const synced = readSync(ticketId)?.body || '';
    Promise.resolve().then(() => ticketsAPI.getDraft(ticketId))
      .then((res) => {
        if (!alive) return;
        const server = res?.data || null;
        const now = liveRef.current;
        // Typed since the page opened: what is in hand wins.
        const untouched = now.body === restoredBody || (!restoredBody && !String(now.text || '').trim());
        const verdict = untouched ? reconcileDraft({ local: restoredBody, server: server?.body, synced }) : 'keep';
        if (verdict === 'adopt') {
          syncedRef.current = server.body;
          writeSync(ticketId, server.body);
          now.onAdopt?.(server);
        } else if (verdict === 'drop') {
          writeSync(ticketId, '');
          now.onDrop?.();
        } else if (server?.body) {
          syncedRef.current = server.body === restoredBody ? server.body : OTHER;
        }
        setReadyFor(ticketId);
      })
      // No answer (offline, older server): this browser's stash carries on alone.
      .catch(() => {});
    return () => { alive = false; };
  }, [ticketId, enabled, restoredBody]);

  // After typing stops: save. Emptied (sent or cleared): remove at once.
  useEffect(() => {
    pendingRef.current = null;
    if (!enabled || !ready || (mode !== 'reply' && mode !== 'note')) return undefined;
    if (!text.trim()) {
      if (syncedRef.current) {
        syncedRef.current = '';
        writeSync(ticketId, '');
        Promise.resolve().then(() => ticketsAPI.deleteDraft(ticketId)).catch(() => {});
      }
      return undefined;
    }
    if (body === syncedRef.current || body.length > MAX_CHARS) return undefined;
    const payload = { mode, body, cc: Array.isArray(cc) ? cc : [] };
    pendingRef.current = { ticketId, payload };
    const timer = setTimeout(() => {
      if (pendingRef.current?.payload !== payload) return;
      pendingRef.current = null;
      Promise.resolve().then(() => ticketsAPI.saveDraft(ticketId, payload))
        .then(() => { syncedRef.current = body; writeSync(ticketId, body); })
        .catch(() => {});
    }, SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ticketId, enabled, ready, body, text, cc, mode]);
}
