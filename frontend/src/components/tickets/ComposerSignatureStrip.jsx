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
 */
export default function ComposerSignatureStrip({ workspaceId }) {
  const [signature, setSignature] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSignature(workspaceId).then((data) => {
      if (!cancelled) setSignature(data);
    });
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (!signature?.enabled || !String(signature.html || signature.text || '').trim()) return null;

  return (
    <div className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50/70" data-testid="composer-signature-strip">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="tp-focus-ring flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-slate-500 hover:text-slate-700"
      >
        <PenLine className="h-3 w-3 flex-shrink-0 text-slate-400" aria-hidden="true" />
        <span className="min-w-0 truncate">— your signature will be appended to the email</span>
        <span className="ml-auto inline-flex items-center gap-0.5 font-semibold text-blue-600">
          {expanded ? 'Hide' : 'Preview'}
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-slate-200 px-2.5 py-2" data-testid="composer-signature-preview">
          {signature.html
            ? <SafeHtml html={signature.html} className="text-xs" />
            : <p className="whitespace-pre-wrap text-xs text-slate-600">{signature.text}</p>}
        </div>
      )}
    </div>
  );
}
