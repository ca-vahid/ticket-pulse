import { useEffect, useState } from 'react';
import { replyWarningAPI } from '../../services/api';

/**
 * Does the requester read replies? (22 Nov 2026) Drives the quiet line above
 * the reply composer (ReplyAudienceWarning):
 *   - unattended: the requester flag behind 4.3.97's guards (an alert or
 *     integration mailbox). Known from the ticket itself, so no request.
 *   - machine_sender: the address is on this workspace's no-reply list
 *     (machineSenderService), asked once per ticket open and cached.
 * A warning, never a block: the composer works the same while it loads and if
 * the check fails. The server still refuses FreshService-lane replies to an
 * unattended requester (4.3.97).
 */
export const REPLY_WARNING_TEXT = Object.freeze({
  machine_sender: 'This address doesn’t read replies (it’s an automated sender). Add a private note instead, or reply to a person in Cc.',
  unattended: 'This requester is an automated system and doesn’t read replies. Add a private note instead.',
});

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // ticketId -> { at, kind } | { at, promise }

function fresh(entry) {
  return entry && Date.now() - entry.at < TTL_MS;
}

/** The cached answer for a ticket: a kind, null (reads replies) or undefined (not known yet). */
function cachedKind(ticketId) {
  const hit = cache.get(ticketId);
  return fresh(hit) && 'kind' in hit ? hit.kind : undefined;
}

/** Ask once per ticket; concurrent callers share the request. Never rejects. */
export function loadReplyWarning(ticketId) {
  const hit = cache.get(ticketId);
  if (fresh(hit)) return 'kind' in hit ? Promise.resolve(hit.kind) : hit.promise;
  const promise = Promise.resolve()
    .then(() => replyWarningAPI.get(ticketId))
    .then((res) => {
      const kind = res?.data?.kind === 'machine_sender' || res?.data?.kind === 'unattended' ? res.data.kind : null;
      cache.set(ticketId, { at: Date.now(), kind });
      return kind;
    })
    .catch(() => {
      // A failed check means no warning; the next ticket open asks again.
      cache.delete(ticketId);
      return null;
    });
  cache.set(ticketId, { at: Date.now(), promise });
  return promise;
}

export function resetReplyWarningCache() {
  cache.clear();
}

/** 'unattended' | 'machine_sender' | null for this ticket's requester. */
export function useReplyWarning(ticketId, { unattended = false, hasRequester = true, enabled = true } = {}) {
  const ask = enabled && !unattended && hasRequester && Boolean(ticketId);
  const [state, setState] = useState(() => ({ ticketId, kind: ask ? cachedKind(ticketId) ?? null : null }));
  useEffect(() => {
    if (!ask) return undefined;
    let live = true;
    const known = cachedKind(ticketId);
    if (known !== undefined) {
      setState({ ticketId, kind: known });
      return undefined;
    }
    loadReplyWarning(ticketId).then((kind) => { if (live) setState({ ticketId, kind }); });
    return () => { live = false; };
  }, [ask, ticketId]);
  if (unattended) return 'unattended';
  if (!ask || state.ticketId !== ticketId) return null;
  return state.kind;
}
