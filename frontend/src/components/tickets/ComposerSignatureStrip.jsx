import { useEffect, useState } from 'react';
import { ChevronDown, PenLine } from 'lucide-react';
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
 * Collapsed read-only strip under the reply editor (Mega 08-15 Phase D):
 * "your signature will be appended" with an expandable preview. The
 * signature is NEVER seeded into the editable area — the server appends it
 * to the outbound email at send time, so drafts can't double-append and the
 * stored thread entry stays clean. Rendered by the host only in reply mode.
 *
 * 18 Sep 2026 (Vahid): open by default, so an agent SEES what goes under the
 * reply before sending, and — because the company signature has no sign-off —
 * a line saying so whenever the signature does not open with one. Collapsing
 * is remembered per browser.
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

  return (
    <div className="mt-1.5 rounded-lg border border-border bg-muted/35" data-testid="composer-signature-strip">
      <button
        type="button"
        onClick={() => setExpanded((prev) => {
          try { window.localStorage.setItem(COLLAPSE_KEY, prev ? '1' : '0'); } catch { /* private window */ }
          return !prev;
        })}
        aria-expanded={expanded}
        className="tp-focus-ring flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground/85"
      >
        <PenLine className="h-3 w-3 flex-shrink-0 text-muted-foreground/75" aria-hidden="true" />
        <span className="min-w-0 truncate">Your signature is added automatically under this reply</span>
        <span className="ml-auto inline-flex items-center gap-0.5 font-semibold text-blue-600 dark:text-blue-300">
          {expanded ? 'Hide' : 'Show'}
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2.5" data-testid="composer-signature-preview">
          {signature.html
            ? <div className="tp-light rounded-md bg-card px-3 py-2"><SafeHtml html={signature.html} /></div>
            : <p className="whitespace-pre-wrap text-xs text-muted-foreground">{signature.text}</p>}
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground" data-testid="composer-signature-hint">
            {signatureHasSignOff(signature)
              ? 'No need to type your name — this goes under your message exactly as shown.'
              : 'It has no sign-off line, so end your message with your own “Thanks,” or “Kind regards,” — then this goes under it exactly as shown.'}
            {' '}Change it under your account menu → Notifications → Signature.
          </p>
        </div>
      )}
    </div>
  );
}
