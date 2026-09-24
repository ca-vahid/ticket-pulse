/**
 * Ticket history model (Activity tab overhaul, 14 Sep 2026).
 *
 * Turns the four raw feeds a ticket carries — audit rows, assignment
 * episodes, AI pipeline runs and the cached FreshService activity feed — into
 * ONE list of normalised events, newest first:
 *
 *   { key, at, kind, machine, actor, actorDisplay, event, verb, from, to,
 *     detail, source, importance, sig }
 *
 * and then folds it:
 *   - the same transition told by two feeds within ±3 min (the audit row
 *     attributed to a person in FreshService, and the FreshService feed line
 *     "X set Status as Closed") is ONE event — the attributed row wins;
 *   - the same transition told by an assignment episode ("took ownership") on
 *     top of an assignment row is ONE event;
 *   - identical consecutive rows fold to ×N with a time span;
 *   - consecutive machine rows within a 5-minute gap fold into a "burst" the
 *     UI shows as one collapsed line ("12 automation events").
 *
 * Everything the UI needs to draw a row (icons, tones, chips) is decided
 * here as data; the component only renders.
 */
import { activityActorKind, fsActorName, isMachineActivity } from '../components/tickets/activityKind.jsx';

const NEAR_MS = 3 * 60 * 1000;
const BURST_GAP_MS = 5 * 60 * 1000;

const humanize = (s) => String(s || '').replace(/_/g, ' ');
const norm = (s) => String(s || '').trim().toLowerCase();
const MACHINE_ACTORS = new Set(['', 'system', 'freshservice', 'ticket pulse', 'ticket workflow', 'notification workflow', 'mirror reconciliation', 'ticket pulse ai', 'ticket pulse mail', 'ticket pulse duplicate guard']);
const isPersonName = (name) => !MACHINE_ACTORS.has(norm(name)) && !/\(freshservice\)$/i.test(String(name || '')) && !/^apikey:/i.test(String(name || ''));

export const PRIORITY_NAMES = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

/** FreshService activity-feed line → structured event, or null (verbatim system line). */
export function parseFsFeedLine(entry) {
  const text = String(entry?.content || entry?.bodyText || '').trim().replace(/\s+/g, ' ');
  const type = entry?.eventType;
  let m;
  if (type === 'status_event' && (m = /set Status as (.+?)\s*$/i.exec(text))) return { event: 'status', to: m[1].trim() };
  if (type === 'assignment_event' && (m = /set Agent as (.+?)\s*$/i.exec(text))) {
    const v = m[1].trim();
    return { event: 'assignment', to: /^none$/i.test(v) ? null : v };
  }
  if (type === 'group_event' || /^created ticket/i.test(text)) {
    const created = /^created ticket/i.test(text);
    const group = /set Group as (.+?)(?:,\s*set\s|\s+and\s+set\s|\s*$)/i.exec(text)?.[1]?.trim() || null;
    const priority = /set Priority as (.+?)(?:,\s*set\s|\s+and\s+set\s|\s*$)/i.exec(text)?.[1]?.trim() || null;
    const source = /set Source as (.+?)(?:,\s*set\s|\s+and\s+set\s|\s*$)/i.exec(text)?.[1]?.trim() || null;
    if (created) return { event: 'created', group, priority, source };
    if (group) return { event: 'group', to: /^none$/i.test(group) ? null : group };
  }
  if ((m = /^set Priority as (.+?)\s*$/i.exec(text))) return { event: 'priority', to: m[1].trim() };
  if (/^(added|updated) a (private )?note$/i.test(text)) return { event: 'note', updated: /^updated/i.test(text), priv: /private/i.test(text) };
  if (/^added a (public )?reply$/i.test(text) || /^replied/i.test(text)) return { event: 'reply' };
  if ((m = /^set Ticket Pulse Category as (.+?) and set Ticket Pulse Subcategory as (.+?)\s*$/i.exec(text))) return { event: 'category', to: `${m[1].trim()} / ${m[2].trim()}` };
  if ((m = /^set Ticket Accepted as (true|false)\s*$/i.exec(text))) return { event: 'accepted', to: m[1].toLowerCase() === 'true' };
  if (/^executed .* workflow/i.test(text) || /^executed webhook/i.test(text)) return { event: 'workflow', detail: text };
  return null;
}

const IMPORTANCE = { status: 3, assignment: 3, created: 3, priority: 2, group: 2, ownership: 2, reopen: 3, note: 1, reply: 2, category: 1, accepted: 1, field: 1, due: 1, ai: 1, workflow: 0, system: 0, forward: 2, noise: 2, task: 1 };
const TERMINAL = new Set(['resolved', 'closed']);

function baseItem(partial) {
  const importance = partial.importance ?? IMPORTANCE[partial.event] ?? 1;
  return { detail: null, from: null, to: null, source: 'ticketpulse', ...partial, importance };
}

/**
 * Build the normalised, deduplicated, folded history list (newest first).
 */
export function buildHistoryItems({ activities = [], assignmentEpisodes = [], pipelineRuns = [], thread = [], techNameById = new Map() } = {}) {
  const items = [];
  const attributed = { status: [], assignment: [] };

  for (const a of activities) {
    const d = a.details && typeof a.details === 'object' ? a.details : {};
    const kind = activityActorKind(a);
    // A sync-observed row whose performedBy is a PERSON ("Andrew Fong" on a
    // coordinator_assigned row) is that person's action in FreshService —
    // the (FreshService) suffix / details.actorName are not always stamped.
    const fsName = kind === 'freshservice_sync' ? (fsActorName(a) || (isPersonName(a.performedBy) ? a.performedBy : null)) : null;
    const actor = fsName || a.performedBy || 'System';
    const machine = fsName ? false : isMachineActivity(a);
    const source = d.via === 'freshservice' || kind === 'freshservice_sync' ? 'freshservice' : 'ticketpulse';
    const at = new Date(a.performedAt).getTime();
    const t = a.activityType;
    let item;
    if (t === 'status_changed') {
      const to = d.newStatus || null;
      const reopen = d.oldStatus && to && TERMINAL.has(norm(d.oldStatus)) && !TERMINAL.has(norm(to));
      item = baseItem({ event: reopen ? 'reopen' : 'status', verb: reopen ? 'reopened' : 'changed status', from: d.oldStatus || null, to, detail: d.resolutionReason ? `Reason: ${humanize(d.resolutionReason)}${d.resolutionNote ? ` — ${d.resolutionNote}` : ''}` : null });
      if (fsName && to) attributed.status.push({ at, to: norm(to) });
    } else if (t === 'assigned' || t === 'reassigned' || t === 'coordinator_assigned') {
      const fromName = d.fromTechId ? techNameById.get(d.fromTechId) || `tech ${d.fromTechId}` : null;
      const toName = d.agentName || (d.toTechId ? techNameById.get(d.toTechId) || `tech ${d.toTechId}` : null);
      item = baseItem({ event: 'assignment', verb: toName ? 'assigned' : 'unassigned', from: fromName, to: toName, detail: d.note || null });
      if (fsName || (kind !== 'reconcile' && toName)) attributed.assignment.push({ at, to: norm(toName) });
    } else if (t === 'self_picked' || t === 'picked') {
      item = baseItem({ event: 'ownership', verb: 'picked this up', to: a.performedBy });
    } else if (t === 'group_changed') {
      item = baseItem({ event: 'group', verb: 'set the group', to: d.groupName || d.toGroupName || null, from: d.fromGroupName || null });
    } else if (t === 'due_changed') {
      const bits = [];
      for (const [key, name] of [['frDueBy', 'First response'], ['dueBy', 'Resolution']]) {
        const c = d.changes?.[key];
        if (c && (c.from || c.to)) bits.push(`${name}: ${c.from ? fmtDay(c.from) : 'not set'} → ${c.to ? fmtDay(c.to) : 'removed'}`);
      }
      item = baseItem({ event: 'due', verb: 'changed the due date', detail: bits.join(' · ') || null });
    } else if (t === 'requester_reply') {
      item = baseItem({ event: 'reply', verb: 'replied', detail: d.note || null });
    } else if (t === 'solution_verified' || t === 'solution_cleared') {
      item = baseItem({ event: 'solution', verb: t === 'solution_verified' ? 'marked this as a verified solution' : 'removed the verified-solution mark', detail: d.note || null });
    } else if (t === 'noise_flagged' || t === 'noise_cleared') {
      item = baseItem({ event: 'noise', verb: t === 'noise_flagged' ? 'marked as noise' : 'cleared the noise flag', detail: d.note || d.reason || null });
    } else if (t === 'forwarded' || t === 'forwarded_intake' || t === 'forwarded_intake_unparsed' || t === 'agent_cc_intake') {
      item = baseItem({ event: 'forward', verb: humanize(t), detail: d.note || null });
    } else if (t === 'ai_triage') {
      item = baseItem({ event: 'ai', verb: 'AI triage', detail: d.note || null, machine: true });
    } else if (t === 'workflow_updated_ticket') {
      item = baseItem({ event: 'workflow', verb: 'workflow updated the ticket', detail: d.note || (Array.isArray(d.changedFields) ? `Changed: ${d.changedFields.join(', ')}` : null) });
    } else if (t === 'fields_updated' || t === 'custom_fields_changed') {
      const changed = d.changes && typeof d.changes === 'object' ? Object.keys(d.changes) : (Array.isArray(d.changedFields) ? d.changedFields : []);
      item = baseItem({ event: 'field', verb: t === 'custom_fields_changed' ? 'updated custom fields' : 'edited fields', detail: changed.length ? changed.map(humanize).join(', ') : d.note || null });
    } else if (t === 'task_status_changed') {
      item = baseItem({ event: 'task', verb: 'updated a task', detail: d.note || null });
    } else if (t === 'resubmitted') {
      item = baseItem({ event: 'field', verb: 'resubmitted the record', detail: d.note || null });
    } else if (t === 'ticket_parked' || t === 'ticket_park_extended') {
      // Parked (plans/PARKED_BUILD_PLAN.md)
      const until = d.until ? fmtDay(d.until) : null;
      item = baseItem({ event: 'status', verb: t === 'ticket_parked' ? `parked this until ${until || 'a date'}` : `moved the park to ${until || 'a new date'}`, detail: [d.kindLabel, d.reason].filter(Boolean).join(' · ') || null });
    } else if (t === 'ticket_unparked') {
      const why = { requester_replied: 'the requester replied', status_changed: 'the status changed', closed: 'it was closed', unparked: null }[d.reason];
      item = baseItem({ event: 'status', verb: 'ended the park', detail: why || d.note || null });
    } else if (t === 'ticket_woke') {
      item = baseItem({ event: 'status', verb: 'woke — the park date came', detail: d.reason || null, machine: true });
    } else if (t === 'mirror_conflict') {
      item = baseItem({ event: 'system', verb: 'mirror conflict', detail: d.note || (Array.isArray(d.drift) ? d.drift.join(', ') : null) });
    } else if (t === 'created') {
      item = baseItem({ event: 'created', verb: 'created the ticket', detail: d.note || null });
    } else {
      item = baseItem({ event: 'system', verb: humanize(t), detail: d.note || null });
    }
    items.push({ ...item, key: `a-${a.id}`, at, kind, machine: item.machine ?? machine, actor, source, sig: `a|${t}|${actor}|${item.from || ''}|${item.to || ''}|${item.detail || ''}` });
  }

  for (const ep of assignmentEpisodes) {
    const who = ep.technician?.name || 'Technician';
    items.push({ ...baseItem({ event: 'ownership', verb: `took ownership (${humanize(ep.startMethod)})`, to: who, detail: ep.startAssignedByName ? `by ${ep.startAssignedByName}` : null }), key: `ep-${ep.id}`, at: new Date(ep.startedAt).getTime(), kind: 'human', machine: false, actor: who, actorBy: ep.startAssignedByName || null, sig: `ep|${ep.id}` });
    if (ep.endedAt && ep.endMethod && ep.endMethod !== 'still_active') {
      items.push({ ...baseItem({ event: 'ownership', verb: `ownership ended (${humanize(ep.endMethod)})`, from: who, detail: ep.endActorName ? `by ${ep.endActorName}` : null, importance: 1 }), key: `ep-end-${ep.id}`, at: new Date(ep.endedAt).getTime(), kind: 'human', machine: false, actor: who, sig: `epend|${ep.id}` });
    }
  }

  for (const pr of pipelineRuns) {
    items.push({ ...baseItem({ event: 'ai', verb: pr.status === 'queued' ? 'AI triage queued' : `AI run — ${pipelineRunLabelSafe(pr)}`, detail: `via ${pipelineTriggerLabelSafe(pr.triggerSource)}${pr.syncStatus ? ` · sync ${pr.syncStatus}` : ''}` }), key: `run-${pr.id}`, at: new Date(pr.decidedAt || pr.createdAt).getTime(), kind: 'ai', machine: true, actor: 'Ticket Pulse AI', sig: `run|${pr.id}` });
  }

  for (const e of thread) {
    if (e.source !== 'freshservice_activity') continue;
    const at = new Date(e.occurredAt).getTime();
    const actor = e.actorName || 'FreshService';
    const isEcho = /^ticket pulse$/i.test(actor.trim());
    const isWorkflow = /^(ticket workflow|system)$/i.test(actor.trim());
    const parsed = parseFsFeedLine(e);
    const text = String(e.bodyText || e.content || '').trim();
    if (!parsed) {
      if (e.eventType !== 'activity' || !text) continue;
      items.push({ ...baseItem({ event: 'system', verb: 'system activity', detail: text.length > 220 ? `${text.slice(0, 220)}…` : text }), key: `sys-${e.id}`, at, kind: 'freshservice_sync', machine: true, actor, source: 'freshservice', sig: `sys|${actor}|${text}` });
      continue;
    }
    if (parsed.event === 'status') {
      if (attributed.status.some((s) => Math.abs(s.at - at) <= NEAR_MS && s.to === norm(parsed.to))) continue;
      items.push({ ...baseItem({ event: 'status', verb: 'changed status', to: parsed.to }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: isEcho, actor, source: 'freshservice', sig: `fs|status|${actor}|${parsed.to}` });
    } else if (parsed.event === 'assignment') {
      if (attributed.assignment.some((s) => Math.abs(s.at - at) <= NEAR_MS && (!parsed.to || s.to === norm(parsed.to)))) continue;
      items.push({ ...baseItem({ event: 'assignment', verb: parsed.to ? 'assigned' : 'unassigned', to: parsed.to }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: isEcho, actor, source: 'freshservice', sig: `fs|assign|${actor}|${parsed.to || ''}` });
    } else if (parsed.event === 'created') {
      const bits = [parsed.group ? `group ${parsed.group}` : null, parsed.priority ? `priority ${parsed.priority}` : null, parsed.source ? `via ${parsed.source}` : null].filter(Boolean);
      items.push({ ...baseItem({ event: 'created', verb: 'created the ticket', to: parsed.group, detail: bits.join(' · ') || null }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: false, actor, source: 'freshservice', sig: `fs|created|${actor}` });
    } else if (parsed.event === 'group') {
      items.push({ ...baseItem({ event: 'group', verb: 'set the group', to: parsed.to }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: isEcho, actor, source: 'freshservice', sig: `fs|group|${actor}|${parsed.to || ''}` });
    } else if (parsed.event === 'priority') {
      items.push({ ...baseItem({ event: 'priority', verb: 'set priority', to: parsed.to }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: isEcho, actor, source: 'freshservice', sig: `fs|priority|${actor}|${parsed.to}` });
    } else if (parsed.event === 'note') {
      items.push({ ...baseItem({ event: 'note', verb: parsed.updated ? 'edited a note' : parsed.priv ? 'added a private note' : 'added a note' }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: isEcho, actor, source: 'freshservice', sig: `fs|note|${actor}|${parsed.updated ? 'u' : 'a'}` });
    } else if (parsed.event === 'reply') {
      items.push({ ...baseItem({ event: 'reply', verb: 'replied' }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: isEcho, actor, source: 'freshservice', sig: `fs|reply|${actor}` });
    } else if (parsed.event === 'category') {
      items.push({ ...baseItem({ event: 'category', verb: 'set the category', to: parsed.to }), key: `fs-${e.id}`, at, kind: isEcho ? 'freshservice_sync' : 'freshservice_sync', machine: true, actor, source: 'freshservice', sig: `fs|cat|${parsed.to}` });
    } else if (parsed.event === 'accepted') {
      items.push({ ...baseItem({ event: 'accepted', verb: parsed.to ? 'accepted the ticket' : 'un-accepted the ticket' }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: isEcho || isWorkflow, actor, source: 'freshservice', sig: `fs|accepted|${actor}|${parsed.to}` });
    } else if (parsed.event === 'workflow') {
      items.push({ ...baseItem({ event: 'workflow', verb: 'ran a FreshService workflow', detail: parsed.detail.replace(/^executed\s+/i, '') }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', machine: true, actor, source: 'freshservice', sig: `fs|wf|${parsed.detail}` });
    }
  }

  // Episode ↔ assignment duplicate: "took ownership" within ±3 min of an
  // assignment to the same person tells the same story — keep the assignment.
  const assignAt = items.filter((i) => i.event === 'assignment' && i.to).map((i) => ({ at: i.at, to: norm(i.to) }));
  const deduped = items.filter((i) => !(i.event === 'ownership' && i.verb.startsWith('took ownership') && assignAt.some((s) => Math.abs(s.at - i.at) <= NEAR_MS && s.to === norm(i.to))));

  deduped.sort((x, y) => y.at - x.at);
  return foldBursts(collapseSame(deduped));
}

function collapseSame(items) {
  const out = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (prev && item.sig && prev.sig === item.sig) {
      prev.count += 1; prev.from_at = Math.min(prev.from_at, item.at); prev.to_at = Math.max(prev.to_at, item.at);
      continue;
    }
    out.push({ ...item, count: 1, from_at: item.at, to_at: item.at });
  }
  return out;
}

/** Consecutive machine rows within a 5-minute gap → one burst row. */
export function foldBursts(items) {
  const out = [];
  let burst = null;
  const flush = () => {
    if (!burst) return;
    if (burst.items.length >= 2) out.push(burst);
    else out.push(burst.items[0]);
    burst = null;
  };
  for (const item of items) {
    if (item.machine) {
      if (burst && burst.to_at - item.at <= BURST_GAP_MS && item.at <= burst.from_at + BURST_GAP_MS * 12) {
        burst.items.push(item); burst.count += item.count || 1; burst.from_at = Math.min(burst.from_at, item.from_at ?? item.at); burst.to_at = Math.max(burst.to_at, item.to_at ?? item.at);
      } else {
        flush();
        burst = { key: `burst-${item.key}`, at: item.at, event: 'burst', machine: true, kind: 'system', items: [item], count: item.count || 1, from_at: item.from_at ?? item.at, to_at: item.to_at ?? item.at, importance: 0 };
      }
    } else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

/**
 * Group the (newest-first) items into runs: consecutive events by the same
 * person become one run so the name and avatar are shown once. Machine rows
 * (bursts, reconcile echoes) that sit *between* two events of the same person
 * are absorbed into that run; otherwise they stand on the rail by themselves.
 */
export function groupByActor(items) {
  const runs = [];
  let run = null;
  let pending = [];
  const flushPending = () => {
    for (const m of pending) runs.push({ key: `run-${m.key}`, actor: m.actor || 'System', machine: true, kind: m.kind, source: m.source, items: [m], from_at: m.from_at ?? m.at, to_at: m.to_at ?? m.at, at: m.at });
    pending = [];
  };
  for (const item of items) {
    if (item.machine) { pending.push(item); continue; }
    if (run && run.actor === item.actor) {
      run.items.push(...pending); pending = [];
      run.items.push(item);
      run.from_at = Math.min(run.from_at, item.from_at ?? item.at);
    } else {
      if (run) runs.push(run);
      run = null;
      flushPending();
      run = { key: `run-${item.key}`, actor: item.actor, machine: false, kind: item.kind, source: item.source, items: [item], from_at: item.from_at ?? item.at, to_at: item.to_at ?? item.at, at: item.at };
    }
  }
  if (run) runs.push(run);
  flushPending();
  return runs;
}

export function countMachine(items) {
  return items.reduce((n, i) => n + (i.machine ? (i.count || 1) : 0), 0);
}

function fmtDay(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function pipelineRunLabelSafe(pr) {
  if (pr.status === 'skipped') return `Skipped${pr.skipReason ? ` ${pr.skipReason}` : ''}`;
  if (pr.mode === 'priority_only' || pr.assessmentOnly) return 'Priority & category assessed';
  if (pr.status === 'completed' && pr.assignedTechName) return `Assigned ${pr.assignedTechName}`;
  return pr.outcome || pr.status || 'run';
}
function pipelineTriggerLabelSafe(source) {
  const map = { webhook: 'webhook', scheduled: 'schedule', manual: 'manual run', after_hours: 'after-hours assessment', assignment_fast_sync: 'fast sync' };
  return map[source] || (source ? humanize(source) : 'pipeline');
}

export default { buildHistoryItems, parseFsFeedLine, foldBursts, groupByActor, countMachine, PRIORITY_NAMES };
