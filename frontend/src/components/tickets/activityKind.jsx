/**
 * Actor-kind chips + machine filter for ticket activity rows (MEGA 09-01
 * Phase RO-2 / TU-2). The API stamps `actorKind` on every activity row
 * (explicit `details.actorKind` or the server-side legacy heuristic); the
 * client fallback below only covers responses from an older backend.
 *
 * Kinds: human | api | freshservice_sync | ai | workflow | system | reconcile | mirror
 */

export const ACTOR_KIND_META = {
  human: {
    label: 'Human',
    title: 'Done by a person in Ticket Pulse',
    tone: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30',
    machine: false,
  },
  api: {
    label: 'API',
    title: 'Done through the public API (Power Apps, integrations)',
    tone: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-200 dark:border-indigo-500/30',
    machine: false,
  },
  freshservice_sync: {
    label: 'FreshService',
    title: 'Observed in FreshService by the sync',
    tone: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-500/30',
    machine: true,
  },
  ai: {
    label: 'AI',
    title: 'Written by the assignment / triage pipeline',
    tone: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-500/30',
    machine: true,
  },
  workflow: {
    label: 'Workflow',
    title: 'Done by a ticket workflow',
    tone: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
    machine: true,
  },
  system: {
    label: 'System',
    title: 'Ticket Pulse housekeeping',
    tone: 'bg-muted text-muted-foreground border-border',
    machine: true,
  },
  reconcile: {
    label: 'System',
    title: 'Reconcile sweep against FreshService',
    tone: 'bg-muted text-muted-foreground border-border',
    machine: true,
  },
  mirror: {
    label: 'System',
    title: 'Fallback-mirror bookkeeping',
    tone: 'bg-muted text-muted-foreground border-border',
    machine: true,
  },
};

const MACHINE_NAMES = new Set([
  'system', 'freshservice', 'mirror reconciliation', 'ticket pulse', 'ticket workflow',
  'notification workflow', 'ticket pulse duplicate guard', 'ticket pulse mail',
]);
const FS_SOURCES = new Set(['assignment_fast_sync', 'freshservice_sync', 'freshservice_sync_snapshot', 'freshservice_activity', 'freshservice_webhook']);

/** Kind of an activity row — trusts the API's `actorKind`, else a light legacy heuristic. */
export function activityActorKind(a) {
  if (!a) return 'system';
  if (a.actorKind && ACTOR_KIND_META[a.actorKind]) return a.actorKind;
  const d = a.details && typeof a.details === 'object' ? a.details : {};
  if (d.actorKind && ACTOR_KIND_META[d.actorKind]) return d.actorKind;
  const by = String(a.performedBy || '').trim().toLowerCase();
  const email = String(d.actorEmail || '').toLowerCase();
  if (email.startsWith('apikey:') || by.startsWith('apikey:')) return 'api';
  if (a.activityType === 'mirror_conflict' || by === 'mirror reconciliation') return 'mirror';
  if (a.activityType === 'workflow_updated_ticket' || by === 'notification workflow' || by === 'ticket workflow') return 'workflow';
  if (FS_SOURCES.has(String(d.source || '')) || d.via === 'freshservice' || by.endsWith('(freshservice)') || by === 'freshservice') return 'freshservice_sync';
  if (by === 'system') return (a.activityType === 'status_changed' || a.activityType === 'assigned') ? 'freshservice_sync' : 'system';
  if (MACHINE_NAMES.has(by)) return 'system';
  return 'human';
}

/** The FS actor's name on a sync-observed row ("Dominic Bautista (FreshService)" → "Dominic Bautista"). */
export function fsActorName(a) {
  const d = a?.details && typeof a.details === 'object' ? a.details : {};
  if (d.actorName) return String(d.actorName);
  const m = /^(.+?)\s+\(FreshService\)$/i.exec(String(a?.performedBy || ''));
  return m ? m[1] : null;
}

/**
 * Machine rows are hidden by the History tab's default filter. A
 * sync-observed row that NAMES a human in FreshService ("Closed by Dominic
 * Bautista in FreshService") is that person's action, not machine noise — it
 * stays visible; Ticket Pulse's own write-back echo ("Ticket Pulse") does not.
 */
export function isMachineActivity(a) {
  const kind = activityActorKind(a);
  if (kind === 'freshservice_sync') {
    const name = fsActorName(a);
    return !name || /^ticket pulse$/i.test(name.trim());
  }
  return Boolean(ACTOR_KIND_META[kind]?.machine);
}

export function ActorKindChip({ kind, className = '' }) {
  const meta = ACTOR_KIND_META[kind];
  if (!meta) return null;
  return (
    <span
      data-testid="actor-kind-chip"
      data-kind={kind}
      title={meta.title}
      className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-semibold leading-4 whitespace-nowrap ${meta.tone} ${className}`}
    >
      {meta.label}
    </span>
  );
}

export const HIDE_MACHINE_STORAGE_KEY = 'tp.ticketHistory.hideMachine';

/** Per-viewer preference (default ON). localStorage can throw in private windows — never let it break render. */
export function readHideMachinePreference() {
  try {
    const raw = window.localStorage.getItem(HIDE_MACHINE_STORAGE_KEY);
    return raw === null ? true : raw !== 'false';
  } catch {
    return true;
  }
}

export function writeHideMachinePreference(value) {
  try {
    window.localStorage.setItem(HIDE_MACHINE_STORAGE_KEY, value ? 'true' : 'false');
  } catch { /* ignore */ }
}

/**
 * Collapse consecutive identical rows (same signature) into one carrying a
 * count and a time span — "Status changed Open→Spam · ×86, 10:51–10:54".
 * Expects items sorted newest-first; `from` is the earliest, `to` the latest.
 */
export function collapseConsecutive(items) {
  const out = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (prev && item.sig && prev.sig === item.sig) {
      prev.count += 1;
      prev.from = Math.min(prev.from, item.at);
      prev.to = Math.max(prev.to, item.at);
      continue;
    }
    out.push({ ...item, count: 1, from: item.at, to: item.at });
  }
  return out;
}

/** "10:51–10:54" for a collapsed span. */
export function spanLabel(from, to) {
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${fmt(from)}–${fmt(to)}`;
}
