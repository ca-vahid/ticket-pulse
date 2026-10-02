/**
 * Autofill from the Teams bot (QA 10-01 #3).
 *
 * A connected agent sends the Ticket Pulse bot a screenshot and/or a pasted
 * chat in their personal chat. The bot answers with ONE card that fills in by
 * itself: the same Autofill extraction the web "New ticket → Autofill" runs
 * (ticketIntakeExtractService, called directly), then Create ticket /
 * Open in Ticket Pulse / Discard. Everything happens in Teams in one round
 * trip; the web link is the escape hatch for anything the card cannot set.
 *
 * The draft (extraction + pictures) lives in teams_autofill_drafts for
 * 30 minutes under a random token (stored hashed). The token rides in the
 * card's action data and in the web link /tickets/new?autofill=<token>, which
 * the New Ticket page reads back with an authenticated GET for the same
 * person only.
 *
 * Entry points (wired from teamsNotificationService):
 *  - handleMessage(activity, email)       ← _onMessage (not a bot command)
 *  - handleAction(verb, data, email, act) ← _onAction ('autofill.*' verbs)
 *  - getPrefill(token, email)             ← GET /api/teams-autofill/:token
 * Nothing here throws into the bot endpoint.
 */
import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import bot from '../integrations/teamsBotClient.js';
import { autofillCard, textCard, textToCardMarkdown } from './teamsCards.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
import { ticketDisplayRef, TICKET_SOURCE } from '../utils/ticketOrigin.js';
import { AppError, NotFoundError } from '../utils/errors.js';

export const DRAFT_TTL_MS = 30 * 60 * 1000;
export const TEAMS_INTAKE_LIMITS = Object.freeze({
  MAX_IMAGES: 6, // same as the web Autofill
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  MAX_TOTAL_BYTES: 12 * 1024 * 1024, // the draft row holds them for 30 min
  MAX_TEXT_CHARS: 20000,
  MIN_TEXT_CHARS: 60, // "more than a short line"
  COMMAND_MAX_CHARS: 40,
});
const RATE = Object.freeze({ perMinute: 6, perHour: 40 });
const PRIORITY_WORD = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const lc = (s) => String(s || '').trim().toLowerCase();
const baseUrl = () => resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
export const hashToken = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');
const validEmail = (s) => (EMAIL_RE.test(lc(s)) ? lc(s) : null);

// ------------------------------------------------------------------ pure helpers

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Teams HTML / text → plain text with line breaks kept. */
export function htmlToPlain(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, ''); // @mentions of the bot
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The words of an inbound message (activity.text, else the HTML attachment's text). */
export function extractMessageText(activity) {
  const fromText = htmlToPlain(activity?.text || '');
  if (fromText) return fromText;
  const html = (activity?.attachments || []).find((a) => a?.contentType === 'text/html' && typeof a.content === 'string');
  return html ? htmlToPlain(html.content) : '';
}

// "Password: x", "pwd = x", "API key: x" — any value after ':' / '='.
const SECRET_ASSIGNED = /\b(password|passwd|pwd|passcode|pass\s?phrase|pin|otp|mfa code|recovery code|api[ _-]?key|client secret|secret|access token|token)\s*[:=]\s*\S+/i;
// "(initial|temporary) password is Summer2026!" — only when the value looks like one.
const SECRET_IS = /\b(password|passwd|pwd|passcode|pass\s?phrase|pin)\s+(?:is|was|will be)\s+["'“]?(\S+)/i;
const looksLikeSecret = (v) => {
  const s = String(v || '').replace(/["'”.,!?;]+$/, '');
  return s.length >= 4 && (/\d/.test(s) || /[^A-Za-z-]/.test(s));
};

/**
 * Never send a password to the model or keep it in a draft: drop every line
 * that hands one over ("Initial password: Summer2026!", "temp password is
 * Wint3r!", "pwd = …"). A line that only describes a password problem
 * ("my new password is not working") stays.
 */
export function stripSecrets(text) {
  let removed = 0;
  const out = String(text || '').split('\n').map((line) => {
    const is = line.match(SECRET_IS);
    if (SECRET_ASSIGNED.test(line) || (is && looksLikeSecret(is[2]))) { removed++; return '[password removed]'; }
    return line;
  }).join('\n');
  return { text: out, removed };
}

/** Short "my tickets" / "settings" / "help" style messages stay bot commands. */
export function isBotCommand(text) {
  const t = lc(text);
  if (!t || t.length > TEAMS_INTAKE_LIMITS.COMMAND_MAX_CHARS) return false;
  return t.includes('my tickets') || t.includes('setting') || /^(help|hi|hello|hey|start|menu|\?)[.!?]*$/.test(t);
}

const IMAGE_FILE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * Picture references in an inbound activity. Teams sends a pasted picture as
 * an `image/*` attachment (contentUrl on the Bot Connector) AND as an <img>
 * in the `text/html` attachment (sometimes only the latter, sometimes a Graph
 * hosted-contents URL); a file sent through the paperclip arrives as
 * `application/vnd.microsoft.teams.file.download.info` with a pre-signed
 * downloadUrl. Emoji images are skipped; anything else counts as ignored.
 * @returns {{ refs: Array<{url, name, kind}>, ignored: number }}
 */
export function collectImageRefs(activity) {
  const refs = [];
  const seen = new Set();
  let ignored = 0;
  const add = (url, name, kind) => {
    const key = String(url || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    refs.push({ url: key, name: name || null, kind });
  };
  for (const a of activity?.attachments || []) {
    const type = lc(a?.contentType);
    if (type.startsWith('image/') && a.contentUrl) add(a.contentUrl, a.name, 'image');
    else if (type === 'application/vnd.microsoft.teams.file.download.info') {
      const ft = lc(a.content?.fileType || String(a.name || '').split('.').pop());
      if (IMAGE_FILE_TYPES.has(ft) && a.content?.downloadUrl) add(a.content.downloadUrl, a.name, 'file');
      else ignored++;
    } else if (type === 'text/html' && typeof a.content === 'string') {
      for (const tag of a.content.match(/<img\b[^>]*>/gi) || []) {
        if (/itemtype="[^"]*emoji/i.test(tag) || /\bclass="[^"]*emoji/i.test(tag)) continue;
        const src = (tag.match(/\bsrc="([^"]+)"/i) || [])[1];
        if (!src || /statics\.teams\.cdn\.office\.net/i.test(src)) continue;
        add(decodeEntities(src), null, 'inline');
      }
    } else if (type && !type.startsWith('application/vnd.microsoft.card') && type !== 'text/plain' && type !== 'text/html') {
      ignored++;
    }
  }
  return { refs, ignored };
}

/** The real type of a downloaded picture (Teams says "image/*"). */
export function sniffImageType(buffer) {
  const b = buffer || Buffer.alloc(0);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** Does this message want Autofill (and not a command / a hello)? */
export function wantsAutofill(activity) {
  // Personal chat only: in a group chat or channel the bot never reads along.
  const kind = activity?.conversation?.conversationType;
  if (kind && kind !== 'personal') return false;
  const text = extractMessageText(activity);
  const { refs } = collectImageRefs(activity);
  if (refs.length) return !isBotCommand(text);
  if (isBotCommand(text)) return false;
  return text.length >= TEAMS_INTAKE_LIMITS.MIN_TEXT_CHARS || (text.includes('\n') && text.length >= 25);
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// ------------------------------------------------------------------ service

class TeamsIntakeService {
  constructor() {
    this.hits = new Map(); // email -> timestamps
    this.seenActivities = new Map(); // activity id -> at (Teams retries a slow request)
  }

  _rateLimited(email) {
    const now = Date.now();
    const stamps = (this.hits.get(email) || []).filter((t) => t > now - 3600_000);
    const lastMinute = stamps.filter((t) => t > now - 60_000).length;
    if (lastMinute >= RATE.perMinute || stamps.length >= RATE.perHour) { this.hits.set(email, stamps); return true; }
    stamps.push(now);
    this.hits.set(email, stamps);
    if (this.hits.size > 2000) for (const [k, v] of this.hits) if (!v.length || v[v.length - 1] < now - 3600_000) this.hits.delete(k);
    return false;
  }

  _duplicate(activityId) {
    if (!activityId) return false;
    const now = Date.now();
    if (this.seenActivities.has(activityId)) return true;
    this.seenActivities.set(activityId, now);
    if (this.seenActivities.size > 500) for (const [k, at] of this.seenActivities) if (at < now - 600_000) this.seenActivities.delete(k);
    return false;
  }

  async _record(data) {
    await prisma.teamsDelivery.create({ data: { ...data, email: lc(data.email), summary: data.summary ? String(data.summary).slice(0, 500) : null } }).catch(() => {});
  }

  /** Every workspace where this person is an active agent, native ticketing first. */
  async _agentWorkspaces(email) {
    const techs = await prisma.technician.findMany({
      where: { isActive: true, email: { equals: lc(email), mode: 'insensitive' } },
      select: { id: true, name: true, email: true, workspaceId: true },
    });
    if (!techs.length) return [];
    const workspaces = await prisma.workspace.findMany({ where: { id: { in: techs.map((t) => t.workspaceId) } }, select: { id: true, name: true, nativeTicketingEnabled: true } });
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    return techs.filter((t) => byId.has(t.workspaceId)).map((t) => ({ tech: t, workspace: byId.get(t.workspaceId) }));
  }

  /** The workspace to read it for: where the agent last had a ticket assigned. */
  async _pickWorkspace(options) {
    if (options.length === 1) return options[0];
    const last = await prisma.ticket.findFirst({
      where: { assignedTechId: { in: options.map((o) => o.tech.id) } },
      orderBy: { id: 'desc' },
      select: { workspaceId: true },
    }).catch(() => null);
    return options.find((o) => o.workspace.id === last?.workspaceId) || [...options].sort((a, b) => a.workspace.id - b.workspace.id)[0];
  }

  /** Download the pictures (bounded). Returns { images, skipped }. */
  async _download(refs, serviceUrl) {
    const images = [];
    let skipped = 0;
    let total = 0;
    for (const ref of refs) {
      if (images.length >= TEAMS_INTAKE_LIMITS.MAX_IMAGES) { skipped++; continue; }
      try {
        const { buffer } = await bot.downloadAttachment(ref.url, { serviceUrl, maxBytes: TEAMS_INTAKE_LIMITS.MAX_IMAGE_BYTES });
        const mimeType = sniffImageType(buffer);
        if (!mimeType || total + buffer.length > TEAMS_INTAKE_LIMITS.MAX_TOTAL_BYTES) { skipped++; continue; }
        total += buffer.length;
        const n = images.length + 1;
        const name = ref.name && /\.(png|jpe?g|gif|webp)$/i.test(ref.name) ? ref.name : `teams-picture-${n}.${EXT[mimeType]}`;
        images.push({ fileName: name, mimeType, buffer });
      } catch (err) {
        skipped++;
        logger.warn(`Teams Autofill: a picture could not be downloaded (${ref.kind}): ${bot.describeError(err)}`);
      }
    }
    return { images, skipped };
  }

  async _showCard(draft, card, incoming = null, summary = 'Autofill') {
    const conv = { serviceUrl: draft?.serviceUrl || incoming?.serviceUrl, conversationId: draft?.conversationId || incoming?.conversation?.id };
    if (draft?.activityId && conv.conversationId) {
      try {
        await bot.updateActivity({ ...conv, activityId: draft.activityId }, bot.cardActivity(card, { summary }));
        return draft.activityId;
      } catch (err) {
        logger.warn(`Teams Autofill card update failed, sending a new one: ${bot.describeError(err)}`);
      }
    }
    if (incoming) {
      const sent = await bot.replyToActivity(incoming, bot.cardActivity(card, { summary }));
      return sent?.id || null;
    }
    if (conv.conversationId) return bot.sendToConversation(conv, bot.cardActivity(card, { summary }));
    return null;
  }

  async _reply(activity, card, summary) {
    await bot.replyToActivity(activity, bot.cardActivity(card, { summary })).catch((err) => logger.warn(`Teams Autofill reply failed: ${bot.describeError(err)}`));
  }

  // -------------------------------------------------------------- message

  /** Background job from _onMessage. Never throws. */
  async handleMessage(activity, email) {
    try {
      await this._handleMessage(activity, email);
    } catch (err) {
      logger.warn(`Teams Autofill for ${email || 'unknown'} failed: ${err.message}`);
      await this._reply(activity, autofillCard({ error: 'Autofill did not work this time. Try again in a minute, or create the ticket in Ticket Pulse.', ticketsUrl: `${baseUrl()}/tickets/new` }, 'error'), 'Autofill failed');
    }
  }

  async _handleMessage(activity, email) {
    if (this._duplicate(activity?.id)) return;
    if (!email) {
      await this._reply(activity, textCard('Ticket Pulse could not tell who you are', ['Autofill needs your Teams account to match a Ticket Pulse agent.']), 'Autofill');
      return;
    }
    const options = await this._agentWorkspaces(email);
    const ticketsUrl = `${baseUrl()}/tickets`;
    if (!options.length) {
      await this._reply(activity, autofillCard({ title: 'Autofill is for Ticket Pulse agents', error: `${email} is not an active agent in any Ticket Pulse workspace, so I cannot make tickets for you.` }, 'error'), 'Autofill');
      await this._record({ email, eventKey: 'autofill', status: 'skipped', reason: 'not_an_agent' });
      return;
    }
    const native = options.filter((o) => o.workspace.nativeTicketingEnabled);
    if (!native.length) {
      const names = options.map((o) => o.workspace.name).join(', ');
      await this._reply(activity, autofillCard({
        title: 'Ticket Pulse cannot create tickets there yet',
        error: `Native ticketing is off in ${names}, so Autofill cannot create the ticket from Teams. An admin can turn it on in Settings; until then, create it in FreshService or open Ticket Pulse.`,
        ticketsUrl,
      }, 'error'), 'Autofill');
      await this._record({ workspaceId: options[0].workspace.id, email, technicianId: options[0].tech.id, eventKey: 'autofill', status: 'skipped', reason: 'native_ticketing_off' });
      return;
    }
    if (this._rateLimited(lc(email))) {
      await this._reply(activity, autofillCard({ title: 'One moment', error: 'You have sent a lot of Autofill messages in a short time. Try again in a minute.' }, 'error'), 'Autofill');
      return;
    }

    const pick = await this._pickWorkspace(native);
    const { text, removed } = stripSecrets(extractMessageText(activity).slice(0, TEAMS_INTAKE_LIMITS.MAX_TEXT_CHARS));
    const { refs, ignored } = collectImageRefs(activity);

    // Answer straight away; the card fills in when the AI is done.
    const first = await bot.replyToActivity(activity, bot.cardActivity(autofillCard({ workspaceName: pick.workspace.name }, 'reading'), { summary: 'Autofill: reading your message' }))
      .catch((err) => { logger.warn(`Teams Autofill reading card failed: ${bot.describeError(err)}`); return null; });

    const { images, skipped } = await this._download(refs, activity.serviceUrl);
    const token = crypto.randomBytes(24).toString('base64url');
    const draft = await prisma.teamsAutofillDraft.create({
      data: {
        tokenHash: hashToken(token),
        email: lc(email),
        workspaceId: pick.workspace.id,
        technicianId: pick.tech.id,
        status: 'reading',
        images: images.map((i) => ({ fileName: i.fileName, mimeType: i.mimeType, base64: i.buffer.toString('base64') })),
        sourceText: text || null,
        notes: { skipped, ignoredFiles: ignored, passwordLinesRemoved: removed },
        serviceUrl: activity.serviceUrl || null,
        conversationId: activity.conversation?.id || null,
        activityId: first?.id || null,
        expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
      },
    });
    // Old drafts (and their pictures) go an hour after they expire.
    prisma.teamsAutofillDraft.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } }).catch(() => {});
    logger.info(`Teams Autofill: ${email} sent ${images.length} picture(s) (${skipped} skipped, ${ignored} other file(s)) and ${text.length} chars; reading for workspace ${pick.workspace.id} (draft ${draft.id})`);

    await this._extractAndShow(draft, token, { text, images, tech: pick.tech, workspace: pick.workspace, incoming: first?.id ? null : activity });
  }

  /** Run the web Autofill extraction for a draft and put the result on its card. */
  async _extractAndShow(draft, token, { text, images, tech, workspace, incoming = null }) {
    const ws = { workspaceName: workspace.name, draftId: draft.id, t: token, openUrl: `${baseUrl()}/tickets/new?autofill=${encodeURIComponent(token)}&ws=${workspace.id}` };
    const fail = async (error, reason, { withLink = true } = {}) => {
      await prisma.teamsAutofillDraft.update({ where: { id: draft.id }, data: { status: 'failed', error: reason } }).catch(() => {});
      await this._showCard(draft, autofillCard({ ...ws, openUrl: withLink ? `${baseUrl()}/tickets/new` : null, error }, 'error'), incoming, 'Autofill');
      await this._record({ workspaceId: workspace.id, email: draft.email, technicianId: tech.id, eventKey: 'autofill', status: 'failed', reason });
    };
    if (!text.trim() && !images.length) {
      await fail('I could not read anything in that message. Paste the screenshot itself (not a link to it) or the text of the chat, and send it again.', 'nothing_readable');
      return;
    }
    let result;
    try {
      const { default: extractor } = await import('./ticketIntakeExtractService.js');
      result = await extractor.extract({
        workspaceId: workspace.id,
        text,
        images: images.map((i) => ({ mimeType: i.mimeType, buffer: i.buffer, fileName: i.fileName })),
        actorEmail: draft.email,
        actorTechnicianId: tech.id,
      });
    } catch (err) {
      logger.warn(`Teams Autofill extraction failed for ${draft.email} (draft ${draft.id}): ${err.message}`);
      if (err?.name === 'ServiceBusyError' || err?.statusCode === 503) {
        await fail('The AI is not available right now. Open Ticket Pulse and fill in the form yourself, or try again later.', 'ai_unavailable');
      } else if (err?.name === 'ValidationError' || err?.statusCode === 400) {
        await fail('I could not read anything useful in that. Send the screenshot or the text of the chat again.', 'nothing_readable');
      } else {
        await fail('Autofill did not work this time. Try again in a minute, or open Ticket Pulse.', 'extract_failed');
      }
      return;
    }
    const data = result.data || {};
    if (!String(data.subject || '').trim() && !String(data.descriptionText || '').trim()) {
      await fail('I could not find a request in that. Send a clearer screenshot or the text of the chat.', 'nothing_readable');
      return;
    }
    const { default: runs } = await import('./ticketIntakeRunService.js');
    const runId = await runs.record({
      workspaceId: workspace.id,
      actor: { email: draft.email, name: tech.name },
      text,
      images,
      notes: data.technicianNotes || '',
      data,
      meta: result.meta || {},
    });
    const ready = await prisma.teamsAutofillDraft.update({ where: { id: draft.id }, data: { status: 'ready', data, intakeRunId: runId, error: null } });
    const card = autofillCard(await this._readyModel(ready, token), 'ready');
    const activityId = await this._showCard(ready, card, incoming, `Autofill: ${data.subject || 'new ticket'}`);
    if (activityId && activityId !== ready.activityId) await prisma.teamsAutofillDraft.update({ where: { id: draft.id }, data: { activityId } }).catch(() => {});
    await this._record({ workspaceId: workspace.id, email: draft.email, technicianId: tech.id, eventKey: 'autofill', status: 'sent', activityId: activityId || null, conversationId: ready.conversationId, summary: `Autofill: ${data.subject || ''}` });
  }

  /** Which fields still need a value, and which of those the card itself cannot set. */
  async _missing(draft, { requesterEmail, subject, hasImages }) {
    const d = draft.data || {};
    const missing = [];
    const blocking = [];
    if (String(subject || '').trim().length < 3) missing.push('Subject');
    if (!requesterEmail) missing.push('Requester');
    try {
      const { default: formConfig } = await import('./ticketFormConfigService.js');
      const form = await formConfig.getResolvedForm(draft.workspaceId);
      // Category/subcategory are never blocking: without a usable hint the
      // create runs AI classification, which the form rules exempt.
      for (const f of form.fields || []) {
        if (!f.required || f.locked || f.visible === false) continue;
        if (f.key === 'description' && !String(d.descriptionText || '').trim()) blocking.push(f.label);
        if (f.key === 'group' && !form.defaultGroup) blocking.push(f.label);
        if (f.key === 'tags' || f.key === 'cc') blocking.push(f.label);
        if (f.key === 'attachments' && !hasImages) blocking.push(f.label);
      }
      const { default: customFields } = await import('./customFieldService.js');
      const defs = await customFields.listDefinitions(draft.workspaceId);
      for (const def of defs.filter((x) => x.isRequiredOnCreate === true)) {
        if (def.defaultValue === null || def.defaultValue === undefined || def.defaultValue === '') blocking.push(def.label);
      }
    } catch (err) {
      logger.warn(`Teams Autofill: form config unavailable (non-fatal): ${err.message}`);
    }
    return { missing: [...missing, ...blocking], blocking };
  }

  /** The card model for a ready draft. */
  async _readyModel(draft, token, { error = null, inputs = null } = {}) {
    const d = draft.data || {};
    const ws = await prisma.workspace.findUnique({ where: { id: draft.workspaceId }, select: { id: true, name: true, nativeTicketingEnabled: true } });
    const rm = d.requesterMatch || {};
    const matchedEmail = rm.status === 'matched' ? validEmail(rm.candidate?.email) : null;
    const hintEmail = validEmail(d.requesterNameOrEmail);
    const requesterEmail = validEmail(inputs?.requesterEmail) || matchedEmail || hintEmail || null;
    const subject = inputs?.subject ?? d.subject ?? '';
    const images = Array.isArray(draft.images) ? draft.images : [];
    const { missing, blocking } = await this._missing(draft, { requesterEmail, subject, hasImages: images.length > 0 });

    const [top, sub] = d.categoryHint ? String(d.categoryHint).split(/\s*>\s*/) : [null, null];
    const me = draft.technicianId;
    const am = d.assigneeMatch || {};
    const other = am.status === 'matched' && am.technician?.id && am.technician.id !== me ? am.technician : null;
    const assignOptions = [
      ...(other ? [{ title: other.name || 'The named person', value: `tech:${other.id}` }] : []),
      { title: 'Me', value: 'me' },
      { title: 'Let AI route it', value: 'ai' },
      { title: 'Leave unassigned', value: 'none' },
    ];
    const notes = [];
    const n = draft.notes || {};
    if (images.length) notes.push(`${images.length} picture${images.length === 1 ? '' : 's'} will be attached.`);
    if (n.skipped) notes.push(`${n.skipped} picture${n.skipped === 1 ? '' : 's'} could not be read (too big, too many or not PNG/JPEG/GIF/WebP).`);
    if (n.ignoredFiles) notes.push(`${n.ignoredFiles} other file${n.ignoredFiles === 1 ? ' was' : 's were'} left out: Autofill reads pictures and text only.`);
    if (n.passwordLinesRemoved) notes.push('A line that looked like a password was removed before reading.');
    if (blocking.length) notes.push(`This workspace's form also needs ${blocking.join(', ')}, which the card cannot set: finish it in Ticket Pulse.`);
    if (rm.status === 'ambiguous') notes.push('A few people could be the requester: pick one below.');

    const others = (await this._agentWorkspaces(draft.email)).filter((o) => o.workspace.nativeTicketingEnabled && o.workspace.id !== draft.workspaceId).map((o) => ({ id: o.workspace.id, name: o.workspace.name }));
    return {
      draftId: draft.id,
      t: token,
      workspaceName: ws?.name || null,
      otherWorkspaces: others,
      canCreate: ws?.nativeTicketingEnabled === true && blocking.length === 0,
      openUrl: `${baseUrl()}/tickets/new?autofill=${encodeURIComponent(token)}&ws=${draft.workspaceId}`,
      subject: String(subject || '').trim(),
      requesterName: rm.status === 'matched' ? (rm.candidate?.name || null) : (hintEmail ? null : d.requesterNameOrEmail || null),
      requesterEmail,
      requesterCandidates: rm.status === 'ambiguous' ? (rm.candidates || []).slice(0, 5).map((c) => ({ name: c.name, email: validEmail(c.email) })) : [],
      categoryTop: top || null,
      categorySub: d.categoryLevel === 'top' ? null : (sub || null),
      priority: Number(inputs?.priority) || d.priorityHint || 2,
      descriptionMd: textToCardMarkdown(d.descriptionText || ''),
      missing,
      notes,
      assignOptions,
      assignDefault: other ? `tech:${other.id}` : 'me',
      error,
    };
  }

  // -------------------------------------------------------------- card actions

  async _loadDraft(data, email) {
    const id = Number(data?.draftId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const draft = await prisma.teamsAutofillDraft.findUnique({ where: { id } }).catch(() => null);
    if (!draft || lc(draft.email) !== lc(email) || draft.tokenHash !== hashToken(data?.t)) return null;
    return draft;
  }

  /** Returns the card that replaces the one the button sat on. */
  async handleAction(verb, data, email, activity = null) {
    const draft = await this._loadDraft(data, email);
    if (!draft) return autofillCard({}, 'expired');
    const token = data.t;
    if (draft.status === 'created') return this._createdCard(draft);
    if (draft.status === 'discarded') return autofillCard({}, 'discarded');
    if (draft.expiresAt < new Date()) return autofillCard({}, 'expired');
    try {
      if (verb === 'autofill.discard') {
        await prisma.teamsAutofillDraft.update({ where: { id: draft.id }, data: { status: 'discarded', images: [] } });
        logger.info(`Teams Autofill: draft ${draft.id} discarded by ${email}`);
        return autofillCard({ workspaceName: null }, 'discarded');
      }
      if (draft.status === 'reading') return autofillCard({}, 'reading');
      if (verb === 'autofill.rerun') return await this._rerun(draft, token, data, activity);
      if (verb === 'autofill.create') {
        if (draft.status !== 'ready') return autofillCard({ error: 'This draft could not be read. Send the message again.' }, 'error');
        return await this._create(draft, token, data);
      }
      return autofillCard(await this._readyModel(draft, token), 'ready');
    } catch (err) {
      logger.warn(`Teams Autofill ${verb} by ${email} failed (draft ${draft.id}): ${err.message}`);
      const msg = err?.statusCode && err.statusCode < 500 ? String(err.message).slice(0, 300) : 'That did not work. Try again, or use Open in Ticket Pulse.';
      if (draft.status === 'ready') return autofillCard(await this._readyModel(draft, token, { error: msg, inputs: data }), 'ready');
      return autofillCard({ error: msg }, 'error');
    }
  }

  async _createdCard(draft) {
    const t = draft.ticketId ? await prisma.ticket.findFirst({ where: { id: draft.ticketId }, select: { id: true, subject: true, nativeNumber: true, origin: true, freshserviceTicketId: true } }).catch(() => null) : null;
    return autofillCard({ ticketRef: t ? ticketDisplayRef(t) : null, subject: t?.subject || null, ticketUrl: t ? `${baseUrl()}/tickets/${t.id}` : null }, 'created');
  }

  async _rerun(draft, token, data, activity) {
    const wsId = Number(data.workspaceId);
    const option = (await this._agentWorkspaces(draft.email)).find((o) => o.workspace.id === wsId && o.workspace.nativeTicketingEnabled);
    if (!option) return autofillCard(await this._readyModel(draft, token, { error: 'You are not an agent in that workspace, or it has native ticketing off.' }), 'ready');
    const activityId = draft.activityId || activity?.replyToId || null;
    const updated = await prisma.teamsAutofillDraft.update({ where: { id: draft.id }, data: { workspaceId: wsId, technicianId: option.tech.id, status: 'reading', activityId, intakeRunId: null } });
    const images = (Array.isArray(draft.images) ? draft.images : []).map((i) => ({ fileName: i.fileName, mimeType: i.mimeType, buffer: Buffer.from(i.base64, 'base64') }));
    // Reading takes longer than Teams waits for a button: answer now, fill in later.
    this._extractAndShow(updated, token, { text: draft.sourceText || '', images, tech: option.tech, workspace: option.workspace })
      .catch((err) => logger.warn(`Teams Autofill re-read failed (draft ${draft.id}): ${err.message}`));
    return autofillCard({ workspaceName: option.workspace.name }, 'reading');
  }

  async _create(draft, token, input) {
    const d = draft.data || {};
    const subject = String(input.subject ?? d.subject ?? '').trim();
    const requesterEmail = validEmail(input.requesterEmail) || validEmail(input.requesterPick);
    const retry = (error) => this._readyModel(draft, token, { error, inputs: input }).then((m) => autofillCard(m, 'ready'));
    if (subject.length < 3) return retry('Add a subject (3 characters or more).');
    if (!requesterEmail) return retry('Add the requester\'s e-mail first.');

    const tech = await prisma.technician.findFirst({ where: { workspaceId: draft.workspaceId, isActive: true, email: { equals: draft.email, mode: 'insensitive' } }, select: { id: true, name: true, email: true } });
    if (!tech) return autofillCard({ error: 'You are no longer an active agent in that workspace.' }, 'error');
    const ws = await prisma.workspace.findUnique({ where: { id: draft.workspaceId }, select: { id: true, name: true, nativeTicketingEnabled: true } });
    if (!ws?.nativeTicketingEnabled) return autofillCard({ title: 'Ticket Pulse cannot create tickets there yet', error: `Native ticketing is off in ${ws?.name || 'that workspace'}.`, ticketsUrl: `${baseUrl()}/tickets` }, 'error');

    // Already made from the web page with the same proposal? Do not make a second one.
    let intakeRunId = draft.intakeRunId || null;
    if (intakeRunId) {
      const run = await prisma.ticketIntakeRun.findFirst({ where: { id: intakeRunId, workspaceId: draft.workspaceId }, select: { ticketId: true } }).catch(() => null);
      if (run?.ticketId) {
        await prisma.teamsAutofillDraft.update({ where: { id: draft.id }, data: { status: 'created', ticketId: run.ticketId, images: [] } });
        const card = await this._createdCard({ ...draft, ticketId: run.ticketId });
        card.body.push({ type: 'TextBlock', text: 'It was already created from Ticket Pulse, so no second ticket was made.', wrap: true, isSubtle: true, size: 'Small' });
        return card;
      }
      if (!run) intakeRunId = null;
    }

    const rm = d.requesterMatch || {};
    const known = rm.status === 'matched' && validEmail(rm.candidate?.email) === requesterEmail ? rm.candidate : null;
    const picked = (rm.candidates || []).find((c) => validEmail(c.email) === requesterEmail) || null;
    const person = known || picked;
    const priority = Number(input.priority);
    const assign = String(input.assign || 'me');
    const categoryUsable = d.categoryHint && d.categoryLevel !== 'top';
    const [category, subcategory] = categoryUsable ? String(d.categoryHint).split(/\s*>\s*/) : [null, null];
    const source = d.descriptionHtml ? `${d.descriptionHtml}` : `<p>${escapeHtml(d.descriptionText || '')}</p>`;
    const dump = String(draft.sourceText || '').trim();
    const description = dump
      ? `${source}\n<p><br></p><p><strong>— Source material (sent in Teams) —</strong></p>${dump.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}`
      : source;

    const body = {
      subject: subject.slice(0, 500),
      description,
      priority: priority >= 1 && priority <= 4 ? priority : (d.priorityHint || 2),
      ...(d.typeHint ? { ticketType: d.typeHint } : {}),
      requesterEmail,
      ...(person?.requesterId ? { requesterId: person.requesterId } : {}),
      ...(person?.name ? { requesterName: person.name } : {}),
      ...(category ? { category, ...(subcategory ? { subcategory } : {}) } : {}),
      source: TICKET_SOURCE.MS_TEAMS,
      runAiTriage: assign === 'ai',
      aiClassifyOnly: assign !== 'ai' && !category,
    };
    if (assign === 'me') body.assignedTechId = tech.id;
    else if (assign.startsWith('tech:') && Number(assign.slice(5)) > 0) body.assignedTechId = Number(assign.slice(5));

    let workspaceRole = null;
    try {
      const { default: workspaceRepository } = await import('./workspaceRepository.js');
      workspaceRole = await workspaceRepository.getAccessRole(tech.email, draft.workspaceId);
    } catch { workspaceRole = null; }
    const actor = { email: lc(tech.email), name: tech.name, role: 'agent', workspaceRole: workspaceRole || null, technicianId: tech.id, kind: workspaceRole ? 'member' : 'agent', via: 'teams' };

    const { default: ticketService } = await import('./ticketService.js');
    const ticket = await ticketService.createTicket(draft.workspaceId, body, actor, {
      enforceRequired: true,
      allowAssignableOnly: true,
      ...(intakeRunId ? { intakeRunId } : {}),
    });

    // Pictures → normal ticket attachments (best effort, like the web form).
    let attached = 0;
    let attachFailed = 0;
    const images = Array.isArray(draft.images) ? draft.images : [];
    if (images.length) {
      const { default: attachmentService } = await import('./attachmentService.js');
      const { default: mirrorService } = await import('./mirrorService.js');
      for (const img of images) {
        try {
          const stored = await attachmentService.upload({ workspaceId: draft.workspaceId, ticketId: ticket.id, fileName: img.fileName, contentType: img.mimeType, buffer: Buffer.from(img.base64, 'base64'), uploadedBy: actor.email });
          attached++;
          mirrorService.enqueueAttachment(draft.workspaceId, ticket.id, stored.id).catch(() => {});
        } catch (err) {
          attachFailed++;
          logger.warn(`Teams Autofill: picture not attached to ticket ${ticket.id}: ${err.message}`);
        }
      }
    }
    await prisma.teamsAutofillDraft.update({ where: { id: draft.id }, data: { status: 'created', ticketId: ticket.id, images: [] } });
    const ref = ticketDisplayRef(ticket);
    logger.info(`Teams Autofill: ${actor.email} created ${ref} (ticket ${ticket.id}) in workspace ${draft.workspaceId} from draft ${draft.id}; ${attached} picture(s) attached`);
    await this._record({ workspaceId: draft.workspaceId, email: actor.email, technicianId: tech.id, ticketId: ticket.id, eventKey: 'autofill_created', status: 'sent', conversationId: draft.conversationId, activityId: draft.activityId, summary: `Created ${ref} ${subject}`.trim() });

    const who = body.assignedTechId === tech.id ? 'assigned to you' : body.assignedTechId ? 'assigned' : assign === 'ai' ? 'AI is routing it' : 'unassigned';
    const pics = attached ? `, ${attached} picture${attached === 1 ? '' : 's'} attached` : '';
    const lost = attachFailed ? ` ${attachFailed} picture${attachFailed === 1 ? '' : 's'} could not be attached; add ${attachFailed === 1 ? 'it' : 'them'} on the ticket.` : '';
    return autofillCard({
      ticketRef: ref,
      subject,
      workspaceName: ws.name,
      ticketUrl: `${baseUrl()}/tickets/${ticket.id}`,
      message: `${PRIORITY_WORD[body.priority] || 'Medium'} priority, ${who}${pics}.${lost}`,
    }, 'created');
  }

  // -------------------------------------------------------------- web prefill

  /**
   * GET /api/teams-autofill/:token — the New Ticket page reads the draft.
   * Only the person who sent the message, only for 30 minutes.
   */
  async getPrefill(token, email) {
    const raw = String(token || '');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(raw)) throw new NotFoundError('This Autofill link is not valid');
    const draft = await prisma.teamsAutofillDraft.findUnique({ where: { tokenHash: hashToken(raw) } });
    if (!draft || lc(draft.email) !== lc(email)) throw new NotFoundError('This Autofill link is not valid for you');
    const workspace = await prisma.workspace.findUnique({ where: { id: draft.workspaceId }, select: { id: true, name: true } });
    if (draft.status === 'created') {
      const t = draft.ticketId ? await prisma.ticket.findFirst({ where: { id: draft.ticketId }, select: { id: true, nativeNumber: true, origin: true, freshserviceTicketId: true } }).catch(() => null) : null;
      return { status: 'created', workspace, ticketId: t?.id || null, ticketRef: t ? ticketDisplayRef(t) : null };
    }
    if (draft.expiresAt < new Date()) throw new AppError('This Autofill draft has expired. Send the bot your message again.', 410);
    if (draft.status === 'discarded') throw new AppError('This Autofill draft was discarded in Teams.', 410);
    if (draft.status !== 'ready') throw new AppError(draft.status === 'reading' ? 'Ticket Pulse is still reading this message. Try again in a few seconds.' : 'This message could not be read. Send it to the bot again.', 409);
    return {
      status: 'ready',
      workspace,
      runId: draft.intakeRunId || null,
      data: draft.data || {},
      sourceText: draft.sourceText || '',
      images: (Array.isArray(draft.images) ? draft.images : []).map((i) => ({ fileName: i.fileName, mimeType: i.mimeType, base64: i.base64 })),
      expiresAt: draft.expiresAt,
    };
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const teamsIntakeService = new TeamsIntakeService();
export default teamsIntakeService;
export { TeamsIntakeService };
