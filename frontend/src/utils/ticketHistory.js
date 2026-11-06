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
 *   - identical consecutive rows fold to ×N with a time span.
 *
 * QA 11-05 #9 (one line per event):
 *   - an assignment episode is the ASSIGNER's action ("Ticket Pulse AI ·
 *     assigned → Jordan"), never the assignee's; only a self-pick is the
 *     technician's own. 543 of 544 AI-assigned episodes in IT (14 days to
 *     5 Nov) had no assignment audit row, so the episode was the only line —
 *     and it sat under the assignee's name;
 *   - Ticket Pulse workflow runs (`workflowRuns`) are rows of their own; the
 *     `workflow_updated_ticket` audit row and an assignment the run made fold
 *     into the run's row as details;
 *   - machine rows are no longer folded into "N automation events" bursts:
 *     with machine activity shown, every action is its own line.
 *
 * Each item carries `actorType` (person | ai | workflow | fs_workflow |
 * freshservice | ticketpulse | autohelp | api | system) so the row can show a
 * photo for a person and a mark for a machine, a short `reason` for the line,
 * and `extra` / `steps` for the expanded details.
 */
import { activityActorKind, fsActorName, isMachineActivity } from '../components/tickets/activityKind.jsx';
import { fsSystemEntryKind, fsSystemEntryLabel } from './fsSystemEntry.js';

const NEAR_MS = 3 * 60 * 1000;

const humanize = (s) => String(s || '').replace(/_/g, ' ');
// 'Reason: Duplicate — Combined into TP-10294: …' on a status row (TP-born and FS write-back alike).
const resolutionDetail = (d) => {
  if (!d?.resolutionReason) return null;
  const reason = humanize(d.resolutionReason);
  return `Reason: ${reason.charAt(0).toUpperCase()}${reason.slice(1)}${d.resolutionNote ? ` — ${d.resolutionNote}` : ''}`;
};

// Auto-help notes carry machine dates ("closing 2026-10-16", full ISO stamps):
// shown as a short day ("Fri 16 Oct"). A bare day is a calendar day (no zone
// shift); a full timestamp is shown in the viewer's zone.
const ISO_DAY_RE = /\b(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
export function friendlyDays(text) {
  if (!text) return text;
  return String(text).replace(ISO_DAY_RE, (m, y, mo, d, time) => {
    const date = time ? new Date(m) : new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12));
    if (Number.isNaN(date.getTime())) return m;
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(time ? {} : { timeZone: 'UTC' }) }).replace(',', '');
  });
}
const norm = (s) => String(s || '').trim().toLowerCase();
const MACHINE_ACTORS = new Set(['', 'system', 'freshservice', 'ticket pulse', 'ticket workflow', 'notification workflow', 'mirror reconciliation', 'ticket pulse ai', 'ticket pulse mail', 'ticket pulse duplicate guard']);
const isPersonName = (name) => !MACHINE_ACTORS.has(norm(name)) && !/\(freshservice\)$/i.test(String(name || '')) && !/^apikey:/i.test(String(name || ''));

export const PRIORITY_NAMES = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

/** "Riley Chen (in FreshService)" / "… (FreshService)" → the name, plus where it happened. */
function cleanActorName(name) {
  const raw = String(name || '').trim();
  const m = /^(.+?)\s+\((?:in\s+)?FreshService\)$/i.exec(raw);
  return m ? { name: m[1].trim(), inFs: true } : { name: raw, inFs: false };
}

/** Who an actor is, for the row's picture: a person's photo, or a machine's mark. */
export function actorTypeFor(name, kind = null) {
  const n = norm(name);
  if (kind === 'auto_help' || n === 'ticket pulse (auto-help)') return 'autohelp';
  if (n === 'ticket pulse ai') return 'ai';
  if (n === 'notification workflow' || n === 'workflow') return 'workflow';
  if (n === 'ticket workflow' || n === 'freshservice workflow') return 'fs_workflow';
  if (n.startsWith('ticket pulse') || n === 'mirror reconciliation') return 'ticketpulse';
  if (n === 'freshservice') return 'freshservice';
  if (kind === 'api' || /^apikey:/i.test(String(name || ''))) return 'api';
  if (!n || n === 'system') return 'system';
  if (kind === 'ai') return 'ai';
  return 'person';
}

const START_REASON = { workflow_assigned: 'auto-assign', ai_auto: 'auto-assign', auto_assigned: 'auto-assign' };
const END_VERB = { rejected: 'handed it back', reassigned: 'ownership ended', closed: 'ownership ended' };
const END_REASON = { reassigned: 'reassigned', closed: 'closed', rejected: null };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const FIELD_WORDS = { internalCategoryId: 'category', internalSubcategoryId: 'subcategory', internalGroupId: 'group', groupId: 'group', assignedTechId: 'assignee', dueBy: 'due date', frDueBy: 'first-response due' };

/** A workflow run's actions in plain words: "e-mailed 1 person, set status Pending → Open". */
export function workflowRunSummary(run) {
  const bits = [];
  for (const a of Array.isArray(run?.actions) ? run.actions : []) {
    if (a.type === 'email') {
      const n = (Number(a.to) || 0) + (Number(a.cc) || 0);
      bits.push(a.sent ? `e-mailed ${plural(n, 'person', 'people')}` : `would e-mail ${plural(n, 'person', 'people')}`);
    } else if (a.type === 'update') {
      if (a.assignedTo) bits.push(`assigned ${a.assignedTo}`);
      if (a.status?.to) bits.push(`set status ${a.status.from ? `${a.status.from} → ` : ''}${a.status.to}`);
      const others = (a.fields || []).filter((f) => f !== 'status').map((f) => FIELD_WORDS[f] || humanize(f));
      if (others.length) bits.push(`set ${others.join(', ')}`);
    } else {
      const words = { note: 'added a note', park: 'parked the ticket', webhook: 'called a webhook', teams: 'sent a Teams message', child: 'created a child ticket', approval: 'asked for approval', proposed_reply: 'staged a reply for approval' };
      if (words[a.type]) bits.push(words[a.type]);
    }
  }
  return [...new Set(bits)].join(', ');
}

const fmtDuration = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${(n / 1000).toFixed(n < 100 ? 2 : 1)} s`;
};

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
export function buildHistoryItems({ activities = [], assignmentEpisodes = [], pipelineRuns = [], workflowRuns = [], thread = [], techNameById = new Map() } = {}) {
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
      item = baseItem({ event: reopen ? 'reopen' : 'status', verb: reopen ? 'reopened' : 'changed status', from: d.oldStatus || null, to, detail: resolutionDetail(d) });
      if (fsName && to) attributed.status.push({ at, to: norm(to) });
    } else if (t === 'assigned' || t === 'reassigned' || t === 'coordinator_assigned') {
      const fromName = d.fromTechId ? techNameById.get(d.fromTechId) || `tech ${d.fromTechId}` : null;
      const toName = d.agentName || (d.toTechId ? techNameById.get(d.toTechId) || `tech ${d.toTechId}` : null);
      // A hand-back names its reason ("Access / permission limited").
      item = baseItem({ event: 'assignment', verb: toName ? (t === 'reassigned' ? 'reassigned' : 'assigned') : 'unassigned', from: fromName, to: toName, detail: d.note || null, reason: d.handBack?.label || null });
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
      // QA 11-05 #9: a status change by a workflow shows its from → to.
      const st = d.changes?.status && typeof d.changes.status === 'object' ? d.changes.status : null;
      const changed = d.changes && typeof d.changes === 'object' ? Object.keys(d.changes) : (Array.isArray(d.changedFields) ? d.changedFields : []);
      item = st
        ? baseItem({ event: 'status', verb: 'changed status', from: st.from || null, to: st.to || null, detail: d.note || null, importance: 1 })
        : baseItem({ event: 'workflow', verb: 'updated the ticket', detail: d.note || (changed.length ? `Changed: ${changed.map((f) => FIELD_WORDS[f] || humanize(f)).join(', ')}` : null) });
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
    } else if (t === 'urgent_response') {
      // Urgent response (plans/URGENT_RESPONSE_PLAN.md): the server writes the
      // one plain sentence; it is shown word for word as Ticket Pulse's own
      // line, and stays visible with machine activity hidden (a move is part
      // of the ticket's story).
      item = baseItem({ event: 'urgent', verb: d.sentence || d.note || 'Urgent response', importance: 2, machine: false });
    } else if (String(t || '').startsWith('auto_help_')) {
      // Auto-help P1: every step of the answer → check-in → close loop.
      const verbs = {
        auto_help_staged: 'suggested an answer for an agent to send',
        auto_help_sent: d.decision === 'agent_edited_sent' ? 'sent the Auto-help answer, edited' : d.decision === 'auto_sent' ? 'sent its answer' : 'sent the Auto-help answer',
        auto_help_dismissed: 'dismissed the Auto-help suggestion',
        auto_help_nudged: 'checked in with the requester',
        auto_help_closed: 'resolved it after no reply',
        auto_help_confirmed: 'resolved it — the requester said it worked',
        auto_help_help_requested: 'handed it to a person — the requester still needs help',
        auto_help_took_over: 'stepped back — a person took over',
        auto_help_reopened: 'counted a reopen against its answer',
        auto_help_left_open: 'handed it back to a person',
        auto_help_loop_stopped: 'stopped its follow-up — nothing sent or closed',
        auto_help_recovered: 'tidied up an unfinished send',
        // Integration W1-W3.
        auto_help_withdrawn: 'withdrew its suggestion',
        auto_help_superseded: 'set its suggestion aside (an agent replied)',
        auto_help_post_close_reply: 'read the reply after its close; the ticket stays closed',
        auto_help_settle_changed: 'noted the category changed after its answer',
        auto_help_manual_settle: 'will look again (the category was set by hand)',
        // 30 Sep 2026: approvals that scale; approve by day, auto by night.
        auto_help_assignee_told: 'told the assignee an answer is waiting',
        auto_help_sent_overnight: 'answered by itself overnight (outside business hours)',
      };
      item = baseItem({ event: 'autohelp', verb: verbs[t] || humanize(t.replace(/^auto_help_/, '')), detail: friendlyDays(d.note) || null, importance: 2 });
    } else if (t === 'ticket_ready') {
      // "Ticket ready" workflow trigger (30 Sep 2026).
      item = baseItem({
        event: 'system',
        verb: d.pending ? 'is waiting for the ticket to be sorted before "Ticket ready" workflows run' : 'marked the ticket ready for "Ticket ready" workflows',
        detail: d.pending ? null : d.note || null,
        machine: true,
      });
    } else if (t === 'fs_write_back') {
      // A person's change made in Ticket Pulse and written to FreshService
      // (2 Oct 2026): this row carries the real actor and the before → after,
      // so it IS the story — "Gaby reassigned Gaby → Marcus" — not a raw
      // "fs write back". FreshService's echo of it is dropped below.
      const c = d.changes && typeof d.changes === 'object' ? d.changes : {};
      if (c.assignee) {
        item = baseItem({ event: 'assignment', verb: c.assignee.to ? 'reassigned' : 'unassigned the ticket', from: c.assignee.from || null, to: c.assignee.to || null, machine: false });
        if (c.assignee.to) attributed.assignment.push({ at, to: norm(c.assignee.to) });
      } else if (c.status) {
        // QA 10-20 #2: a grouping close names the ticket it went into.
        item = baseItem({ event: 'status', verb: 'changed status', from: c.status.from || null, to: c.status.to || null, detail: resolutionDetail(d), machine: false });
      } else if (c.priority) {
        item = baseItem({ event: 'priority', verb: 'set priority', from: c.priority.from || null, to: c.priority.to || null, machine: false });
      } else {
        const fields = Object.keys(c).map(humanize).join(', ');
        item = baseItem({ event: 'system', verb: fields ? `updated ${fields} in FreshService` : 'updated the ticket in FreshService', machine: true });
      }
    } else if (t === 'owner_away_reroute') {
      // The owner was away when the requester replied (13 Oct 2026): the ticket
      // went back for assignment. Worth seeing, so it is not folded as machine chatter.
      item = baseItem({ event: 'assignment', verb: 'sent the ticket back for assignment', from: d.technicianName || null, detail: d.note || null, importance: 3, machine: false });
    } else if (t === 'requester_reply_stays_closed') {
      // When a requester replies (14 Oct 2026): a thank-you / out-of-office
      // left the ticket closed. The conversation has the quiet line too.
      item = baseItem({ event: 'reply', verb: 'left the ticket closed', detail: d.note || null, importance: 2, machine: false });
    } else if (t === 'requester_teams_chat') {
      // QA 10-15 #5: the requester opened a Teams chat with the agent from the urgency page.
      item = baseItem({ event: 'reply', verb: 'opened a Teams chat from the urgency page', detail: d.agentName ? `With ${d.agentName}` : null, importance: 2, machine: false });
    } else if (t === 'macro_applied') {
      // QA 11-05 (lane D macros): one line for the whole macro, its steps in the details.
      const steps = Array.isArray(d.steps) ? d.steps : [];
      const failed = steps.filter((s) => s && s.ok === false).length;
      const ran = steps.filter((s) => s && s.ok !== false && !s.skipped).length;
      item = baseItem({
        event: 'macro',
        verb: `applied macro “${d.macroName || 'a macro'}”`,
        reason: failed ? `${plural(failed, 'step')} failed` : steps.length ? `${plural(ran, 'step')}` : null,
        detail: steps.length ? null : d.note || null,
        importance: 2,
        machine: false,
      });
      item.extra = steps.map((s) => [
        s.summary || humanize(s.type),
        s.skipped ? `skipped${s.reason ? `: ${s.reason}` : ''}` : null,
        s.ok === false ? `failed${s.error ? `: ${s.error}` : ''}` : null,
      ].filter(Boolean).join(' · '));
    } else if (t === 'mirror_conflict') {
      item = baseItem({ event: 'system', verb: 'mirror conflict', detail: d.note || (Array.isArray(d.drift) ? d.drift.join(', ') : null) });
    } else if (t === 'created') {
      item = baseItem({ event: 'created', verb: 'created the ticket', detail: d.note || null });
    } else if (t === 'grouped_in') {
      // QA 10-20 #2: the kept ticket says which ticket was combined into it.
      item = baseItem({
        event: 'merge',
        verb: d.relation === 'update' ? 'combined in a follow-up' : 'combined in a duplicate',
        to: d.fromRef || null,
        detail: [d.fromSubject ? `"${d.fromSubject}"` : null, d.reason || null].filter(Boolean).join(' · ') || null,
        importance: 3,
        machine: false,
      });
    } else if (t === 'merged_from' || t === 'merged_into') {
      // 18 Oct 2026: said only "merged from" — now which ticket, and what came over.
      const into = t === 'merged_into';
      const subject = into ? d.targetSubject : d.sourceSubject;
      const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
      const bits = into
        ? [subject ? `"${subject}"` : null, 'The conversation continues there']
        : [
          subject ? `"${subject}"` : null,
          d.descriptionCopied ? 'Opening e-mail copied in' : null,
          Number.isFinite(d.copied) ? `${plural(d.copied, 'message')} copied in` : null,
          d.swept?.tasks ? `${plural(d.swept.tasks, 'open task')} moved over` : null,
          d.swept?.children ? `${plural(d.swept.children, 'child ticket')} moved over` : null,
          d.swept?.approvals ? `${plural(d.swept.approvals, 'pending approval')} cancelled` : null,
          d.attachmentsLeft ? `${plural(d.attachmentsLeft, 'attachment')} left on ${d.srcRef || 'the merged ticket'}` : null,
          d.requesterNotified ? 'Requester told' : null,
        ];
      item = baseItem({
        event: 'merge',
        verb: into ? 'merged this ticket into' : 'merged in',
        to: (into ? d.tgtRef : d.srcRef) || null,
        detail: bits.filter(Boolean).join(' · ') || null,
        importance: 3,
        machine: false,
      });
    } else {
      item = baseItem({ event: 'system', verb: humanize(t), detail: d.note || null });
    }
    const shownActor = t === 'urgent_response'
      ? 'Ticket Pulse'
      : ((t === 'merged_from' || t === 'merged_into') && d.actorName) ? d.actorName : actor;
    items.push({ ...item, key: `a-${a.id}`, at, kind, atype: t, actorType: actorTypeFor(shownActor, fsName ? 'human' : kind), machine: item.machine ?? machine, actor: shownActor, source, sig: `a|${t}|${shownActor}|${item.from || ''}|${item.to || ''}|${item.detail || (t === 'urgent_response' ? item.verb : '')}` });
  }

  // QA 11-05 #9: an episode is the ASSIGNER's action. "Ticket Pulse AI ·
  // assigned → Jordan · auto-assign" — not "Jordan took ownership (workflow
  // assigned) by Ticket Pulse AI". Only a self-pick is the technician's own.
  for (const ep of assignmentEpisodes) {
    const who = ep.technician?.name || 'Technician';
    const at = new Date(ep.startedAt).getTime();
    const by = cleanActorName(ep.startAssignedByName);
    // An automatic start with no name stamped is still the machine's move.
    if (!by.name && START_REASON[ep.startMethod]) by.name = ep.startMethod === 'workflow_assigned' ? 'Workflow' : 'Ticket Pulse AI';
    const selfPicked = ep.startMethod === 'self_picked' || !by.name || norm(by.name) === norm(who);
    if (selfPicked) {
      items.push({ ...baseItem({ event: 'ownership', verb: 'picked this up', to: who }), key: `ep-${ep.id}`, at, kind: 'human', actorType: 'person', machine: false, actor: who, episode: true, sig: `ep|${ep.id}` });
    } else {
      const actorType = actorTypeFor(by.name);
      items.push({
        ...baseItem({ event: 'assignment', verb: 'assigned', to: who, reason: by.inFs ? 'in FreshService' : START_REASON[ep.startMethod] || null }),
        key: `ep-${ep.id}`, at, kind: actorType === 'ai' ? 'ai' : 'human', actorType, machine: false, actor: by.name, episode: true,
        source: by.inFs ? 'freshservice' : 'ticketpulse', sig: `ep|${ep.id}`,
      });
    }
    if (ep.endedAt && ep.endMethod && ep.endMethod !== 'still_active') {
      const ender = cleanActorName(ep.endActorName);
      const endBy = ender.name || who;
      items.push({
        ...baseItem({ event: 'ownership', verb: END_VERB[ep.endMethod] || 'ownership ended', from: who, reason: END_REASON[ep.endMethod] ?? humanize(ep.endMethod), importance: 1 }),
        key: `ep-end-${ep.id}`, at: new Date(ep.endedAt).getTime(), kind: 'human', actorType: actorTypeFor(endBy),
        // A close already tells the story; the episode ending with it is bookkeeping.
        machine: ep.endMethod === 'closed', actor: endBy, episodeEnd: true, sig: `epend|${ep.id}`,
      });
    }
  }

  for (const pr of pipelineRuns) {
    items.push({ ...baseItem({ event: 'ai', verb: pr.status === 'queued' ? 'AI triage queued' : `AI run — ${pipelineRunLabelSafe(pr)}`, detail: `via ${pipelineTriggerLabelSafe(pr.triggerSource)}${pr.syncStatus ? ` · sync ${pr.syncStatus}` : ''}` }), key: `run-${pr.id}`, at: new Date(pr.decidedAt || pr.createdAt).getTime(), kind: 'ai', actorType: 'ai', machine: true, actor: 'Ticket Pulse AI', pipelineRun: pr, sig: `run|${pr.id}` });
  }

  // QA 11-05 #9: Ticket Pulse workflow runs on this ticket. A live run that
  // acted (or failed) is part of the story; Shadow, preview and skipped runs
  // are machine activity.
  for (const r of workflowRuns) {
    const shadow = Boolean(r.shadow);
    const outcome = r.outcome || 'nothing';
    const verb = shadow
      ? (r.executionMode === 'preview' ? 'Preview — nothing sent' : 'Shadow — nothing sent')
      : { failed: 'failed', stopped: 'skipped', waiting: 'is waiting', running: 'is running', nothing: 'ran' }[outcome] || 'ran';
    const summary = workflowRunSummary(r);
    const reason = outcome === 'failed' ? (r.error ? String(r.error).split('\n')[0] : null)
      : outcome === 'stopped' ? (r.stopReason && r.stopReason !== 'Workflow stopped' ? r.stopReason : r.stopCause || r.stopReason || null)
        : summary || null;
    items.push({
      ...baseItem({ event: 'wfrun', verb, reason, importance: shadow || outcome === 'stopped' ? 0 : 2 }),
      key: `wf-${r.id}`,
      at: new Date(r.startedAt).getTime(),
      kind: 'workflow',
      actorType: 'workflow',
      actor: 'Workflow',
      workflowName: r.workflowName || 'A workflow',
      outcome,
      shadow,
      duration: fmtDuration(r.durationMs),
      steps: Array.isArray(r.steps) ? r.steps : [],
      extra: [],
      wfAssigned: (r.actions || []).some((a) => a.type === 'update' && a.assignedTo),
      wfUpdated: (r.actions || []).some((a) => a.type === 'update'),
      eventType: r.eventType || null,
      machine: shadow || outcome === 'stopped' || outcome === 'nothing',
      sig: `wf|${r.id}`,
    });
  }

  for (const e of thread) {
    // A line FreshService wrote itself in the conversation feed ("<Name> has
    // submitted the survey response") is one quiet History row (QA 10-13 #5).
    const systemKind = e.source !== 'freshservice_activity' ? fsSystemEntryKind(e) : null;
    if (systemKind) {
      const text = String(e.bodyText || e.content || '').replace(/\s+/g, ' ').trim();
      items.push({ ...baseItem({ event: 'system', verb: fsSystemEntryLabel(systemKind).toLowerCase(), detail: text || null, importance: 1 }), key: `fssys-${e.id}`, at: new Date(e.occurredAt).getTime(), kind: 'freshservice_sync', machine: true, actor: 'FreshService', source: 'freshservice', sig: `fssys|${systemKind}|${text}` });
      continue;
    }
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
      // QA 11-05 #9: "executed Ticket Closed (06-13) workflow from Ticket is
      // closed event" → FreshService workflow "Ticket Closed (06-13)" · on: Ticket is closed.
      const webhook = /^executed webhook in (.+?) workflow\.?\s*(?:Node name\s*-\s*(.+?)\s*\.)?\s*(?:Result\s*-\s*(.+?))?\s*$/i.exec(parsed.detail);
      const run = webhook ? null : /^executed (.+?) workflow(?: from (.+?) event)?\s*$/i.exec(parsed.detail);
      const workflowName = webhook?.[1] || run?.[1] || null;
      const reason = webhook ? [webhook[2] ? `webhook "${webhook[2]}"` : 'webhook', webhook[3] || null].filter(Boolean).join(' · ') : run?.[2] ? `on: ${run[2]}` : null;
      items.push({ ...baseItem({ event: 'wfrun', verb: webhook ? 'called a webhook' : 'ran', reason, detail: workflowName ? null : parsed.detail.replace(/^executed\s+/i, '') }), key: `fs-${e.id}`, at, kind: 'freshservice_sync', actorType: 'fs_workflow', workflowName, machine: true, actor: 'FreshService workflow', source: 'freshservice', sig: `fs|wf|${parsed.detail}` });
    }
  }

  for (const i of items) {
    if (!i.actorType) i.actorType = actorTypeFor(i.actor, i.kind === 'freshservice_sync' && isPersonName(i.actor) ? 'human' : i.kind);
  }

  const near = (a, b) => Math.abs(a.at - b.at) <= NEAR_MS;
  const drop = new Set();

  // Episode ↔ assignment duplicate: the episode within ±3 min of an
  // assignment row to the same person tells the same story. The person's (or
  // the attributed FreshService) row wins; a machine echo loses to the episode,
  // which knows who assigned.
  for (const ep of items.filter((i) => i.episode)) {
    const twins = items.filter((h) => h !== ep && !h.episode && (h.event === 'assignment' || h.event === 'ownership') && h.to && norm(h.to) === norm(ep.to) && near(h, ep));
    if (!twins.length) continue;
    if (twins.some((h) => !h.machine)) drop.add(ep);
    else for (const h of twins) drop.add(h);
  }
  // A person's reassignment (fs_write_back / native assign) is the one line
  // for that moment (2 Oct 2026): the FreshService echo of the same change
  // ("reconciled the assignee", status set by "Ticket Pulse") and the episode
  // that closed with it ("ownership ended", "handed it back") only repeat it.
  const humanChanges = items.filter((i) => !i.machine && (i.event === 'assignment' || i.event === 'status') && i.kind !== 'freshservice_sync');
  for (const i of items) {
    if (i.machine && (i.event === 'assignment' || i.event === 'status')
      && humanChanges.some((h) => h.event === i.event && h !== i && near(h, i) && norm(h.to) === norm(i.to))) drop.add(i);
    if (i.episodeEnd && items.some((h) => h.event === 'assignment' && !h.episode && (h.to || h.from) && near(h, i) && (!h.from || norm(h.from) === norm(i.from)))) drop.add(i);
  }
  // The AI's own run row repeats an assignment the AI made: its details go on
  // the assignment line.
  for (const ep of items.filter((i) => i.episode && i.actorType === 'ai')) {
    const run = items.find((r) => r.pipelineRun && !drop.has(r) && near(r, ep));
    if (run) {
      drop.add(run);
      ep.extra = [...(ep.extra || []), `AI run #${run.pipelineRun.id}${run.detail ? ` · ${run.detail}` : ''}`];
    }
  }
  // A workflow run and what it did: its workflow_updated_ticket row, and an
  // assignment it made, are details of the run's line, not lines of their own.
  for (const run of items.filter((i) => i.event === 'wfrun' && i.key.startsWith('wf-') && !i.shadow)) {
    const owned = items.filter((h) => !drop.has(h) && near(h, run) && (
      (run.wfUpdated && h.atype === 'workflow_updated_ticket')
      || (run.wfAssigned && (h.episode || (h.event === 'assignment' && h.kind === 'workflow')))
    ));
    for (const h of owned) {
      drop.add(h);
      const move = `${h.verb}${h.from ? ` ${h.from} →` : ''}${h.to ? ` ${h.to}` : ''}`;
      run.extra.push([move, h.detail].filter(Boolean).join(' · '));
    }
  }

  const deduped = items.filter((i) => !drop.has(i));
  deduped.sort((x, y) => y.at - x.at);
  return collapseSame(deduped);
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

/**
 * Group the (newest-first) items into runs: consecutive rows by the same
 * actor become one run, so the picture and name are shown once and the next
 * rows hang under them on the same rail (QA 11-05 #9). Every row stays its
 * own line — machine rows are never absorbed into a person's run or folded
 * into a burst; a machine row between two of one person's rows splits them.
 */
export function groupByActor(items) {
  const runs = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && last.actor === item.actor && last.actorType === item.actorType) {
      last.items.push(item);
      last.from_at = Math.min(last.from_at, item.from_at ?? item.at);
      last.machine = last.machine && item.machine;
      continue;
    }
    runs.push({
      key: `run-${item.key}`, actor: item.actor || 'System', actorType: item.actorType, machine: Boolean(item.machine),
      kind: item.kind, source: item.source, items: [item], from_at: item.from_at ?? item.at, to_at: item.to_at ?? item.at, at: item.at,
    });
  }
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

export default { buildHistoryItems, parseFsFeedLine, groupByActor, countMachine, workflowRunSummary, actorTypeFor, PRIORITY_NAMES };
