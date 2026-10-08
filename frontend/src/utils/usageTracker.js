import { matchPath } from 'react-router-dom';
import { API_BASE_URL, getAuthToken, getWorkspaceId } from '../services/api';
import { APP_VERSION } from '../data/changelog';

/**
 * Site stats, browser side (Settings -> Site stats is the reader).
 *
 * Reports which page a signed-in person has open and for how long. It sends
 * page NAMES ("tickets.detail"), never a URL, an id or anything typed.
 *
 *   - open time    : the tab is visible.
 *   - engaged time : the tab is visible and there was input in the last minute.
 *   - a visit      : ends after 30 minutes without input, or at 24 hours; one
 *                    visit covers every tab of this browser.
 *
 * One small request a minute per visible tab, and one when the tab is hidden
 * or closed. Failures are swallowed: this must never show an error or slow a
 * page down.
 */

// Every signed-in route in App.jsx, most specific first. `key` is what is
// stored; `label` is what Site stats shows. A :tab parameter becomes the
// section. Public token pages are deliberately absent (their URL is a secret).
export const TRACKED_ROUTES = [
  { path: '/tickets/new', key: 'tickets.new', label: 'New ticket' },
  { path: '/tickets/:id', key: 'tickets.detail', label: 'Ticket' },
  { path: '/tickets', key: 'tickets.list', label: 'Tickets list' },
  { path: '/approvals/:tab', key: 'approvals', label: 'Approvals' },
  { path: '/approvals', key: 'approvals', label: 'Approvals' },
  { path: '/requesters/:id', key: 'requesters.detail', label: 'Requester' },
  { path: '/knowledge/:tab/:itemId', key: 'knowledge', label: 'Knowledge' },
  { path: '/knowledge/:tab', key: 'knowledge', label: 'Knowledge' },
  { path: '/knowledge', key: 'knowledge', label: 'Knowledge' },
  { path: '/onboarding/:tab', key: 'onboarding', label: 'Onboarding' },
  { path: '/onboarding', key: 'onboarding', label: 'Onboarding' },
  { path: '/availability/:tab', key: 'availability', label: 'Availability' },
  { path: '/availability', key: 'availability', label: 'Availability' },
  { path: '/dashboard', key: 'dashboard', label: 'Dashboard' },
  { path: '/technician/:id', key: 'technician.detail', label: 'Technician' },
  { path: '/settings', key: 'settings', label: 'Settings' },
  { path: '/visuals', key: 'visuals', label: 'Visuals' },
  { path: '/timeline', key: 'timeline', label: 'Timeline' },
  { path: '/analytics/category-map', key: 'analytics.category-map', label: 'Analytics: category map' },
  { path: '/analytics', key: 'analytics', label: 'Analytics' },
  { path: '/workflows/:tab', key: 'workflows', label: 'Mail workflows' },
  { path: '/workflows', key: 'workflows', label: 'Mail workflows' },
  { path: '/summit-taxonomy', key: 'summit.taxonomy', label: 'Summit taxonomy' },
  { path: '/assignments/run/:runId', key: 'assignments.run', label: 'Assignment run' },
  { path: '/assignments/history/:historyRunId', key: 'assignments.history', label: 'Assignment history run' },
  { path: '/assignments/live/:ticketId', key: 'assignments.live', label: 'Assignment live run' },
  { path: '/assignments/competency-run/:competencyRunId', key: 'assignments.competency-run', label: 'Competency run' },
  { path: '/assignments/competency-live/:analyzeTechId', key: 'assignments.competency-live', label: 'Competency live run' },
  { path: '/assignments/:tab', key: 'assignments', label: 'Assignment review' },
  { path: '/assignments', key: 'assignments', label: 'Assignment review' },
  { path: '/my-competencies', key: 'competencies', label: 'My competencies' },
  { path: '/mail-alerts', key: 'alerts', label: 'My alerts' },
  { path: '/profile', key: 'profile', label: 'Profile' },
  { path: '/workspace', key: 'workspace.picker', label: 'Workspace picker' },
];

const SECTION_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const cleanSection = (value) => {
  const s = String(value || '').toLowerCase();
  return SECTION_RE.test(s) ? s : '';
};

/** The stored name of a location, or null when the page is not tracked. */
export function resolvePage({ pathname = '', hash = '', search = '' } = {}) {
  for (const route of TRACKED_ROUTES) {
    const match = matchPath({ path: route.path, end: true }, pathname);
    if (!match) continue;
    let section = cleanSection(match.params?.tab);
    // Settings sections are URL hashes, not paths.
    if (route.key === 'settings') section = cleanSection(String(hash).replace(/^#/, '').split(/[?&/]/)[0]);
    // The peek preview is a query parameter on the list.
    if (route.key === 'tickets.list' && /[?&]peek=/.test(String(search))) section = 'peek';
    return { key: route.key, section };
  }
  return null;
}

export function pageLabel(key, section = '') {
  const route = TRACKED_ROUTES.find((r) => r.key === key);
  const base = route ? route.label : key;
  return section ? `${base}: ${section}` : base;
}

export function viewportBand(width) {
  if (width < 640) return 'phone';
  if (width < 1024) return 'tablet';
  if (width < 1440) return 'laptop';
  if (width < 1920) return 'desktop';
  return 'wide';
}

export const VISIT_IDLE_MS = 30 * 60 * 1000;
export const VISIT_CAP_MS = 24 * 60 * 60 * 1000;
export const INPUT_WINDOW_MS = 60 * 1000;
export const TICK_MS = 5 * 1000;
export const SEND_MS = 60 * 1000;
const VISIT_KEY = 'tp_usage_visit';

function newId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/**
 * The tracker. `env` is injectable so the rules can be tested without a
 * browser: now(), storage (get/set), visible(), send(body), width().
 */
export function createUsageTracker(env = {}) {
  const now = env.now || (() => Date.now());
  const visible = env.visible || (() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const width = env.width || (() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const workspace = env.workspace || (() => getWorkspaceId());
  const storage = env.storage || {
    get: () => { try { return JSON.parse(localStorage.getItem(VISIT_KEY) || 'null'); } catch { return null; } },
    set: (value) => { try { localStorage.setItem(VISIT_KEY, JSON.stringify(value)); } catch { /* private mode */ } },
  };
  const send = env.send || ((body) => {
    try {
      const token = getAuthToken();
      fetch(`${API_BASE_URL}/usage/batch`, {
        method: 'POST',
        keepalive: true,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch { /* never surface */ }
  });

  let page = null; // { id, t, key, section, ws, eng, open, identity, sent }
  let queue = [];
  let visitId = null;
  let lastInput = 0;
  let lastTick = now();

  /** The current visit id; `active` extends the visit (input or a new page). */
  function visit(active) {
    const t = now();
    let v = storage.get();
    const stale = !v || !v.id || t - v.last > VISIT_IDLE_MS || t - v.started > VISIT_CAP_MS;
    if (stale) {
      if (!active && v?.id) return v.id; // an idle tab does not start a visit
      v = { id: newId(), started: t, last: t };
      storage.set(v);
    } else if (active) {
      v.last = t;
      storage.set(v);
    }
    return v.id;
  }

  const snapshot = (p) => ({
    id: p.id, t: p.t, kind: 'page', key: p.key, section: p.section, ws: p.ws,
    eng: Math.round(p.eng / 1000), open: Math.round(p.open / 1000),
  });

  function closePage() {
    if (!page) return;
    tick();
    queue.push(snapshot(page));
    page = null;
  }

  function openPage({ key, section = '', identity }) {
    visitId = visit(true);
    lastInput = now();
    lastTick = now(); // time before this page opened belongs to nobody
    page = { id: newId(), t: now(), key, section, ws: Number(workspace()) || 0, eng: 0, open: 0, identity, sent: -1 };
  }

  /** A navigation. The same page and section again (a filter change) is not a new view. */
  function pageView({ key, section = '', identity }) {
    const id = identity || `${key}|${section}`;
    if (page && page.identity === id) return;
    closePage();
    openPage({ key, section, identity: id });
  }

  function tick() {
    const t = now();
    // A laptop that slept reports one long gap; never credit more than two ticks.
    const dt = Math.min(Math.max(t - lastTick, 0), TICK_MS * 2);
    lastTick = t;
    if (!page || !visible()) return;
    page.open += dt;
    if (t - lastInput <= INPUT_WINDOW_MS) page.eng += dt;
  }

  function input() {
    lastInput = now();
    if (!page) return;
    const id = visit(true);
    if (visitId && id !== visitId) {
      // Back after more than 30 minutes: a new visit starts with a fresh view of this page.
      const again = { key: page.key, section: page.section, identity: page.identity };
      closePage();
      openPage(again);
    }
    visitId = id;
  }

  function flush() {
    tick();
    const events = queue;
    queue = [];
    if (page) {
      const total = page.eng + page.open;
      if (total !== page.sent) { events.push(snapshot(page)); page.sent = total; }
    }
    if (!events.length) return 0;
    send({ sentAt: now(), visitId: visitId || visit(false), appVersion: APP_VERSION, viewport: viewportBand(width()), events });
    return events.length;
  }

  function reset() { closePage(); flush(); }

  return { pageView, closePage, tick, input, flush, reset, _state: () => ({ page, queue, visitId }) };
}

// ---------------------------------------------------------------------------
// Browser wiring: one tracker per tab.
// ---------------------------------------------------------------------------
let shared = null;
let stopFns = [];

export function startUsageTracking() {
  if (shared || typeof window === 'undefined') return shared;
  shared = createUsageTracker();
  let lastMove = 0;
  const onInput = () => shared?.input();
  // Pointer moves arrive by the hundred; one a second is plenty.
  const onMove = () => { const t = Date.now(); if (t - lastMove > 1000) { lastMove = t; shared?.input(); } };
  const onHide = () => { if (document.visibilityState === 'hidden') shared?.flush(); else shared?.tick(); };
  const onPageHide = () => shared?.flush();
  const passive = { passive: true, capture: true };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, onInput, passive);
  window.addEventListener('pointermove', onMove, passive);
  window.addEventListener('scroll', onMove, passive);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  const tickTimer = setInterval(() => shared?.tick(), TICK_MS);
  const sendTimer = setInterval(() => { if (document.visibilityState === 'visible') shared?.flush(); }, SEND_MS);
  stopFns = [
    () => { for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(type, onInput, passive); },
    () => window.removeEventListener('pointermove', onMove, passive),
    () => window.removeEventListener('scroll', onMove, passive),
    () => document.removeEventListener('visibilitychange', onHide),
    () => window.removeEventListener('pagehide', onPageHide),
    () => clearInterval(tickTimer),
    () => clearInterval(sendTimer),
  ];
  return shared;
}

export function stopUsageTracking() {
  if (!shared) return;
  try { shared.reset(); } catch { /* ignore */ }
  for (const fn of stopFns) fn();
  stopFns = [];
  shared = null;
}

export function trackPage(location) {
  if (!shared) return;
  try {
    const resolved = resolvePage(location);
    if (resolved) shared.pageView({ ...resolved, identity: `${location.pathname}|${resolved.section}` });
    else shared.closePage();
  } catch { /* never surface */ }
}
