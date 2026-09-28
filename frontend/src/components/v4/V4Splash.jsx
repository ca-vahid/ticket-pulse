import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { isWorkspaceAdmin, useWorkspaceRole } from '../nav/navDestinations';

/**
 * Ticket Pulse 4 — "now with Knowledge" (v4.0.01, 27 Sep 2026). A one-time
 * welcome for workspace admins that points them at the Knowledge section.
 * Seen state is per browser (a convenience, not a record): an admin on a new
 * machine sees it once more, which is fine for a launch screen. Reopened from
 * the account menu via the `tp:open-v4-splash` window event.
 * Artwork: public/brand/v4 (gpt-image-2.5-sunburst).
 */
export const V4_SPLASH_KEY = 'tp_v4_splash_seen';
export const V4_SPLASH_EVENT = 'tp:open-v4-splash';
export const V4_SPLASH_VERSION = '4.0';

// Pages that are not the signed-in app: never cover them.
const HIDDEN_PATHS = /^\/(login|auth|summit|ticket-status|ticket-escalation|ticket-urgency|approval|workspaces?|select-workspace)(\/|$)/i;

export const V4_FEATURES = [
  { icon: 'articles', title: 'Articles', text: 'The answers the team stands behind, written once and reused everywhere.' },
  { icon: 'playbooks', title: 'Playbooks', text: 'Per category: when to help, what to say, which knowledge to quote.' },
  { icon: 'autohelp', title: 'Auto-help', text: 'Drafts a first answer the moment a ticket settles. You approve before it sends.' },
  { icon: 'gaps', title: 'Gaps', text: 'The questions nobody has written up yet, grouped from real tickets.' },
  { icon: 'followup', title: 'Follow-ups', text: 'Checks in after an answer and closes quietly when it worked.' },
  { icon: 'quiet', title: 'Stay quiet', text: 'Rules for when Auto-help must keep out of it, per playbook and workspace.' },
];

function readSeen() {
  try { return window.localStorage.getItem(V4_SPLASH_KEY) === V4_SPLASH_VERSION; } catch { return false; }
}
function writeSeen() {
  try { window.localStorage.setItem(V4_SPLASH_KEY, V4_SPLASH_VERSION); } catch { /* private window: shows again next time */ }
}

export function openV4Splash() {
  window.dispatchEvent(new Event(V4_SPLASH_EVENT));
}

export default function V4Splash() {
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const wsRole = useWorkspaceRole();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const primaryRef = useRef(null);

  const eligible = Boolean(user && currentWorkspace?.id && isWorkspaceAdmin(user, wsRole))
    && !HIDDEN_PATHS.test(location.pathname);

  useEffect(() => {
    if (eligible && !readSeen()) setOpen(true);
  }, [eligible]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(V4_SPLASH_EVENT, onOpen);
    return () => window.removeEventListener(V4_SPLASH_EVENT, onOpen);
  }, []);

  const close = useCallback(() => { writeSeen(); setOpen(false); }, []);

  useEffect(() => {
    if (!open) return undefined;
    primaryRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open || !user) return null;

  const explore = () => { close(); navigate('/knowledge'); };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-slate-950/55 backdrop-blur-sm animate-fadeIn" onClick={close} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="v4-splash-title"
        aria-describedby="v4-splash-lead"
        className="relative w-full max-w-3xl max-h-[92vh] overflow-y-auto settings-scrollbar rounded-2xl border border-border bg-card text-card-foreground shadow-soft animate-scaleIn"
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-full bg-card/80 p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground tp-focus-ring"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="relative overflow-hidden rounded-t-2xl">
          <img
            src="/brand/v4/hero-light.webp"
            srcSet="/brand/v4/hero-light-768.webp 768w, /brand/v4/hero-light.webp 1536w"
            sizes="(max-width: 800px) 100vw, 768px"
            alt=""
            className="block aspect-[3/2] max-h-[300px] w-full object-cover object-center dark:hidden"
          />
          <img
            src="/brand/v4/hero-dark.webp"
            srcSet="/brand/v4/hero-dark-768.webp 768w, /brand/v4/hero-dark.webp 1536w"
            sizes="(max-width: 800px) 100vw, 768px"
            alt=""
            className="hidden aspect-[3/2] max-h-[300px] w-full object-cover object-center dark:block"
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card to-transparent" />
        </div>

        <div className="relative -mt-10 px-5 pb-5 sm:px-8 sm:pb-7">
          <div className="flex items-center gap-3">
            <img src="/brand/v4/emblem-128.png" alt="" className="h-16 w-16 flex-none drop-shadow-md" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Version 4</p>
              <h2 id="v4-splash-title" className="text-2xl font-bold leading-tight text-foreground sm:text-3xl">
                Ticket Pulse, now with{' '}
                <span className="bg-gradient-to-r from-[#6D4AFF] to-[#14B8A6] bg-clip-text text-transparent">Knowledge</span>
              </h2>
            </div>
          </div>
          <p id="v4-splash-lead" className="mt-3 max-w-2xl text-sm text-muted-foreground sm:text-[15px]">
            Ticket Pulse has always shown you the pulse of the queue. Version 4 adds what the team knows: articles,
            playbooks and Auto-help that drafts the first answer from them. Nothing reaches a requester unless an agent sends it.
          </p>

          <ul className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {V4_FEATURES.map((f) => (
              <li key={f.icon} className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-3">
                <img src={`/brand/v4/${f.icon}.png`} srcSet={`/brand/v4/${f.icon}.png 1x, /brand/v4/${f.icon}@2x.png 2x`} alt="" className="h-10 w-10 flex-none" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{f.title}</p>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{f.text}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-6 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground sm:max-w-[18rem]">Auto-help starts in shadow mode: it drafts, and nothing is sent until you say so.</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <button
                type="button"
                onClick={close}
                className="whitespace-nowrap rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted tp-focus-ring"
              >
                Maybe later
              </button>
              <button
                ref={primaryRef}
                type="button"
                onClick={explore}
                className="inline-flex whitespace-nowrap items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#6D4AFF] to-[#0EA5A4] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110 tp-focus-ring"
              >
                Explore Knowledge
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
