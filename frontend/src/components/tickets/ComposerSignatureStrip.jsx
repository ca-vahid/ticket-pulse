import { useEffect, useState } from 'react';
import { agentAPI } from '../../services/api';
import { SafeHtml } from './ticketUi';

// One GET per composer open, cached briefly per workspace so switching
// reply/note or hopping tickets doesn't refetch (Phase D: fetch lazily).
const CACHE_TTL_MS = 60_000;
const signatureCache = new Map(); // workspaceId|'' → { promise, at }

export function clearSignatureStripCache() {
  signatureCache.clear();
}

function fetchSignature(workspaceId) {
  // Defensive: hosts under test may mock the api module without agentAPI.
  if (typeof agentAPI?.getMySignature !== 'function') return Promise.resolve(null);
  const key = String(workspaceId || '');
  const cached = signatureCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.promise;
  const promise = agentAPI.getMySignature(workspaceId ? { workspaceId } : {})
    .then((res) => res.data || null)
    .catch(() => null);
  signatureCache.set(key, { promise, at: Date.now() });
  return promise;
}

/**
 * The agent's signature, read-only, under the reply (Mega 08-15 Phase D). The
 * signature is NEVER seeded into the editable area — the server appends it
 * to the outbound email at send time, so drafts can't double-append and the
 * stored thread entry stays clean. Rendered by the host only in reply mode.
 *
 * 18 Sep 2026 (Vahid): shown by default, so an agent SEES what goes under the
 * reply before sending, and — because the company signature has no sign-off —
 * a line saying so whenever the signature does not open with one. Hiding it
 * is remembered per browser.
 *
 * QA 10-09 #4: no box of its own any more. The host passes it as the editor's
 * `footer`, so it sits inside the editor frame straight under the message, in
 * the body's padding and type — the composer reads like the e-mail the
 * requester receives. One quiet caption under it says it is automatic.
 */
const COLLAPSE_KEY = 'tp.composerSignature.collapsed';
const SIGN_OFF_RE = /^\s*(kind |best |warm |with )?(regards|thanks|thank you|cheers|sincerely|best|respectfully)\b/i;

function readCollapsed() {
  try { return window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

/** Does the signature already open with "Kind regards," or similar? */
export function signatureHasSignOff(signature) {
  const text = String(signature?.text || String(signature?.html || '').replace(/<[^>]+>/g, ' ')).replace(/&nbsp;/g, ' ');
  return SIGN_OFF_RE.test(text);
}

export default function ComposerSignatureStrip({ workspaceId }) {
  const [signature, setSignature] = useState(null);
  const [expanded, setExpanded] = useState(() => !readCollapsed());

  useEffect(() => {
    let cancelled = false;
    fetchSignature(workspaceId).then((data) => {
      if (!cancelled) setSignature(data);
    });
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (!signature?.enabled || !String(signature.html || signature.text || '').trim()) return null;

  const toggle = () => setExpanded((prev) => {
    try { window.localStorage.setItem(COLLAPSE_KEY, prev ? '1' : '0'); } catch { /* private window */ }
    return !prev;
  });
  const quietLink = 'tp-focus-ring rounded font-medium text-muted-foreground hover:text-foreground hover:underline';

  return (
    <div className="cursor-default px-3 pb-2.5" data-testid="composer-signature-strip">
      {expanded && (
        <div
          role="group"
          aria-label="Your signature — added automatically when the reply is sent, not editable here"
          data-testid="composer-signature-preview"
        >
          {/* Same sanitising as a thread body (SafeHtml); themed, so it reads on
              the composer's own ground in dark mode instead of a white well. */}
          {signature.html
            ? <SafeHtml html={signature.html} preferThemed className="!text-foreground" />
            : <p className="whitespace-pre-wrap text-sm text-foreground">{signature.text}</p>}
        </div>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/75" data-testid="composer-signature-caption">
        {expanded ? 'Signature, added automatically' : 'Your signature is added automatically under this reply'}
        {' · '}
        <a href="/profile" target="_blank" rel="noreferrer" title="Your profile → Email signature (opens in a new tab)" className={quietLink}>Change</a>
        {' · '}
        <button type="button" onClick={toggle} aria-expanded={expanded} aria-label={expanded ? 'Hide signature' : 'Show signature'} className={quietLink}>
          {expanded ? 'Hide' : 'Show'}
        </button>
        {expanded && !signatureHasSignOff(signature) && (
          <span data-testid="composer-signature-hint">
            {' · '}It has no sign-off line, so end your message with your own “Thanks,” or “Kind regards,”.
          </span>
        )}
      </p>
    </div>
  );
}
