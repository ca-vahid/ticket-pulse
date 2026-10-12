/**
 * Device notifications (web push, 12 Oct 2026).
 *
 * A person turns notifications on for one browser or installed app; from then
 * on that device is told about the same ticket events as their Teams
 * messages, by the same rules: their own choices per event (Off and Digest
 * are not sent), never about their own action, muted tickets, away / off
 * shift and quiet hours (urgent still comes through).
 *
 * There is no workspace switch: a device only receives anything after its
 * owner subscribed it, and the whole feature is off unless the VAPID keys
 * (WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY) are set.
 *
 * Entry points:
 *  - onTicketEvent(eventContext)  ← ticketLifecycleNotificationService
 *  - notifyApproval({...})        ← ticketApprovalService._emailApprover
 *  - status / subscribe / unsubscribe / sendTest ← routes/agent.routes.js
 * Nothing here ever throws into the ticket pipeline.
 */
import webpush from 'web-push';
import prisma from './prisma.js';
import logger from '../utils/logger.js';

const MAX_DEVICES = 8;
const TTL_SECONDS = 6 * 3600; // a push still worth showing if the phone was offline
const lc = (s) => String(s || '').trim().toLowerCase();
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Only push services' own https endpoints are accepted (no arbitrary URLs to call). */
const ALLOWED_HOSTS = [
  /(^|\.)googleapis\.com$/, // Chrome, Edge on Android (FCM)
  /(^|\.)push\.apple\.com$/, // Safari, installed apps on iPhone / iPad
  /(^|\.)mozilla\.com$/, // Firefox
  /(^|\.)notify\.windows\.com$/, // Edge on Windows
];
export function isAllowedEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint));
    return u.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

class WebPushService {
  constructor() {
    this.vapidSet = false;
    this.any = false;
    this.anyAt = 0;
  }

  isConfigured() {
    return Boolean(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY);
  }

  _ensureVapid() {
    if (this.vapidSet || !this.isConfigured()) return this.vapidSet;
    webpush.setVapidDetails(
      process.env.WEB_PUSH_SUBJECT || 'mailto:it@bgcengineering.ca',
      process.env.WEB_PUSH_PUBLIC_KEY,
      process.env.WEB_PUSH_PRIVATE_KEY,
    );
    this.vapidSet = true;
    return true;
  }

  // ------------------------------------------------------------ my devices

  async status(email) {
    const devices = this.isConfigured()
      ? await prisma.pushSubscription.findMany({ where: { email: lc(email) }, orderBy: { id: 'desc' }, select: { endpoint: true, userAgent: true, createdAt: true, lastSentAt: true } })
      : [];
    return {
      configured: this.isConfigured(),
      publicKey: this.isConfigured() ? process.env.WEB_PUSH_PUBLIC_KEY : null,
      devices: devices.map((d) => ({ endpoint: d.endpoint, label: deviceLabel(d.userAgent), createdAt: d.createdAt, lastSentAt: d.lastSentAt })),
    };
  }

  async subscribe(email, subscription = {}, userAgent = null) {
    if (!this.isConfigured()) { const e = new Error('Device notifications are not set up on this server yet.'); e.statusCode = 503; throw e; }
    const endpoint = String(subscription.endpoint || '');
    const p256dh = String(subscription.keys?.p256dh || '');
    const auth = String(subscription.keys?.auth || '');
    if (!isAllowedEndpoint(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 255 || auth.length > 255) {
      const e = new Error('That is not a notification subscription this server can use.'); e.statusCode = 400; throw e;
    }
    const who = lc(email);
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { email: who, endpoint, p256dh, auth, userAgent: clip(userAgent, 255) || null },
      update: { email: who, p256dh, auth, userAgent: clip(userAgent, 255) || null, failCount: 0 },
    });
    this.anyAt = 0;
    // Keep the newest few; a person does not have dozens of live devices.
    const extra = await prisma.pushSubscription.findMany({ where: { email: who }, orderBy: { id: 'desc' }, skip: MAX_DEVICES, select: { id: true } });
    if (extra.length) await prisma.pushSubscription.deleteMany({ where: { id: { in: extra.map((r) => r.id) } } });
    return this.status(who);
  }

  async unsubscribe(email, endpoint) {
    await prisma.pushSubscription.deleteMany({ where: { email: lc(email), endpoint: String(endpoint || '') } });
    return this.status(email);
  }

  async sendTest(email) {
    const sent = await this.sendToEmail(email, {
      title: 'Ticket Pulse',
      body: 'Notifications are on for this device.',
      url: '/notifications',
      tag: 'test',
    });
    return { ...(await this.status(email)), test: sent };
  }

  // ------------------------------------------------------------ sending

  async hasDevices(email) {
    if (!this.isConfigured() || !email) return false;
    const n = await prisma.pushSubscription.count({ where: { email: lc(email) } }).catch(() => 0);
    return n > 0;
  }

  /** Is anyone subscribed at all? Remembered for a minute; ticket events are frequent. */
  async _anyDevices() {
    if (this.anyAt && this.anyAt > Date.now() - 60_000) return this.any;
    this.any = (await prisma.pushSubscription.count().catch(() => 0)) > 0;
    this.anyAt = Date.now();
    return this.any;
  }

  /** Send one payload to every device of a person. Dead subscriptions are removed. */
  async sendToEmail(email, payload, { urgent = false } = {}) {
    if (!this._ensureVapid()) return { sent: 0, failed: 0, removed: 0 };
    const subs = await prisma.pushSubscription.findMany({ where: { email: lc(email) } });
    const out = { sent: 0, failed: 0, removed: 0 };
    const body = JSON.stringify({
      title: clip(payload.title, 120),
      body: clip(payload.body, 240),
      url: String(payload.url || '/'),
      tag: payload.tag || null,
    });
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: TTL_SECONDS, urgency: urgent ? 'high' : 'normal', timeout: 10_000 },
        );
        out.sent += 1;
        await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastSentAt: new Date(), failCount: 0 } }).catch(() => {});
      } catch (err) {
        const code = Number(err?.statusCode) || 0;
        // 404 / 410: the browser dropped this subscription (app removed, permission revoked).
        if (code === 404 || code === 410) {
          out.removed += 1;
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        } else {
          out.failed += 1;
          logger.warn(`Device notification to ${lc(email)} failed (${code || err.message})`);
          await prisma.pushSubscription.update({ where: { id: s.id }, data: { failCount: { increment: 1 } } }).catch(() => {});
        }
      }
    }));
    return out;
  }

  // ------------------------------------------------------------ ticket events

  onTicketEvent(ctx) {
    if (!this.isConfigured()) return;
    this._onTicketEvent(ctx).catch((err) => logger.warn(`Device notification skipped for ${ctx?.event?.type} on ticket ${ctx?.ticket?.id}: ${err.message}`));
  }

  async _onTicketEvent(ctx) {
    const { default: teams, EVENT_MAP, eventActor, eventText } = await import('./teamsNotificationService.js');
    const { EVENT_META } = await import('./teamsCards.js');
    const map = EVENT_MAP[ctx?.event?.type];
    const workspaceId = Number(ctx?.workspace?.id);
    if (!map || !workspaceId || !ctx.ticket?.id) return;
    const x = ctx.event.extra || {};
    if (ctx.event.type === 'ticket.note_added' && x.systemNote === true) return;
    if (ctx.event.type === 'ticket.created' && (ctx.assignedAgent || ctx.ticket.isNoise)) return;
    // Nobody has a device yet: skip all the lookups below.
    if (!(await this._anyDevices())) return;

    const ws = await teams.workspaceSettings(workspaceId);
    const actor = eventActor(ctx);
    for (const [eventKey, who] of map) {
      const people = await teams._recipients(who, ctx, workspaceId);
      for (const tech of people) {
        if (!(await this.hasDevices(tech.email))) continue;
        if (!(await this._allowed(teams, tech, eventKey, ctx, ws, actor))) continue;
        const urgent = eventKey === 'sla_breach' || Number(ctx.ticket.priority || 0) >= 4;
        const heading = EVENT_META[eventKey]?.heading || 'Update';
        const line = eventKey === 'requester_replied'
          ? (x.bodyText || (ctx.requester?.name ? `${ctx.requester.name} replied.` : ''))
          : eventText(eventKey, ctx);
        await this.sendToEmail(tech.email, {
          title: `${heading}: ${ctx.ticket.displayRef || ''}`.trim(),
          body: [ctx.ticket.subject, line].filter(Boolean).join(' — '),
          url: `/tickets/${ctx.ticket.id}`,
          tag: `ticket-${ctx.ticket.id}`,
        }, { urgent });
      }
    }
  }

  /** The person's own rules — the same ones their Teams messages follow. */
  async _allowed(teams, tech, eventKey, ctx, ws, actor) {
    const prefs = await teams._prefsFor(ctx.workspace.id, tech.id, ws);
    const mode = prefs.events[eventKey];
    if (mode === 'off' || mode === 'digest') return false;
    if ((actor.email && actor.email === lc(tech.email)) || (actor.technicianId && actor.technicianId === tech.id)) return false;
    if (eventKey === 'group_unassigned' && Number(ctx.ticket.priority || 0) < Number(prefs.options.groupMinPriority || 3)) return false;
    const mute = await prisma.ticketNotificationMute.findUnique({ where: { technicianId_ticketId: { technicianId: tech.id, ticketId: ctx.ticket.id } } }).catch(() => null);
    if (mute && mute.until > new Date()) return false;
    const urgent = eventKey === 'sla_breach' || Number(ctx.ticket.priority || 0) >= 4;
    if (prefs.options.respectAway && !urgent && (await teams._awayReason(tech, ctx.workspace.id))) return false;
    if ((await teams._inQuietHours(tech)) && !(urgent && prefs.options.urgentBypassesQuiet)) return false;
    return true;
  }

  // ------------------------------------------------------------ approvals

  notifyApproval(input) {
    if (!this.isConfigured()) return;
    this._notifyApproval(input).catch((err) => logger.warn(`Device notification for approval ${input?.approval?.id} skipped: ${err.message}`));
  }

  async _notifyApproval({ approval, ticket, categoryName, requestedByName, note }) {
    const email = lc(approval?.approverEmail);
    if (!email || !(await this.hasDevices(email))) return;
    const { default: teams } = await import('./teamsNotificationService.js');
    const tech = await prisma.technician.findFirst({ where: { workspaceId: ticket.workspaceId, email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
    if (tech) {
      const prefs = await teams._prefsFor(ticket.workspaceId, tech.id);
      if (prefs.events.approval_waiting === 'off') return;
    }
    await this.sendToEmail(email, {
      title: `Approval waiting: ${categoryName || ticket.subject || ''}`.trim(),
      body: [requestedByName ? `${requestedByName} asks` : null, note || ticket.subject].filter(Boolean).join(' — '),
      url: '/approvals',
      tag: `approval-${approval.id}`,
    });
  }
}

/** "Chrome on Android" from a user-agent string; good enough to tell devices apart. */
export function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s) return 'A device';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : null;
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  return [browser, os].filter(Boolean).join(' on ') || 'A device';
}

const webPushService = new WebPushService();
export default webPushService;
export { WebPushService };
