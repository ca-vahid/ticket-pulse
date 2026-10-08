/**
 * Teams notifications (plans/TEAMS_NOTIFICATIONS_PLAN.md, 30 Sep 2026).
 *
 * Ticket events → the people who care → their own choices → a Teams card in
 * their personal chat with the Ticket Pulse bot. Replaces FreshService
 * ServiceBot's pings, plus: never about your own action, silent while away,
 * quiet hours, per-ticket mute, bursts coalesced into one card, a daily
 * digest, approvals decided from the card (with a confirm step), an optional
 * team-channel feed and Teams bell notifications for urgent items.
 *
 * Entry points:
 *  - onTicketEvent(eventContext)   ← ticketLifecycleNotificationService (every ticket event)
 *  - notifyApproval({...})         ← ticketApprovalService._emailApprover
 *  - handleActivity(activity)      ← POST /api/teams/messages (the bot endpoint)
 *  - agent + admin APIs            ← routes/teams.routes.js
 * Nothing here ever throws into the ticket pipeline.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import bot from '../integrations/teamsBotClient.js';
import { ticketCard, approvalCard, digestCard, textCard, EVENT_META, OUTCOMES, htmlToCardMarkdown, textToCardMarkdown } from './teamsCards.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

/** What an agent can choose from. mode: 'teams' | 'digest' | 'off'. */
export const EVENTS = [
  { key: 'assigned', label: 'A ticket is assigned to me', group: 'My tickets', mode: 'teams' },
  { key: 'requester_replied', label: 'The requester replies on my ticket', group: 'My tickets', mode: 'teams' },
  { key: 'teammate_update', label: 'Someone else adds a note or reply on my ticket', group: 'My tickets', mode: 'teams' },
  { key: 'status_changed', label: 'Someone else changes the status of my ticket', group: 'My tickets', mode: 'off' },
  { key: 'reopened', label: 'My ticket is reopened', group: 'My tickets', mode: 'teams' },
  { key: 'park_woke', label: 'A parked ticket of mine wakes up', group: 'My tickets', mode: 'teams' },
  { key: 'unassigned_from_me', label: 'My ticket is reassigned to someone else', group: 'My tickets', mode: 'teams' },
  { key: 'sla_pre_breach', label: 'SLA about to breach on my ticket', group: 'Deadlines', mode: 'teams' },
  { key: 'sla_breach', label: 'SLA breached on my ticket', group: 'Deadlines', mode: 'teams' },
  { key: 'approval_waiting', label: 'An approval is waiting for my decision', group: 'Approvals', mode: 'teams' },
  { key: 'group_unassigned', label: 'A new unassigned ticket arrives in my groups', group: 'My team', mode: 'off' },
];
const EVENT_KEYS = new Set(EVENTS.map((e) => e.key));
const MODES = new Set(['teams', 'digest', 'off']);

export const DEFAULT_OPTIONS = {
  respectAway: true, // silent on leave / outside work hours (urgent still comes)
  urgentBypassesQuiet: true, // urgent (P4 / SLA breach) comes through quiet hours
  groupMinPriority: 3, // group_unassigned: High and above
  dailyDigest: false,
  digestTime: '08:00',
};

/** Ticket event type → [preference key, recipient kind]. */
const EVENT_MAP = {
  'ticket.assigned': [['assigned', 'assignee']],
  'ticket.reassigned': [['assigned', 'assignee'], ['unassigned_from_me', 'previous']],
  'ticket.reply_received': [['requester_replied', 'assignee']],
  'ticket.note_added': [['teammate_update', 'assignee']],
  'ticket.public_reply_added': [['teammate_update', 'assignee']],
  'ticket.status_changed': [['status_changed', 'assignee']],
  'ticket.resolved_closed': [['status_changed', 'assignee']],
  'ticket.reopened': [['reopened', 'assignee']],
  'ticket.woke': [['park_woke', 'assignee']],
  'ticket.sla_pre_breach': [['sla_pre_breach', 'assignee']],
  'ticket.sla_breach': [['sla_breach', 'assignee']],
  'ticket.created': [['group_unassigned', 'group']],
};

const COALESCE_MS = 45_000;
const SNOOZE_MS = 4 * 3600 * 1000;
const MUTE_FOREVER = new Date('2999-01-01T00:00:00Z');
const PRIORITY_WORD = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

const baseUrl = () => resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
const lc = (s) => String(s || '').trim().toLowerCase();
const fmtDue = (d, tz) => {
  if (!d) return null;
  try { return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Los_Angeles' }).format(new Date(d)); } catch { return null; }
};
function localHHMM(tz, at = new Date()) {
  try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'America/Los_Angeles' }).format(at); } catch { return '12:00'; }
}
// Rows the digest card lists; the counts above them are not limited by it.
const DIGEST_ROWS = 10;

function localDay(tz, at = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Los_Angeles' }).format(at); } catch { return at.toISOString().slice(0, 10); }
}
function localWeekday(tz, at = new Date()) {
  try { return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz || 'America/Los_Angeles' }).format(at); } catch { return 'Mon'; }
}
function inWindow(start, end, now) {
  if (!start || !end) return false;
  return start <= end ? (now >= start && now < end) : (now >= start || now < end);
}

/** Merge workspace defaults and a person's own row into one effective view. */
export function effectivePrefs(wsDefaults = null, row = null) {
  const events = {};
  for (const e of EVENTS) {
    const own = row?.events?.[e.key];
    const ws = wsDefaults?.events?.[e.key];
    events[e.key] = MODES.has(own) ? own : (MODES.has(ws) ? ws : e.mode);
  }
  return { events, options: { ...DEFAULT_OPTIONS, ...(wsDefaults?.options || {}), ...(row?.options || {}) } };
}

/** Who did it? E-mail + technician id when the event carries them. */
export function eventActor(ctx) {
  const x = ctx?.event?.extra || {};
  return {
    email: lc(x.byEmail || x.actor?.email || x.actorEmail || x.forwardedBy || ''),
    technicianId: Number(x.actor?.technicianId || x.actorTechnicianId) || null,
  };
}

/** The line of text a card shows for an event. */
function eventText(eventKey, ctx) {
  const t = ctx.ticket || {};
  const x = ctx.event?.extra || {};
  switch (eventKey) {
  case 'assigned':
  case 'group_unassigned':
    return t.descriptionText || '';
  case 'teammate_update':
    return x.bodyText || (x.author ? `${x.author} added an update.` : '');
  case 'status_changed':
    return `Now ${t.status}${x.actor?.name ? ` — by ${x.actor.name}` : ''}.`;
  case 'reopened':
    return `Reopened${x.actor?.name ? ` by ${x.actor.name}` : ''}.`;
  case 'park_woke':
    return 'The park ended — it is back in your queue.';
  case 'unassigned_from_me':
    return ctx.assignedAgent?.name ? `Now with ${ctx.assignedAgent.name}.` : 'It is no longer assigned to you.';
  case 'sla_pre_breach':
    return t.dueBy ? `Due ${fmtDue(t.dueBy, ctx.workspace?.timezone)}.` : 'Due soon.';
  case 'sla_breach':
    return t.dueBy ? `Was due ${fmtDue(t.dueBy, ctx.workspace?.timezone)}.` : 'Past due.';
  default:
    return '';
  }
}

/** QA 10-01 #4: the person was disconnected by an admin - skip, never re-install. */
export class TeamsDisconnectedError extends Error {
  constructor(email) {
    super(`${email} is disconnected from Teams notifications`);
    this.name = 'TeamsDisconnectedError';
  }
}

class TeamsNotificationService {
  constructor() {
    this.pending = new Map(); // `${email}|${ticketId}` → { tech, lines, ctx, timer, urgent }
    this.nativeCache = new Map(); // workspaceId → { on, at }
    this.digestTimer = null;
  }

  // ------------------------------------------------------------ settings

  async workspaceSettings(workspaceId) {
    const row = await prisma.notificationWorkspaceSetting.findUnique({ where: { workspaceId: Number(workspaceId) } }).catch(() => null);
    return {
      workspaceId: Number(workspaceId),
      teamsEnabled: row?.teamsEnabled === true,
      defaults: row?.defaults || { events: {}, options: {} },
      channelWebhookUrl: row?.channelWebhookUrl || null,
      channelMinPriority: row?.channelMinPriority ?? 3,
    };
  }

  async saveWorkspaceSettings(workspaceId, input = {}, actorEmail = null) {
    const cur = await this.workspaceSettings(workspaceId);
    const defaults = cleanPrefs(input.defaults ?? cur.defaults);
    const url = input.channelWebhookUrl === undefined ? cur.channelWebhookUrl : (String(input.channelWebhookUrl || '').trim() || null);
    if (url && !/^https:\/\/[^\s]+$/i.test(url)) throw Object.assign(new Error('The channel webhook must be an https:// URL'), { statusCode: 400 });
    const data = {
      teamsEnabled: input.teamsEnabled === undefined ? cur.teamsEnabled : input.teamsEnabled === true,
      defaults,
      channelWebhookUrl: url,
      channelMinPriority: Math.min(4, Math.max(1, Number(input.channelMinPriority ?? cur.channelMinPriority) || 3)),
      updatedBy: actorEmail,
    };
    await prisma.notificationWorkspaceSetting.upsert({ where: { workspaceId: Number(workspaceId) }, update: data, create: { workspaceId: Number(workspaceId), ...data } });
    return this.workspaceSettings(workspaceId);
  }

  async _prefsFor(workspaceId, technicianId, ws = null) {
    const settings = ws || await this.workspaceSettings(workspaceId);
    const row = await prisma.notificationPreference.findUnique({ where: { workspaceId_technicianId: { workspaceId: Number(workspaceId), technicianId } } }).catch(() => null);
    return { ...effectivePrefs(settings.defaults, row), row };
  }

  async _nativeOn(workspaceId) {
    const hit = this.nativeCache.get(workspaceId);
    if (hit && hit.at > Date.now() - 300_000) return hit.on;
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { nativeTicketingEnabled: true } }).catch(() => null);
    const on = ws?.nativeTicketingEnabled === true;
    this.nativeCache.set(workspaceId, { on, at: Date.now() });
    return on;
  }

  // ------------------------------------------------------------ conversations

  /** The person's chat with the bot; installs the app for them first when needed. */
  async ensureConversation(email, { install = true, reconnect = false } = {}) {
    const key = lc(email);
    if (!key) throw new Error('No e-mail address');
    let row = await prisma.teamsConversation.findUnique({ where: { email: key } });
    // QA 10-01 #4: a disconnected person is never re-installed behind the
    // admin's back - only an explicit Connect (reconnect) clears the mark.
    if (row?.disconnectedAt) {
      if (!reconnect) throw new TeamsDisconnectedError(key);
      row = await prisma.teamsConversation.update({ where: { email: key }, data: { disconnectedAt: null, disconnectedBy: null } });
    }
    if (row?.conversationId) return row;
    let aad = row?.aadObjectId;
    try {
      if (!aad) {
        const user = await bot.findUser(key);
        if (!user?.id) throw new Error(`${key} is not in Microsoft Entra`);
        aad = user.id;
      }
      if (install) {
        const r = await bot.installForUser(aad);
        if (r === 'no_catalog_app') throw new Error('The Ticket Pulse app is not in the Teams app catalog yet — an admin uploads backend/teams-app/ticket-pulse-teams.zip');
      }
      const conv = await bot.createPersonalConversation({ aadObjectId: aad });
      return prisma.teamsConversation.upsert({
        where: { email: key },
        update: { aadObjectId: aad, conversationId: conv.conversationId, serviceUrl: conv.serviceUrl, tenantId: bot.teamsConfig().tenantId, installedAt: row?.installedAt || new Date(), lastError: null },
        create: { email: key, aadObjectId: aad, conversationId: conv.conversationId, serviceUrl: conv.serviceUrl, tenantId: bot.teamsConfig().tenantId, installedAt: new Date() },
      });
    } catch (err) {
      const msg = bot.describeError(err);
      await prisma.teamsConversation.upsert({
        where: { email: key },
        update: { aadObjectId: aad || null, lastError: msg },
        create: { email: key, aadObjectId: aad || null, lastError: msg },
      }).catch(() => {});
      throw new Error(msg);
    }
  }

  async _send(email, card, { summary, workspaceId = null, technicianId = null, ticketId = null, eventKey = 'test', bell = null, refKey = null } = {}) {
    let conv;
    try {
      conv = await this.ensureConversation(email);
    } catch (err) {
      if (!(err instanceof TeamsDisconnectedError)) throw err;
      await this._record({ workspaceId, email, technicianId, ticketId, eventKey, status: 'skipped', reason: 'disconnected', summary });
      return null;
    }
    let activityId = null;
    try {
      activityId = await bot.sendToConversation(conv, bot.cardActivity(card, { summary }));
    } catch (err) {
      // A stale conversation (app removed) — forget it once and retry through a fresh install.
      if ([403, 404].includes(err.response?.status)) {
        await prisma.teamsConversation.update({ where: { email: lc(email) }, data: { conversationId: null, lastError: bot.describeError(err) } }).catch(() => {});
        const fresh = await this.ensureConversation(email);
        activityId = await bot.sendToConversation(fresh, bot.cardActivity(card, { summary }));
      } else {
        throw err;
      }
    }
    if (bell && conv.aadObjectId) {
      bot.sendActivityFeed(conv.aadObjectId, bell).catch((err) => logger.warn(`Teams bell notification failed for ${email}: ${bot.describeError(err)}`));
    }
    // refKey (5 Oct 2026): what the card is about (e.g. approval:<id>), kept in
    // `reason` on sent rows so the card can be updated when that thing changes.
    await prisma.teamsDelivery.create({ data: { workspaceId, email: lc(email), technicianId, ticketId, eventKey, status: 'sent', activityId, conversationId: conv.conversationId, ...(refKey ? { reason: String(refKey).slice(0, 120) } : {}), summary: summary ? String(summary).slice(0, 500) : null } }).catch(() => {});
    return activityId;
  }

  async _record(data) {
    await prisma.teamsDelivery.create({ data: { ...data, email: lc(data.email), summary: data.summary ? String(data.summary).slice(0, 500) : null } }).catch(() => {});
  }

  // ------------------------------------------------------------ events

  /** Fire-and-forget from the lifecycle service; never throws. */
  onTicketEvent(ctx) {
    if (!bot.isTeamsConfigured()) return;
    this._onTicketEvent(ctx).catch((err) => logger.warn(`Teams notification skipped for ${ctx?.event?.type} on ticket ${ctx?.ticket?.id}: ${err.message}`));
  }

  async _onTicketEvent(ctx) {
    const map = EVENT_MAP[ctx?.event?.type];
    const workspaceId = Number(ctx?.workspace?.id);
    if (!map || !workspaceId || !ctx.ticket?.id) return;
    const ws = await this.workspaceSettings(workspaceId);
    const x = ctx.event.extra || {};

    // Team channel feed: new unassigned tickets at/above the chosen priority.
    if (ctx.event.type === 'ticket.created' && ws.channelWebhookUrl && !ctx.assignedAgent && !ctx.ticket.isNoise
      && Number(ctx.ticket.priority || 0) >= ws.channelMinPriority) {
      this._ticketModelById(ctx.ticket.id, workspaceId)
        .then((model) => bot.postToWorkflowWebhook(ws.channelWebhookUrl, ticketCard({ ...(model || this._ticketModel(ctx, {})), canWrite: false, isUnassigned: false }, [{ eventKey: 'group_unassigned' }], { actionsOff: true })))
        .catch((err) => logger.warn(`Teams channel feed post failed (ws ${workspaceId}): ${bot.describeError(err)}`));
    }
    if (!ws.teamsEnabled) return;
    if (ctx.event.type === 'ticket.note_added' && x.systemNote === true) return;
    if (ctx.event.type === 'ticket.created' && (ctx.assignedAgent || ctx.ticket.isNoise)) return;

    const actor = eventActor(ctx);
    for (const [eventKey, who] of map) {
      const people = await this._recipients(who, ctx, workspaceId);
      for (const tech of people) {
        await this._consider(tech, eventKey, ctx, ws, actor);
      }
    }
  }

  async _recipients(kind, ctx, workspaceId) {
    const pick = async (p) => {
      if (!p?.id) return [];
      const t = await prisma.technician.findFirst({ where: { id: Number(p.id), workspaceId }, select: { id: true, name: true, email: true, timezone: true, workStartTime: true, workEndTime: true } });
      return t?.email ? [t] : [];
    };
    if (kind === 'assignee') return pick(ctx.assignedAgent);
    if (kind === 'previous') return pick(ctx.previousAgent);
    // group: the ticket's group members, else nobody (no guessing).
    const groupId = ctx.ticket.groupId; // FreshService group id (string)
    if (!groupId || !/^\d+$/.test(String(groupId))) return [];
    const group = await prisma.group.findFirst({ where: { workspaceId, freshserviceId: BigInt(groupId) }, select: { id: true } }).catch(() => null);
    if (!group) return [];
    const members = await prisma.groupMember.findMany({ where: { groupId: group.id, workspaceId }, select: { technicianId: true } });
    if (!members.length) return [];
    return prisma.technician.findMany({
      where: { id: { in: members.map((m) => m.technicianId) }, workspaceId, isActive: true, email: { not: null } },
      select: { id: true, name: true, email: true, timezone: true, workStartTime: true, workEndTime: true },
    });
  }

  /** Apply the person's rules; queue for a card, hold for the digest, or skip. */
  async _consider(tech, eventKey, ctx, ws, actor) {
    const prefs = await this._prefsFor(ctx.workspace.id, tech.id, ws);
    const mode = prefs.events[eventKey];
    if (mode === 'off') return;
    const base = { workspaceId: ctx.workspace.id, email: tech.email, technicianId: tech.id, ticketId: ctx.ticket.id, eventKey };
    const summary = `${ctx.ticket.displayRef} ${ctx.ticket.subject || ''}`.trim();

    // Never about your own action.
    if ((actor.email && actor.email === lc(tech.email)) || (actor.technicianId && actor.technicianId === tech.id)) return;
    if (eventKey === 'group_unassigned' && Number(ctx.ticket.priority || 0) < Number(prefs.options.groupMinPriority || 3)) return;

    const mute = await prisma.ticketNotificationMute.findUnique({ where: { technicianId_ticketId: { technicianId: tech.id, ticketId: ctx.ticket.id } } }).catch(() => null);
    if (mute && mute.until > new Date()) { await this._record({ ...base, status: 'skipped', reason: 'muted', summary }); return; }

    if (mode === 'digest') { await this._record({ ...base, status: 'digest', summary: `${summary} — ${eventText(eventKey, ctx)}` }); return; }

    const urgent = eventKey === 'sla_breach' || Number(ctx.ticket.priority || 0) >= 4;
    if (prefs.options.respectAway && !urgent) {
      const away = await this._awayReason(tech, ctx.workspace.id);
      if (away) { await this._record({ ...base, status: 'skipped', reason: away, summary }); return; }
    }
    const quiet = await this._inQuietHours(tech);
    if (quiet && !(urgent && prefs.options.urgentBypassesQuiet)) { await this._record({ ...base, status: 'skipped', reason: 'quiet_hours', summary }); return; }

    this._queue(tech, eventKey, ctx, urgent);
  }

  async _awayReason(tech, workspaceId) {
    const tz = tech.timezone || 'America/Los_Angeles';
    const day = localDay(tz);
    const leave = await prisma.technicianLeave.findFirst({
      where: { workspaceId, technicianId: tech.id, leaveDate: new Date(`${day}T00:00:00Z`) },
    }).catch(() => null);
    if (leave && leave.category !== 'WFH') {
      if (leave.isFullDay !== false) return 'on_leave';
      const [h, m] = localHHMM(tz).split(':').map(Number);
      const minute = h * 60 + m;
      if (Number.isFinite(leave.startMinute) && Number.isFinite(leave.endMinute) && minute >= leave.startMinute && minute < leave.endMinute) return 'on_leave';
    }
    if (tech.workStartTime && tech.workEndTime) {
      if (['Sat', 'Sun'].includes(localWeekday(tz))) return 'off_shift';
      if (!inWindow(tech.workStartTime, tech.workEndTime, localHHMM(tz))) return 'off_shift';
    }
    return null;
  }

  async _inQuietHours(tech) {
    const pref = await prisma.technicianNotificationPreference.findUnique({ where: { technicianId: tech.id } }).catch(() => null);
    if (!pref?.quietHoursEnabled) return false;
    return inWindow(pref.quietHoursStart, pref.quietHoursEnd, localHHMM(tech.timezone));
  }

  /** Coalesce: everything for the same person + ticket within 45 s becomes one card. */
  _queue(tech, eventKey, ctx, urgent) {
    const key = `${lc(tech.email)}|${ctx.ticket.id}`;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { tech, lines: [], ctx, urgent: false, timer: null };
      this.pending.set(key, entry);
      entry.timer = setTimeout(() => this._flush(key), COALESCE_MS);
      entry.timer.unref?.();
    }
    entry.ctx = ctx; // newest state of the ticket wins
    if (!entry.lines.some((l) => l.eventKey === eventKey)) entry.lines.unshift({ eventKey, ctx, at: new Date() });
    if (urgent) {
      entry.urgent = true;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this._flush(key), 1_000);
      entry.timer.unref?.();
    }
  }

  async _flush(key) {
    const entry = this.pending.get(key);
    this.pending.delete(key);
    if (!entry) return;
    const { tech, ctx } = entry;
    try {
      const lines = [];
      for (const l of entry.lines) {
        const x = l.ctx.event?.extra || {};
        let text = textToCardMarkdown(eventText(l.eventKey, l.ctx));
        let who = null;
        if (l.eventKey === 'requester_replied') {
          who = l.ctx.requester?.name || null;
          if (x.entryId) {
            const e = await prisma.ticketThreadEntry.findUnique({ where: { id: Number(x.entryId) }, select: { bodyHtml: true, bodyText: true } }).catch(() => null);
            if (e) text = e.bodyHtml ? htmlToCardMarkdown(e.bodyHtml) : textToCardMarkdown(e.bodyText);
          }
        } else if (l.eventKey === 'teammate_update') {
          who = x.author || null;
        }
        lines.push({ eventKey: l.eventKey, text, who, at: l.at });
      }
      const model = await this._ticketModelById(ctx.ticket.id, ctx.workspace.id)
        || this._ticketModel(ctx, { canWrite: await this._nativeOn(ctx.workspace.id), isUnassigned: !ctx.assignedAgent });
      const card = ticketCard(model, lines);
      const first = lines[0];
      const word = EVENT_META[first.eventKey]?.heading || 'Update';
      const bell = ['sla_breach', 'sla_pre_breach'].includes(first.eventKey) || entry.urgent
        ? { title: `${word}: ${ctx.ticket.displayRef} ${ctx.ticket.subject || ''}`.slice(0, 150), preview: String(first.text || '').replace(/[*_#[\]()]/g, '').slice(0, 150), webUrl: this._ticketUrl(ctx.ticket.id) }
        : null;
      await this._send(tech.email, card, {
        summary: `${word} — ${ctx.ticket.displayRef} ${ctx.ticket.subject || ''}`,
        workspaceId: ctx.workspace.id, technicianId: tech.id, ticketId: ctx.ticket.id, eventKey: first.eventKey, bell,
      });
    } catch (err) {
      logger.warn(`Teams card to ${tech.email} for ticket ${ctx.ticket.id} failed: ${err.message}`);
      await this._record({ workspaceId: ctx.workspace.id, email: tech.email, technicianId: tech.id, ticketId: ctx.ticket.id, eventKey: entry.lines[0]?.eventKey || 'unknown', status: 'failed', reason: String(err.message).slice(0, 120) });
    }
  }

  _ticketUrl(ticketId) { return `${baseUrl()}/tickets/${ticketId}`; }

  _ticketModel(ctx, { canWrite, isUnassigned }) {
    const t = ctx.ticket;
    return {
      id: t.id,
      workspaceId: ctx.workspace.id,
      ref: t.displayRef,
      subject: t.subject,
      requesterName: ctx.requester?.name || null,
      priority: t.priority,
      priorityLabel: t.priorityLabel || PRIORITY_WORD[t.priority] || null,
      dueLabel: fmtDue(t.dueBy, ctx.workspace.timezone),
      categoryTop: t.internalCategory?.name || t.category || null,
      categorySub: t.internalSubcategory?.name || t.subCategory || null,
      descriptionMd: textToCardMarkdown(t.descriptionText),
      url: this._ticketUrl(t.id),
      canWrite: Boolean(canWrite),
      isUnassigned: Boolean(isUnassigned),
    };
  }

  /** Same model from a database row (card actions re-render from fresh data). */
  async _ticketModelById(ticketId, workspaceId) {
    const t = await prisma.ticket.findFirst({
      where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
      select: {
        id: true, workspaceId: true, subject: true, priority: true, dueBy: true, freshserviceTicketId: true, nativeNumber: true, origin: true,
        assignedTechId: true, category: true, subCategory: true, description: true, descriptionText: true,
        internalCategory: { select: { name: true } }, internalSubcategory: { select: { name: true } },
        requester: { select: { name: true, jobTitle: true, entraOfficeLocation: true, entraCity: true } },
        workspace: { select: { defaultTimezone: true } },
      },
    });
    if (!t) return null;
    const r = t.requester || {};
    return {
      id: t.id,
      workspaceId: t.workspaceId,
      ref: ticketDisplayRef(t),
      subject: t.subject,
      url: this._ticketUrl(t.id),
      canWrite: await this._nativeOn(t.workspaceId),
      isUnassigned: !t.assignedTechId,
      categoryTop: t.internalCategory?.name || t.category || null,
      categorySub: t.internalSubcategory?.name || t.subCategory || null,
      priority: t.priority,
      priorityLabel: PRIORITY_WORD[t.priority] || null,
      dueLabel: fmtDue(t.dueBy, t.workspace?.defaultTimezone),
      overdue: Boolean(t.dueBy && t.dueBy < new Date()),
      requesterName: r.name || null,
      requesterPlace: [r.jobTitle, r.entraOfficeLocation || r.entraCity].filter(Boolean).join(' · ') || null,
      descriptionMd: t.description ? htmlToCardMarkdown(t.description) : textToCardMarkdown(t.descriptionText),
    };
  }

  // ------------------------------------------------------------ approvals

  /** Approver card (Phase 3). Fire-and-forget from _emailApprover. */
  notifyApproval(input) {
    if (!bot.isTeamsConfigured()) return;
    this._notifyApproval(input).catch((err) => logger.warn(`Teams approval card to ${input?.approval?.approverEmail} skipped: ${err.message}`));
  }

  async _notifyApproval({ approval, ticket, decisionUrl, categoryName, requestedByName, note }) {
    const ws = await this.workspaceSettings(ticket.workspaceId);
    if (!ws.teamsEnabled) return;
    const email = lc(approval.approverEmail);
    const tech = await prisma.technician.findFirst({ where: { workspaceId: ticket.workspaceId, email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
    if (tech) {
      const prefs = await this._prefsFor(ticket.workspaceId, tech.id, ws);
      if (prefs.events.approval_waiting === 'off') return;
    }
    const a = {
      approvalId: approval.id, ticketId: ticket.id, workspaceId: ticket.workspaceId, categoryName,
      ref: ticketDisplayRef(ticket), subject: ticket.subject, requesterName: ticket.requester?.name || null,
      askedByName: requestedByName, noteMd: textToCardMarkdown(note), decisionUrl,
      tierLabel: approval.tier && approval.tier > 1 ? `Tier ${approval.tier}` : null,
    };
    await this._send(email, approvalCard(a), {
      summary: `Approval waiting: ${categoryName || ticket.subject || ''}`,
      workspaceId: ticket.workspaceId, technicianId: tech?.id || null, ticketId: ticket.id, eventKey: 'approval_waiting', refKey: `approval:${approval.id}`,
      bell: { title: `Approval waiting: ${categoryName || ticket.subject || ''}`.slice(0, 150), preview: note || ticket.subject, webUrl: decisionUrl },
    });
  }

  async _approvalModel(approvalId, ticketId, workspaceId, decisionUrl = null) {
    const ap = await prisma.ticketApproval.findFirst({ where: { id: Number(approvalId), ticketId: Number(ticketId), workspaceId: Number(workspaceId) } });
    if (!ap) return null;
    const t = await prisma.ticket.findFirst({ where: { id: ap.ticketId }, select: { id: true, subject: true, freshserviceTicketId: true, nativeNumber: true, origin: true, requester: { select: { name: true } } } });
    const cat = ap.approvalCategoryId ? await prisma.approvalCategory.findUnique({ where: { id: ap.approvalCategoryId }, select: { name: true } }).catch(() => null) : null;
    const last = await prisma.teamsDelivery.findFirst({ where: { ticketId: ap.ticketId, eventKey: 'approval_waiting', email: lc(ap.approverEmail) }, orderBy: { id: 'desc' }, select: { id: true } });
    return {
      approval: ap,
      model: {
        approvalId: ap.id, ticketId: ap.ticketId, workspaceId: ap.workspaceId, categoryName: cat?.name || null,
        ref: t ? ticketDisplayRef(t) : null, subject: t?.subject || null, requesterName: t?.requester?.name || null,
        askedByName: null, noteMd: textToCardMarkdown(ap.requestNote), tierLabel: ap.tier && ap.tier > 1 ? `Tier ${ap.tier}` : null,
        // The approver's own link rides in the card data (the token is stored hashed).
        decisionUrl: decisionUrl && String(decisionUrl).startsWith(baseUrl()) ? decisionUrl : `${baseUrl()}/approvals`,
        lastDeliveryId: last?.id || null,
      },
    };
  }

  /**
   * Approval cards follow the approval (5 Oct 2026). When an approval on this
   * ticket is decided, cancelled, superseded, handed on or withdrawn anywhere
   * (Ticket Pulse, the e-mail link, another approver), every approval card
   * already sent for it is rewritten in place so nobody acts on a stale card.
   * Cards still waiting (pending / question asked) are left alone.
   * Fire-and-forget; never throws.
   */
  refreshApprovalCards(ticketId) {
    if (!bot.isTeamsConfigured() || !Number(ticketId)) return;
    this._refreshApprovalCards(Number(ticketId)).catch((err) => logger.warn(`Teams approval cards for ticket ${ticketId} not refreshed: ${err.message}`));
  }

  async _refreshApprovalCards(ticketId) {
    const rows = await prisma.teamsDelivery.findMany({
      where: { ticketId, eventKey: 'approval_waiting', status: 'sent', activityId: { not: null }, createdAt: { gte: new Date(Date.now() - 45 * 86400_000) } },
      orderBy: { id: 'asc' },
      take: 25,
    });
    if (!rows.length) return 0;
    const approvals = await prisma.ticketApproval.findMany({ where: { ticketId }, orderBy: { id: 'asc' } });
    let updated = 0;
    for (const row of rows) {
      const ref = /^approval:(\d+)$/.exec(String(row.reason || ''));
      let ap = null;
      if (ref) {
        ap = approvals.find((a) => a.id === Number(ref[1])) || null;
      } else {
        // Cards sent before refKey existed: the latest approval addressed to
        // this person that existed when the card went out.
        const sentAt = new Date(row.createdAt).getTime() + 60_000;
        ap = approvals.filter((a) => lc(a.approverEmail) === lc(row.email) && new Date(a.createdAt).getTime() <= sentAt).pop() || null;
        if (!ap) continue;
      }
      let card;
      if (!ap) {
        card = textCard('This approval request was withdrawn', ['Nothing is needed from you.']);
      } else {
        const stage = approvalClosedStage(ap, row.email);
        if (!stage) continue;
        const found = await this._approvalModel(ap.id, ap.ticketId, ap.workspaceId);
        if (!found) continue;
        card = approvalCard(found.model, stage);
      }
      const conv = await prisma.teamsConversation.findUnique({ where: { email: lc(row.email) } }).catch(() => null);
      if (!conv?.serviceUrl || !row.conversationId) continue;
      try {
        await bot.updateActivity({ serviceUrl: conv.serviceUrl, conversationId: row.conversationId, activityId: row.activityId }, bot.cardActivity(card, { summary: 'Approval updated' }));
        updated++;
      } catch (err) {
        logger.warn(`Teams approval card ${row.id} (${row.email}) not updated: ${bot.describeError(err)}`);
      }
    }
    if (updated) logger.info(`Teams: ${updated} approval card(s) on ticket ${ticketId} updated`);
    return updated;
  }

  // ------------------------------------------------------------ bot endpoint

  /**
   * Handle one inbound Bot Framework activity. Returns the HTTP body for an
   * invoke (card actions), or null for everything else.
   */
  async handleActivity(activity) {
    const type = activity?.type;
    if (type === 'conversationUpdate' || type === 'installationUpdate') {
      await this._rememberConversation(activity);
      return null;
    }
    if (type === 'message') {
      await this._onMessage(activity);
      return null;
    }
    if (type === 'invoke' && activity.name === 'adaptiveCard/action') {
      return this._onAction(activity);
    }
    return null;
  }

  async _emailForActivity(activity) {
    const aad = activity?.from?.aadObjectId;
    if (!aad) return null;
    const row = await prisma.teamsConversation.findFirst({ where: { aadObjectId: aad } });
    if (row?.email) return row.email;
    const user = await bot.findUser(aad).catch(() => null);
    return lc(user?.mail || user?.userPrincipalName) || null;
  }

  async _rememberConversation(activity) {
    if (activity.conversation?.conversationType && activity.conversation.conversationType !== 'personal') return;
    if (activity.type === 'installationUpdate' && activity.action && !String(activity.action).startsWith('add')) return;
    const aad = activity.from?.aadObjectId;
    if (!aad || !activity.conversation?.id) return;
    const email = await this._emailForActivity(activity);
    if (!email) return;
    const prev = await prisma.teamsConversation.findUnique({ where: { email } });
    await prisma.teamsConversation.upsert({
      where: { email },
      // The person adding the app back themselves (installationUpdate add) is
      // their own reconnect; any other update keeps an admin's disconnect.
      update: { aadObjectId: aad, conversationId: activity.conversation.id, serviceUrl: activity.serviceUrl, tenantId: activity.conversation.tenantId || activity.channelData?.tenant?.id || null, installedAt: prev?.installedAt || new Date(), lastError: null, ...(activity.type === 'installationUpdate' ? { disconnectedAt: null, disconnectedBy: null } : {}) },
      create: { email, aadObjectId: aad, conversationId: activity.conversation.id, serviceUrl: activity.serviceUrl, tenantId: activity.conversation.tenantId || activity.channelData?.tenant?.id || null, installedAt: new Date() },
    });
    const stillDisconnected = prev?.disconnectedAt && activity.type !== 'installationUpdate';
    if (prev?.conversationId !== activity.conversation.id && !stillDisconnected) {
      await bot.sendToConversation({ serviceUrl: activity.serviceUrl, conversationId: activity.conversation.id }, bot.cardActivity(this._helpCard(), { summary: 'Ticket Pulse is connected' })).catch(() => {});
    }
  }

  _helpCard() {
    return textCard('Ticket Pulse is connected', [
      'You will get a message here when a ticket is assigned to you, the requester replies, an SLA is close to breaching, an approval waits for you, and more.',
      'Take a ticket, add a note, reply or snooze straight from the card. Type **my tickets** for your open tickets.',
      'New: paste a screenshot or a chat here and Ticket Pulse fills in a ticket for you to create in one click.',
    ], [{ type: 'Action.OpenUrl', title: 'Choose what you are told about', url: `${baseUrl()}/mail-alerts` }]);
  }

  async _onMessage(activity) {
    const text = lc(String(activity.text || '').replace(/<[^>]+>/g, ''));
    const email = await this._emailForActivity(activity);
    // QA 10-01 #3: a screenshot or a pasted chat (not a command) → Autofill.
    // It answers with its own card and fills it in the background.
    const intake = await import('./teamsIntakeService.js');
    if (intake.wantsAutofill(activity)) {
      intake.default.handleMessage(activity, email).catch((err) => logger.warn(`Teams Autofill failed: ${err.message}`));
      return;
    }
    let card;
    if (text.includes('my tickets') && email) {
      card = await this._digestCardFor(email).catch(() => null);
      if (!card) card = textCard('No open tickets found for you', [`Signed in as ${email}.`]);
    } else if (text.includes('setting')) {
      card = textCard('Your Teams notifications', ['Choose what Ticket Pulse tells you about, quiet hours and the daily digest.'], [{ type: 'Action.OpenUrl', title: 'Open My Alerts', url: `${baseUrl()}/mail-alerts` }]);
    } else {
      card = this._helpCard();
    }
    await bot.replyToActivity(activity, bot.cardActivity(card)).catch((err) => logger.warn(`Teams reply failed: ${bot.describeError(err)}`));
  }

  async _onAction(activity) {
    const action = activity.value?.action || {};
    const verb = String(action.verb || '');
    const data = action.data || {};
    const toast = (msg) => ({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: msg });
    const cardRes = (card) => ({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card });
    const email = await this._emailForActivity(activity);
    if (!email) return toast('Ticket Pulse could not tell who you are.');
    const workspaceId = Number(data.workspaceId);
    const ticketId = Number(data.ticketId);

    try {
      if (verb.startsWith('approval.')) return cardRes(await this._approvalAction(verb, data, email));
      if (verb.startsWith('autofill.')) {
        const { default: teamsIntakeService } = await import('./teamsIntakeService.js');
        return cardRes(await teamsIntakeService.handleAction(verb, data, email, activity));
      }

      const tech = await prisma.technician.findFirst({ where: { workspaceId, email: { equals: email, mode: 'insensitive' } }, select: { id: true, name: true, email: true } });
      if (!tech) return toast('You are not an agent in this workspace.');
      const actor = { email: lc(tech.email), name: tech.name, role: 'agent', workspaceRole: null, technicianId: tech.id, kind: 'agent', via: 'teams' };
      const model = await this._ticketModelById(ticketId, workspaceId);
      if (!model) return toast('That ticket no longer exists.');
      const { default: ticketService } = await import('./ticketService.js');

      if (verb === 'take') {
        if (!model.isUnassigned) return cardRes(ticketCard({ ...model, isUnassigned: false }, [], { outcome: OUTCOMES.already }));
        await ticketService.assignTicket(ticketId, workspaceId, tech.id, actor);
        return cardRes(ticketCard({ ...model, isUnassigned: false }, [], { outcome: OUTCOMES.taken }));
      }
      if (verb === 'note' || verb === 'reply') {
        const body = String(data[verb === 'note' ? 'noteText' : 'replyText'] || '').trim();
        if (!body) return toast('Write something first.');
        if (!model.canWrite) return toast('Notes and replies from Teams need native ticketing in this workspace — open the ticket instead.');
        const input = { bodyText: body, bodyHtml: `<p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` };
        if (verb === 'note') await ticketService.addPrivateNote(ticketId, workspaceId, input, actor);
        else await ticketService.addReply(ticketId, workspaceId, input, actor);
        return cardRes(ticketCard(model, [], { outcome: { ...OUTCOMES[verb], detail: body.length > 160 ? `${body.slice(0, 159)}…` : body } }));
      }
      if (verb === 'snooze' || verb === 'mute') {
        const until = verb === 'snooze' ? new Date(Date.now() + SNOOZE_MS) : MUTE_FOREVER;
        await prisma.ticketNotificationMute.upsert({ where: { technicianId_ticketId: { technicianId: tech.id, ticketId } }, update: { until }, create: { technicianId: tech.id, ticketId, until } });
        return cardRes(ticketCard(model, [], { outcome: OUTCOMES[verb] }));
      }
      return toast('Unknown action.');
    } catch (err) {
      logger.warn(`Teams card action ${verb} by ${email} failed: ${err.message}`);
      return toast(`That did not work: ${String(err.message).slice(0, 200)}`);
    }
  }

  async _approvalAction(verb, data, email) {
    const found = await this._approvalModel(data.approvalId, data.ticketId, data.workspaceId, data.decisionUrl);
    if (!found) return textCard('This approval no longer exists');
    const { approval, model } = found;
    if (lc(approval.approverEmail) !== lc(email)) return approvalCard(model, 'ask', { error: 'Only the named approver can decide this approval.' });
    if (approval.status !== 'pending' && approval.status !== 'info_requested') {
      return approvalCard(model, { done: approval.status === 'approved' ? 'approved' : approval.status === 'rejected' ? 'rejected' : 'closed', detail: `This approval is ${approval.status}.` });
    }
    if (verb === 'approval.back') return approvalCard(model, 'ask');
    const decision = data.decision === 'rejected' ? 'rejected' : 'approved';
    if (verb === 'approval.prepare') return approvalCard(model, { confirm: decision });
    if (verb === 'approval.confirm') {
      const note = String(data.decisionNote || '').trim() || null;
      if (decision === 'rejected' && !note) return approvalCard(model, { confirm: decision }, { error: 'Add a reason for not approving.' });
      const person = await bot.findUser(email).catch(() => null);
      const actor = { email: lc(email), name: person?.displayName || email };
      const { default: ticketApprovalService } = await import('./ticketApprovalService.js');
      await ticketApprovalService.decideInApp(approval.ticketId, approval.workspaceId, approval.id, decision, note, actor);
      return approvalCard(model, { done: decision, detail: note ? `Your note: ${note}` : 'Recorded on the ticket; the agent is told.' });
    }
    return approvalCard(model, 'ask');
  }

  // ------------------------------------------------------------ digest

  start() {
    if (this.digestTimer || !bot.isTeamsConfigured()) return;
    this.digestTimer = setInterval(() => this.runDigests().catch((err) => logger.warn(`Teams digest run failed: ${err.message}`)), 10 * 60 * 1000);
    this.digestTimer.unref?.();
  }

  async runDigests(now = new Date()) {
    const rows = await prisma.notificationPreference.findMany({});
    for (const row of rows) {
      const ws = await this.workspaceSettings(row.workspaceId);
      if (!ws.teamsEnabled) continue;
      const prefs = effectivePrefs(ws.defaults, row);
      const wantsDigest = prefs.options.dailyDigest || Object.values(prefs.events).includes('digest');
      if (!wantsDigest) continue;
      const tech = await prisma.technician.findUnique({ where: { id: row.technicianId }, select: { id: true, name: true, email: true, timezone: true } });
      if (!tech?.email) continue;
      const tz = tech.timezone || 'America/Los_Angeles';
      if (localHHMM(tz, now) < (prefs.options.digestTime || '08:00')) continue;
      if (row.lastDigestAt && localDay(tz, row.lastDigestAt) === localDay(tz, now)) continue;
      if (['Sat', 'Sun'].includes(localWeekday(tz, now))) continue;
      try {
        const card = await this._digestCardFor(tech.email, { workspaceId: row.workspaceId, since: row.lastDigestAt });
        if (card) await this._send(tech.email, card, { summary: 'Your tickets today', workspaceId: row.workspaceId, technicianId: tech.id, eventKey: 'digest' });
      } catch (err) {
        logger.warn(`Teams digest for ${tech.email} failed: ${err.message}`);
      }
      await prisma.notificationPreference.update({ where: { id: row.id }, data: { lastDigestAt: now } }).catch(() => {});
    }
  }

  async _digestCardFor(email, { workspaceId = null, since = null } = {}) {
    const techs = await prisma.technician.findMany({ where: { email: { equals: lc(email), mode: 'insensitive' }, ...(workspaceId ? { workspaceId } : {}) }, select: { id: true, name: true, workspaceId: true, timezone: true } });
    if (!techs.length) return null;
    // 7 Oct 2026 (Vahid's digest read "200 open, 200 overdue"): "open" was
    // "no resolved or closed date", which also matched 178 Closed and 70
    // Deleted tickets that never got those dates, and the three numbers were
    // counted from a list capped at 200 rows. Open now means an Open- or
    // Pending-base status in the ticket's own workspace (the same rule as the
    // Tickets page), and the numbers are real counts.
    const where = { OR: await this._openTicketScopes(techs), isNoise: false };
    const now = new Date();
    const tz = techs[0].timezone || 'America/Los_Angeles';
    const today = localDay(tz, now);
    const [open, openCount, overdueCount, nearDue] = await Promise.all([
      prisma.ticket.findMany({
        where,
        select: { id: true, subject: true, dueBy: true, priority: true, freshserviceTicketId: true, nativeNumber: true, origin: true },
        orderBy: [{ dueBy: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }],
        take: DIGEST_ROWS,
      }),
      prisma.ticket.count({ where }),
      prisma.ticket.count({ where: { ...where, dueBy: { lt: now } } }),
      // "Due today" is a local calendar day: read the due times around now and test each in the agent's time zone.
      prisma.ticket.findMany({ where: { ...where, dueBy: { gte: new Date(now.getTime() - 36 * 3600 * 1000), lte: new Date(now.getTime() + 36 * 3600 * 1000) } }, select: { dueBy: true }, take: 1000 }),
    ]);
    const dueTodayCount = nearDue.filter((t) => t.dueBy && localDay(tz, t.dueBy) === today).length;
    const rows = open.map((t) => ({
      ref: ticketDisplayRef(t), subject: t.subject, url: this._ticketUrl(t.id), priority: t.priority,
      overdue: Boolean(t.dueBy && t.dueBy < now), dueLabel: t.dueBy ? fmtDue(t.dueBy, tz) : '',
      dueToday: Boolean(t.dueBy && localDay(tz, t.dueBy) === today),
    }));
    const held = await prisma.teamsDelivery.findMany({
      where: { email: lc(email), status: 'digest', ...(since ? { createdAt: { gt: since } } : { createdAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) } }) },
      orderBy: { id: 'desc' }, take: 8, select: { eventKey: true, summary: true },
    });
    return digestCard({
      name: techs[0].name,
      counts: { open: openCount, overdue: overdueCount, dueToday: dueTodayCount, waiting: 0 },
      rows,
      held,
      queueUrl: `${baseUrl()}/tickets?view=mine`,
    });
  }

  /**
   * One { workspace, my technician ids there, open-like status names } scope
   * per workspace the person is an agent in. Status names come from the
   * workspace's registry (custom open/pending statuses count); a registry
   * that cannot be read falls back to Open / Pending.
   */
  async _openTicketScopes(techs) {
    const byWs = new Map();
    for (const t of techs) {
      if (!byWs.has(t.workspaceId)) byWs.set(t.workspaceId, []);
      byWs.get(t.workspaceId).push(t.id);
    }
    const scopes = [];
    for (const [workspaceId, ids] of byWs) {
      let names = ['Open', 'Pending'];
      try {
        const { default: statusService } = await import('./statusService.js');
        const found = await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']);
        if (Array.isArray(found) && found.length) names = found;
      } catch { /* keep the fallback */ }
      scopes.push({ workspaceId, assignedTechId: { in: ids }, status: { in: names } });
    }
    return scopes;
  }

  // ------------------------------------------------------------ agent API

  async _tech(email, workspaceId) {
    const { resolveAgentTechnician } = await import('./agentCompetencyService.js');
    const { technician } = await resolveAgentTechnician(email, workspaceId);
    return technician;
  }

  async myStatus(email, workspaceId) {
    const tech = await this._tech(email, workspaceId);
    const ws = await this.workspaceSettings(tech.workspaceId);
    const { events, options } = await this._prefsFor(tech.workspaceId, tech.id, ws);
    const conv = await prisma.teamsConversation.findUnique({ where: { email: lc(tech.email) } }).catch(() => null);
    const mutes = await prisma.ticketNotificationMute.findMany({ where: { technicianId: tech.id, until: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 50 });
    const tickets = mutes.length ? await prisma.ticket.findMany({ where: { id: { in: mutes.map((m) => m.ticketId) } }, select: { id: true, subject: true, freshserviceTicketId: true, nativeNumber: true, origin: true } }) : [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const recent = await prisma.teamsDelivery.findMany({ where: { email: lc(tech.email) }, orderBy: { id: 'desc' }, take: 8, select: { eventKey: true, status: true, reason: true, summary: true, createdAt: true } });
    return {
      configured: bot.isTeamsConfigured(),
      enabled: ws.teamsEnabled,
      connection: { connected: Boolean(conv?.conversationId) && !conv?.disconnectedAt, disconnected: Boolean(conv?.disconnectedAt), installedAt: conv?.installedAt || null, lastError: conv?.lastError || null },
      events: EVENTS.map((e) => ({ key: e.key, label: e.label, group: e.group, mode: events[e.key], workspaceDefault: effectivePrefs(ws.defaults, null).events[e.key] })),
      options,
      mutes: mutes.map((m) => ({ ticketId: m.ticketId, until: m.until, forever: m.until >= MUTE_FOREVER, ref: byId.get(m.ticketId) ? ticketDisplayRef(byId.get(m.ticketId)) : `#${m.ticketId}`, subject: byId.get(m.ticketId)?.subject || null })),
      recent,
    };
  }

  async saveMyPrefs(email, workspaceId, input = {}) {
    const tech = await this._tech(email, workspaceId);
    const clean = cleanPrefs(input);
    await prisma.notificationPreference.upsert({
      where: { workspaceId_technicianId: { workspaceId: tech.workspaceId, technicianId: tech.id } },
      update: { events: clean.events, options: clean.options },
      create: { workspaceId: tech.workspaceId, technicianId: tech.id, events: clean.events, options: clean.options },
    });
    return this.myStatus(email, tech.workspaceId);
  }

  async connectMe(email, workspaceId) {
    const tech = await this._tech(email, workspaceId);
    await this.ensureConversation(tech.email, { reconnect: true });
    return this.myStatus(email, tech.workspaceId);
  }

  async sendTest(email, workspaceId) {
    const tech = await this._tech(email, workspaceId);
    const card = textCard('Test message from Ticket Pulse', [
      'This is what your ticket notifications look like. Choose what you are told about in Mail & alerts.',
    ], [{ type: 'Action.OpenUrl', title: 'Open Mail & alerts', url: `${baseUrl()}/mail-alerts` }]);
    await this._send(tech.email, card, { summary: 'Test message from Ticket Pulse', workspaceId: tech.workspaceId, technicianId: tech.id, eventKey: 'test' });
    return this.myStatus(email, tech.workspaceId);
  }

  async unmute(email, workspaceId, ticketId) {
    const tech = await this._tech(email, workspaceId);
    await prisma.ticketNotificationMute.deleteMany({ where: { technicianId: tech.id, ticketId: Number(ticketId) } });
    return this.myStatus(email, tech.workspaceId);
  }

  // ------------------------------------------------------------ admin API

  async adminStatus(workspaceId) {
    const probe = await bot.probe().catch((err) => ({ configured: bot.isTeamsConfigured(), error: err.message }));
    const settings = await this.workspaceSettings(workspaceId);
    const techs = await prisma.technician.findMany({ where: { workspaceId: Number(workspaceId), isActive: true, email: { not: null } }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } });
    const convs = await prisma.teamsConversation.findMany({ where: { email: { in: techs.map((t) => lc(t.email)) } } });
    const byEmail = new Map(convs.map((c) => [c.email, c]));
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const counts = await prisma.teamsDelivery.groupBy({ by: ['status'], where: { workspaceId: Number(workspaceId), createdAt: { gte: since } }, _count: { _all: true } }).catch(() => []);
    const lastFailure = await prisma.teamsDelivery.findFirst({ where: { workspaceId: Number(workspaceId), status: 'failed' }, orderBy: { id: 'desc' }, select: { email: true, reason: true, createdAt: true } });
    return {
      bot: { ...probe, appId: bot.teamsConfig().appId },
      settings,
      events: EVENTS,
      agents: techs.map((t) => {
        const c = byEmail.get(lc(t.email));
        return {
          id: t.id, name: t.name, email: t.email,
          connected: Boolean(c?.conversationId) && !c?.disconnectedAt,
          disconnected: Boolean(c?.disconnectedAt),
          disconnectedAt: c?.disconnectedAt || null,
          disconnectedBy: c?.disconnectedBy || null,
          lastError: c?.lastError || null,
        };
      }),
      last24h: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      lastFailure,
    };
  }

  /** Install the app + open the chat for every active agent (or the ids given). */
  async installForAgents(workspaceId, technicianIds = null) {
    const techs = await prisma.technician.findMany({
      where: { workspaceId: Number(workspaceId), isActive: true, email: { not: null }, ...(Array.isArray(technicianIds) && technicianIds.length ? { id: { in: technicianIds.map(Number) } } : {}) },
      select: { id: true, email: true },
    });
    // "Connect all agents" leaves people an admin disconnected alone; naming
    // someone (the row's Connect) is the explicit reconnect.
    const explicit = Array.isArray(technicianIds) && technicianIds.length > 0;
    const out = { connected: 0, failed: [], skippedDisconnected: 0 };
    for (const t of techs) {
      try {
        await this.ensureConversation(t.email, { reconnect: explicit });
        out.connected++;
      } catch (err) {
        if (err instanceof TeamsDisconnectedError) out.skippedDisconnected++;
        else out.failed.push({ email: t.email, error: err.message });
      }
    }
    return out;
  }

  /**
   * QA 10-01 #4: disconnect agents from the bot. Removes the Ticket Pulse app
   * from their Teams (best effort - a Graph refusal still disconnects them
   * here) and marks the row so nothing is sent or re-installed until someone
   * connects them again.
   */
  async disconnectAgents(workspaceId, technicianIds, actorEmail = null) {
    const ids = (Array.isArray(technicianIds) ? technicianIds : []).map(Number).filter(Number.isInteger);
    if (!ids.length) return { disconnected: 0, appRemoved: 0, failed: [] };
    const techs = await prisma.technician.findMany({
      where: { workspaceId: Number(workspaceId), id: { in: ids }, email: { not: null } },
      select: { id: true, email: true },
    });
    const out = { disconnected: 0, appRemoved: 0, failed: [] };
    for (const t of techs) {
      const key = lc(t.email);
      const row = await prisma.teamsConversation.findUnique({ where: { email: key } }).catch(() => null);
      let aad = row?.aadObjectId || null;
      try {
        if (!aad && bot.isTeamsConfigured()) aad = (await bot.findUser(key).catch(() => null))?.id || null;
        if (aad && bot.isTeamsConfigured()) {
          const r = await bot.uninstallForUser(aad);
          if (r === 'removed') out.appRemoved++;
        }
      } catch (err) {
        out.failed.push({ email: key, error: `App not removed from Teams: ${bot.describeError(err)}` });
      }
      await prisma.teamsConversation.upsert({
        where: { email: key },
        update: { conversationId: null, disconnectedAt: new Date(), disconnectedBy: actorEmail ? lc(actorEmail) : null, lastError: null },
        create: { email: key, aadObjectId: aad, disconnectedAt: new Date(), disconnectedBy: actorEmail ? lc(actorEmail) : null },
      });
      out.disconnected++;
    }
    logger.info(`Teams: ${out.disconnected} agent(s) disconnected in workspace ${workspaceId} by ${actorEmail || 'unknown'} (app removed for ${out.appRemoved})`);
    return out;
  }
}

/** Only known keys and values survive. */
export function cleanPrefs(input = {}) {
  const events = {};
  for (const [k, v] of Object.entries(input?.events || {})) if (EVENT_KEYS.has(k) && MODES.has(v)) events[k] = v;
  const o = input?.options || {};
  const options = {};
  if (typeof o.respectAway === 'boolean') options.respectAway = o.respectAway;
  if (typeof o.urgentBypassesQuiet === 'boolean') options.urgentBypassesQuiet = o.urgentBypassesQuiet;
  if (typeof o.dailyDigest === 'boolean') options.dailyDigest = o.dailyDigest;
  if (o.groupMinPriority !== undefined) options.groupMinPriority = Math.min(4, Math.max(1, Number(o.groupMinPriority) || 3));
  if (typeof o.digestTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.digestTime)) options.digestTime = o.digestTime;
  return { events, options };
}

/**
 * The closed state for an approval card addressed to `email`, or null while it
 * still waits for that person. Exported for tests.
 */
export function approvalClosedStage(ap, email) {
  const when = ap.decidedAt ? new Date(ap.decidedAt).toLocaleString('en-US', { timeZone: 'America/Vancouver', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const where = ap.decidedVia === 'link' ? 'from the e-mail link' : 'in Ticket Pulse or Teams';
  const mine = lc(ap.approverEmail) === lc(email);
  if (ap.status === 'pending' || ap.status === 'info_requested') return null;
  if (ap.status === 'approved' || ap.status === 'rejected') {
    const verb = ap.status === 'approved' ? 'Approved' : 'Not approved';
    return {
      done: ap.status,
      headline: mine ? (ap.status === 'approved' ? 'You approved this' : 'You did not approve this') : verb,
      detail: [`Recorded ${where}${when ? ` on ${when}` : ''}`, ap.conditionNote ? `Condition: ${ap.conditionNote}` : null].filter(Boolean).join('. '),
    };
  }
  if (ap.status === 'escalated' || ap.status === 'forwarded') {
    const log = Array.isArray(ap.escalationLog) ? ap.escalationLog : [];
    const last = log[log.length - 1] || {};
    const to = Array.isArray(last.toEmails) && last.toEmails.length ? last.toEmails.join(', ') : 'the next approver';
    return { done: 'closed', word: 'Handed on', headline: 'Handed on', detail: `${ap.status === 'forwarded' ? 'Forwarded' : 'Escalated'} to ${to}${last.byName ? ` by ${last.byName}` : ''}. Nothing is needed from you.` };
  }
  return { done: 'closed', word: 'Closed', headline: 'No longer needed', detail: ap.decisionNote || 'The request was cancelled.' };
}

const teamsNotificationService = new TeamsNotificationService();
export default teamsNotificationService;
export { TeamsNotificationService, eventText };
