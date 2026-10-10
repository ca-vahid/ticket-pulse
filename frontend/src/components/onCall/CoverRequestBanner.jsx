import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { urgentResponseAPI } from '../../services/api';
import { coverCommitment } from '../../utils/onCallFormat';
import { COVER_CHANGED_EVENT, TakeCoverDialog, answerCoverRequest, coverRequestSentence } from './coverRequests';

/**
 * App-wide on-call cover prompt (plans/URGENT_RESPONSE_PLAN.md). When a cover
 * request is waiting for the signed-in person, one slim line sits just under
 * the header on every page: who needs cover, when, and the three ways to
 * answer. Checked on load and every 10 minutes; a failed check shows nothing.
 * Dismissing hides that request for this browser session only.
 */

export const COVER_POLL_MS = 10 * 60 * 1000;
const DISMISSED_KEY = 'tp_coverRequestsDismissed';
const NOTE_MS = 8000;

// Never on the sign-in pages or the public token pages (no session there).
const HIDDEN_PREFIXES = [
  '/login', '/auth/', '/workspace', '/summit/', '/ticket-status/', '/ticket-escalation/', '/ticket-urgency/',
  '/feedback/', '/approval/', '/approval-reply/',
];
// The page itself lists the requests in full.
const OWN_PAGE = '/on-call';

function readDismissed() {
  try {
    const list = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || '[]');
    return Array.isArray(list) ? list.map(String) : [];
  } catch { return []; }
}

function writeDismissed(list) {
  try { sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(list)); } catch { /* private window */ }
}

const linkClass = 'tp-focus-ring rounded px-1 py-0.5 text-sm font-semibold text-primary hover:underline disabled:opacity-50';

export default function CoverRequestBanner() {
  const { isAuthenticated } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { pathname } = useLocation();
  const wsId = currentWorkspace?.id || null;
  const hiddenHere = pathname === OWN_PAGE || HIDDEN_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p));
  const active = Boolean(isAuthenticated && wsId && !hiddenHere);

  const [requests, setRequests] = useState([]);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { tone: 'ok' | 'info' | 'error', text }
  const noteTimer = useRef(null);

  const load = useCallback(() => {
    urgentResponseAPI.myCoverRequests()
      .then((res) => setRequests(Array.isArray(res?.data) ? res.data : []))
      .catch(() => { /* silent: the prompt is a convenience */ });
  }, []);

  useEffect(() => {
    if (!active) { setRequests([]); return undefined; }
    load();
    const timer = setInterval(load, COVER_POLL_MS);
    window.addEventListener(COVER_CHANGED_EVENT, load);
    return () => {
      clearInterval(timer);
      window.removeEventListener(COVER_CHANGED_EVENT, load);
    };
  }, [active, wsId, load]);

  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);

  const say = (tone, text) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    setNote({ tone, text });
    if (tone !== 'error') noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const answer = async (request, choice) => {
    setBusy(true);
    const result = await answerCoverRequest(request, choice);
    setBusy(false);
    setConfirming(null);
    if (result.outcome === 'error') { say('error', result.message); return; }
    setRequests((list) => list.filter((r) => r.id !== request.id));
    if (result.outcome === 'accepted') say('ok', `Thank you. ${coverCommitment(request)}`);
    else if (result.outcome === 'taken') say('info', 'Someone else already took it. Nothing more for you to do.');
    else setNote(null);
  };

  const dismiss = (request) => {
    const next = [...new Set([...dismissed, String(request.id)])];
    setDismissed(next);
    writeDismissed(next);
  };

  if (!active) return null;
  const request = requests.find((r) => !dismissed.includes(String(r.id))) || null;
  if (!request && !note) return null;

  const dot = note?.tone === 'ok' ? 'bg-emerald-500 dark:bg-emerald-400' : note?.tone === 'error' ? 'bg-red-500 dark:bg-red-400' : 'bg-amber-500 dark:bg-amber-400';

  return (
    <>
      <div
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[45] flex justify-center px-3 md:bottom-4 md:justify-end md:pr-4 print:hidden"
        data-testid="cover-request-banner"
      >
        <div
          role={note?.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className="pointer-events-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3.5 py-2 text-sm text-foreground shadow-soft animate-fadeIn"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
          {note ? (
            <>
              <span className="min-w-0 flex-1">{note.text}</span>
              <button type="button" onClick={() => setNote(null)} aria-label="Close this message" className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 basis-56">
                {coverRequestSentence(request)} Can you take it?
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(request)}
                  className="tp-focus-ring inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Take it
                </button>
                <button type="button" disabled={busy} onClick={() => answer(request, 'decline')} className={linkClass}>Not this time</button>
                <Link to={`/on-call?request=${encodeURIComponent(request.id)}`} className={linkClass}>See schedule</Link>
                <button
                  type="button"
                  onClick={() => dismiss(request)}
                  aria-label="Hide this request for now"
                  title="Hide for now"
                  className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </span>
            </>
          )}
        </div>
      </div>
      <TakeCoverDialog
        request={confirming}
        onConfirm={() => { if (confirming && !busy) answer(confirming, 'accept'); }}
        onCancel={() => { if (!busy) setConfirming(null); }}
      />
    </>
  );
}
