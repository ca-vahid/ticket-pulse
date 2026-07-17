import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { resolveAgentTechnician } from './agentCompetencyService.js';

const TRIGGERS = ['created', 'priority_raised', 'recategorized'];
const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

// Storm protection = trailing-edge debounce. A subscription's matched events
// buffer until the stream goes quiet (QUIET_MS with no new match) or a hard
// cap (MAX_WAIT_MS) elapses, then flush as ONE coalesced alert. A lone ticket
// alerts ~QUIET_MS after it arrives; a burst of 10 collapses to one message.
const TICK_MS = 10_000;
const QUIET_MS = 20_000;
const MAX_WAIT_MS = 90_000;
const MAX_LISTED = 12; // tickets named in one alert before "…and N more"

// categoryId/tagId are scalar refs (no Prisma relation), so names are resolved
// via lookup maps — { cat: Map<id,name>, tag: Map<id,name> }.
async function resolveNames(subs) {
  const catIds = [...new Set(subs.map((s) => s.categoryId).filter((v) => v !== null && v !== undefined))];
  const tagIds = [...new Set(subs.map((s) => s.tagId).filter((v) => v !== null && v !== undefined))];
  const [cats, tags] = await Promise.all([
    catIds.length ? prisma.competencyCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } }) : [],
    tagIds.length ? prisma.ticketTag.findMany({ where: { id: { in: tagIds } }, select: { id: true, name: true } }) : [],
  ]);
  return { cat: new Map(cats.map((c) => [c.id, c.name])), tag: new Map(tags.map((t) => [t.id, t.name])) };
}

function subLabel(sub, names) {
  if (sub.label) return sub.label;
  const parts = [];
  const catName = sub.categoryId !== null && sub.categoryId !== undefined ? names?.cat?.get(sub.categoryId) : null;
  const tagName = sub.tagId !== null && sub.tagId !== undefined ? names?.tag?.get(sub.tagId) : null;
  if (catName) parts.push(catName);
  if (tagName) parts.push(`#${tagName}`);
  if (sub.priorityMin) parts.push(`${PRIORITY_LABELS[sub.priorityMin] || `P${sub.priorityMin}`}+`);
  return parts.join(' · ') || 'All tickets';
}

function shapeSub(sub, names) {
  return {
    id: sub.id,
    label: sub.label,
    computedLabel: subLabel(sub, names),
    categoryId: sub.categoryId,
    categoryName: sub.categoryId !== null && sub.categoryId !== undefined ? (names?.cat?.get(sub.categoryId) || null) : null,
    tagId: sub.tagId,
    tagName: sub.tagId !== null && sub.tagId !== undefined ? (names?.tag?.get(sub.tagId) || null) : null,
    priorityMin: sub.priorityMin,
    onCreated: sub.onCreated,
    onPriorityRaised: sub.onPriorityRaised,
    onRecategorized: sub.onRecategorized,
    channelEmail: sub.channelEmail,
    channelSms: sub.channelSms,
    channelWhatsapp: sub.channelWhatsapp,
    channelPhone: sub.channelPhone,
    isActive: sub.isActive,
    updatedAt: sub.updatedAt,
  };
}

class AgentAlertService {
  constructor() {
    this._timer = null;
    this._flushing = false;
  }

  // ---- CRUD (agent portal — identity resolved from SSO email) ----------

  async _tech(email, workspaceId) {
    const { technician } = await resolveAgentTechnician(email, workspaceId);
    return technician;
  }

  /** Category (internal taxonomy) + tag options for the subscription picker. */
  async options(email, workspaceId) {
    const tech = await this._tech(email, workspaceId);
    const [cats, tags] = await Promise.all([
      prisma.competencyCategory.findMany({ where: { workspaceId: tech.workspaceId, isActive: true }, select: { id: true, name: true, parentId: true }, orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.ticketTag.findMany({ where: { workspaceId: tech.workspaceId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    const nameById = new Map(cats.map((c) => [c.id, c.name]));
    const categories = cats.map((c) => ({
      id: c.id, name: c.name, parentId: c.parentId,
      path: c.parentId ? `${nameById.get(c.parentId) || '?'} › ${c.name}` : c.name,
    }));
    return { categories, tags };
  }

  async list(email, workspaceId) {
    const tech = await this._tech(email, workspaceId);
    const [subs, pref] = await Promise.all([
      prisma.agentAlertSubscription.findMany({ where: { technicianId: tech.id, workspaceId: tech.workspaceId }, orderBy: { id: 'asc' } }),
      prisma.technicianNotificationPreference.findUnique({ where: { technicianId: tech.id } }),
    ]);
    const names = await resolveNames(subs);
    return {
      subscriptions: subs.map((sub) => shapeSub(sub, names)),
      quietHours: {
        enabled: pref?.quietHoursEnabled || false,
        start: pref?.quietHoursStart || null,
        end: pref?.quietHoursEnd || null,
        allowUrgent: pref?.quietHoursAllowUrgent ?? true,
      },
      // Whether the agent can actually use each channel right now.
      channelReadiness: {
        email: !!tech.email,
        phoneVerified: !!pref?.phoneVerifiedAt && !!this._preferredPhone(pref),
      },
    };
  }

  _normalize(input, workspaceId, technicianId) {
    const priorityMin = input.priorityMin !== null && input.priorityMin !== undefined && input.priorityMin !== ''
      ? Math.min(4, Math.max(1, Number(input.priorityMin))) : null;
    const data = {
      workspaceId, technicianId,
      label: input.label ? String(input.label).slice(0, 120) : null,
      categoryId: input.categoryId !== null && input.categoryId !== undefined && input.categoryId !== '' ? Number(input.categoryId) : null,
      tagId: input.tagId !== null && input.tagId !== undefined && input.tagId !== '' ? Number(input.tagId) : null,
      priorityMin,
      onCreated: input.onCreated !== false,
      onPriorityRaised: input.onPriorityRaised === true,
      onRecategorized: input.onRecategorized === true,
      channelEmail: input.channelEmail !== false,
      channelSms: input.channelSms === true,
      channelWhatsapp: input.channelWhatsapp === true,
      channelPhone: input.channelPhone === true,
      isActive: input.isActive !== false,
    };
    if (!data.onCreated && !data.onPriorityRaised && !data.onRecategorized) {
      throw new ValidationError('Pick at least one trigger (new ticket, priority raised, or re-categorized)');
    }
    if (!data.channelEmail && !data.channelSms && !data.channelWhatsapp && !data.channelPhone) {
      throw new ValidationError('Pick at least one delivery channel');
    }
    if (data.categoryId === null && data.tagId === null && data.priorityMin === null) {
      throw new ValidationError('Choose at least a category, a tag, or a minimum priority to match');
    }
    return data;
  }

  async create(email, workspaceId, input) {
    const tech = await this._tech(email, workspaceId);
    const data = this._normalize(input, tech.workspaceId, tech.id);
    const sub = await prisma.agentAlertSubscription.create({ data });
    return shapeSub(sub, await resolveNames([sub]));
  }

  async update(email, workspaceId, id, input) {
    const tech = await this._tech(email, workspaceId);
    const existing = await prisma.agentAlertSubscription.findFirst({ where: { id: Number(id), technicianId: tech.id, workspaceId: tech.workspaceId } });
    if (!existing) throw new NotFoundError('Alert subscription not found');
    const data = this._normalize({ ...existing, ...input }, tech.workspaceId, tech.id);
    delete data.workspaceId; delete data.technicianId;
    const sub = await prisma.agentAlertSubscription.update({ where: { id: existing.id }, data });
    return shapeSub(sub, await resolveNames([sub]));
  }

  async remove(email, workspaceId, id) {
    const tech = await this._tech(email, workspaceId);
    const existing = await prisma.agentAlertSubscription.findFirst({ where: { id: Number(id), technicianId: tech.id, workspaceId: tech.workspaceId } });
    if (!existing) throw new NotFoundError('Alert subscription not found');
    await prisma.agentAlertSubscription.delete({ where: { id: existing.id } });
    return { deleted: true };
  }

  async saveQuietHours(email, workspaceId, { enabled, start, end, allowUrgent }) {
    const tech = await this._tech(email, workspaceId);
    const timeOk = (t) => t === null || t === undefined || /^\d{2}:\d{2}$/.test(t);
    if (!timeOk(start) || !timeOk(end)) throw new ValidationError('Quiet-hours times must be HH:MM');
    await prisma.technicianNotificationPreference.upsert({
      where: { technicianId: tech.id },
      update: { quietHoursEnabled: !!enabled, quietHoursStart: start || null, quietHoursEnd: end || null, quietHoursAllowUrgent: allowUrgent !== false },
      create: { workspaceId: tech.workspaceId, technicianId: tech.id, quietHoursEnabled: !!enabled, quietHoursStart: start || null, quietHoursEnd: end || null, quietHoursAllowUrgent: allowUrgent !== false },
    });
    return { saved: true };
  }

  // ---- Matching (called from ticket lifecycle hooks) -------------------

  /** Buffer alert events for every subscription this ticket matches for the
   *  given trigger. Idempotent per (subscription, ticket, trigger). Never
   *  throws — ticket flows must not block on alerts. */
  async evaluate(eventKind, ticketId) {
    try {
      if (!TRIGGERS.includes(eventKind)) return;
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
          id: true, workspaceId: true, priority: true,
          internalCategoryId: true, internalSubcategoryId: true,
          tagLinks: { select: { tagId: true } },
        },
      });
      if (!ticket) return;
      const triggerCol = eventKind === 'created' ? 'onCreated' : (eventKind === 'priority_raised' ? 'onPriorityRaised' : 'onRecategorized');
      const catIds = [ticket.internalCategoryId, ticket.internalSubcategoryId].filter((v) => v !== null && v !== undefined);
      const tagIds = new Set(ticket.tagLinks.map((l) => l.tagId));
      const priority = Number(ticket.priority) || null;

      const subs = await prisma.agentAlertSubscription.findMany({
        where: { workspaceId: ticket.workspaceId, isActive: true, [triggerCol]: true },
        select: { id: true, technicianId: true, categoryId: true, tagId: true, priorityMin: true },
      });
      const matched = subs.filter((s) => (
        (s.categoryId === null || catIds.includes(s.categoryId))
        && (s.tagId === null || tagIds.has(s.tagId))
        && (s.priorityMin === null || (priority !== null && priority !== undefined && priority >= s.priorityMin))
      ));
      if (!matched.length) return;
      await prisma.agentAlertEvent.createMany({
        data: matched.map((s) => ({ workspaceId: ticket.workspaceId, subscriptionId: s.id, technicianId: s.technicianId, ticketId: ticket.id, trigger: eventKind, priority })),
        skipDuplicates: true,
      });
    } catch (err) {
      logger.warn(`agentAlert evaluate(${eventKind}, ${ticketId}) failed (non-fatal): ${err.message}`);
    }
  }

  // ---- Flush worker ----------------------------------------------------

  start() {
    if (this._timer || process.env.AGENT_ALERTS_ENABLED === 'false') return;
    this._timer = setInterval(() => {
      this.flushDue().catch((err) => logger.warn(`Agent-alert flush tick failed (non-fatal): ${err.message}`));
    }, TICK_MS);
    this._timer.unref?.();
    logger.info('Agent-alert flush worker started (tick 10s)');
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async flushDue() {
    if (this._flushing) return;
    this._flushing = true;
    try {
      const now = Date.now();
      // Subscriptions with any pending (unsent) events.
      const pendingSubs = await prisma.agentAlertEvent.groupBy({
        by: ['subscriptionId'],
        where: { sentAt: null },
        _min: { matchedAt: true },
        _max: { matchedAt: true },
      });
      for (const row of pendingSubs) {
        const oldest = row._min.matchedAt?.getTime() ?? now;
        const newest = row._max.matchedAt?.getTime() ?? now;
        const quietedDown = now - newest >= QUIET_MS;   // stream went quiet
        const hardCap = now - oldest >= MAX_WAIT_MS;     // waited long enough
        if (!quietedDown && !hardCap) continue;
        await this._flushSubscription(row.subscriptionId).catch((err) => logger.warn(`Agent-alert flush for sub ${row.subscriptionId} failed (non-fatal): ${err.message}`));
      }
    } finally {
      this._flushing = false;
    }
  }

  async _flushSubscription(subscriptionId) {
    const sub = await prisma.agentAlertSubscription.findUnique({
      where: { id: subscriptionId },
      include: { technician: { select: { id: true, name: true, email: true, timezone: true } } },
    });
    if (!sub || !sub.isActive) {
      // Drop pending for an inactive/deleted subscription.
      await prisma.agentAlertEvent.updateMany({ where: { subscriptionId, sentAt: null }, data: { sentAt: new Date() } });
      return;
    }
    const pref = await prisma.technicianNotificationPreference.findUnique({ where: { technicianId: sub.technicianId } });

    const events = await prisma.agentAlertEvent.findMany({ where: { subscriptionId, sentAt: null }, orderBy: { matchedAt: 'asc' } });
    if (!events.length) return;

    // Quiet hours: hold the batch unless an urgent event is allowed through.
    const hasUrgent = events.some((e) => Number(e.priority) >= 4);
    if (this._inQuietHours(pref, sub.technician.timezone)) {
      if (!(pref?.quietHoursAllowUrgent && hasUrgent)) return; // keep pending; deliver after quiet hours
    }

    const ticketIds = [...new Set(events.map((e) => e.ticketId))];
    const tickets = await prisma.ticket.findMany({
      where: { id: { in: ticketIds } },
      select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, priority: true, status: true },
    });
    const result = await this._deliver(sub, pref, events, tickets);
    await prisma.agentAlertEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { sentAt: new Date(), deliveryResult: result } });
  }

  // ---- delivery --------------------------------------------------------

  _preferredPhone(pref) {
    return pref?.phoneOverride || pref?.entraMobilePhone || pref?.entraPhone || null;
  }

  _inQuietHours(pref, tz) {
    if (!pref?.quietHoursEnabled || !pref.quietHoursStart || !pref.quietHoursEnd) return false;
    let hhmm;
    try {
      hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'America/Los_Angeles' }).format(new Date());
    } catch { hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
    const [s, e, n] = [pref.quietHoursStart, pref.quietHoursEnd, hhmm];
    // Window may wrap past midnight (e.g. 22:00 → 07:00).
    return s <= e ? (n >= s && n < e) : (n >= s || n < e);
  }

  async _deliver(sub, pref, events, tickets) {
    const scope = subLabel(sub, await resolveNames([sub]));
    const byTrigger = { created: 0, priority_raised: 0, recategorized: 0 };
    for (const ev of events) byTrigger[ev.trigger] = (byTrigger[ev.trigger] || 0) + 1;
    const verbs = [];
    if (byTrigger.created) verbs.push(`${byTrigger.created} new`);
    if (byTrigger.priority_raised) verbs.push(`${byTrigger.priority_raised} escalated`);
    if (byTrigger.recategorized) verbs.push(`${byTrigger.recategorized} re-categorized`);
    const count = tickets.length;
    const headline = `${verbs.join(', ') || count} ticket${count === 1 ? '' : 's'} in ${scope}`;

    const refs = tickets.map((t) => ticketDisplayRef(t));
    const listed = refs.slice(0, MAX_LISTED).join(', ') + (refs.length > MAX_LISTED ? ` …and ${refs.length - MAX_LISTED} more` : '');
    const publicBase = process.env.PUBLIC_APP_URL || process.env.FRONTEND_PUBLIC_URL || process.env.APP_URL || process.env.CORS_ORIGIN || 'http://localhost:5173';

    const out = { channels: {} };

    // Email
    if (sub.channelEmail && sub.technician.email) {
      const esc = (s) => String(s || '').replace(/</g, '&lt;');
      const rows = tickets.map((t) => `<li><a href="${publicBase}/tickets/${t.id}">${ticketDisplayRef(t)}</a> — ${esc(t.subject) || '(no subject)'} <span style="color:#64748b">(${PRIORITY_LABELS[t.priority] || 'P?'}, ${esc(t.status)})</span></li>`).join('');
      const html = [
        `<p>Your alert <b>${esc(scope)}</b> matched ${headline}.</p>`,
        `<ul>${rows}</ul>`,
        '<p style="color:#64748b;font-size:12px">You’re receiving this because you subscribed to this alert in Ticket Pulse. Manage your alerts in the agent portal.</p>',
      ].join('');
      const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
      out.channels.email = await sendTransactionalEmail({ workspaceId: sub.workspaceId, to: sub.technician.email, subject: `Ticket Pulse alert: ${headline}`, html, label: 'agent alert' });
    }

    // SMS / WhatsApp / Phone — need a verified phone.
    const phone = this._preferredPhone(pref);
    const phoneReady = !!pref?.phoneVerifiedAt && !!phone;
    const smsBody = `Ticket Pulse: ${headline}. ${listed}. Open the portal to review.`;
    if (sub.channelSms) {
      out.channels.sms = phoneReady ? await this._twilio('sms', { to: phone, body: smsBody }) : { sent: false, reason: 'phone_not_verified' };
    }
    if (sub.channelWhatsapp) {
      out.channels.whatsapp = phoneReady ? await this._twilio('whatsapp', { to: phone, body: smsBody }) : { sent: false, reason: 'phone_not_verified' };
    }
    if (sub.channelPhone) {
      out.channels.phone = phoneReady ? await this._twilio('phone', { to: phone, message: `New Ticket Pulse alert. ${headline}. Please open the portal to review.` }) : { sent: false, reason: 'phone_not_verified' };
    }

    logger.info(`Agent alert delivered to ${sub.technician.name} — ${headline} (${count} ticket(s))`);
    return out;
  }

  async _twilio(kind, args) {
    try {
      const twilio = await import('./twilioNotificationService.js');
      if (kind === 'sms') { await twilio.sendSms(args); return { sent: true, via: 'sms' }; }
      if (kind === 'whatsapp') { await twilio.sendWhatsApp(args); return { sent: true, via: 'whatsapp' }; }
      if (kind === 'phone') { await twilio.placeVoiceCall(args); return { sent: true, via: 'phone' }; }
      return { sent: false, reason: 'unknown_channel' };
    } catch (err) {
      logger.warn(`Agent alert ${kind} send failed (non-fatal): ${err.message}`);
      return { sent: false, error: err.message };
    }
  }
}

export default new AgentAlertService();
export { AgentAlertService, TRIGGERS };
