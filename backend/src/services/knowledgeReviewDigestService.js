/**
 * "Review due" digest for article owners (Auto-help P1, plans/AUTO_HELP_P1_PLAN.md
 * §4 "Stale articles"; research R1: scheduled accuracy review).
 *
 * In-app, always: GET /knowledge/review-digest gives the signed-in person
 * THEIR published articles past their review date, grouped by category — the
 * Articles tab shows it as a quiet line with a link to the list.
 *
 * Weekly e-mail, opt-in per workspace (knowledge_settings.review_digest_enabled,
 * off by default): Monday 08:00-08:59 Pacific, once per workspace per week,
 * one mail per owner listing their due articles grouped by category. The
 * week is CLAIMED before anything is sent: an app_settings row
 * `knowledge_review_digest:<ws>:<ISO week>` is inserted first, and the unique
 * key means only one container (or one tick after a restart) wins it — the
 * others skip, so the digest can never go out twice. Sent
 * with the transactional mail helper in PRODUCTION only — anywhere else the
 * digest is built and logged, never sent. FreshService-imported articles have
 * no owner here (FreshService owns their review) and are left out.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { isReviewOverdue, reviewDueAt } from './knowledgeArticleService.js';
import knowledgeSettingsService from './knowledgeSettingsService.js';
import { pacificParts } from '../utils/quietHours.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';

const SCAN = 5000;
export const CLAIM_PREFIX = 'knowledge_review_digest';
const CLAIM_KEEP_MS = 60 * 86400e3;
const PER_OWNER_MAX = 50;
const WEEK_MS = 7 * 86400e3;

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function mailSendingAllowed(env = process.env) {
  return env.NODE_ENV === 'production';
}

/** Monday, 08:00-08:59 Pacific. */
export function isDigestWindow(now = new Date()) {
  const { hour, weekday } = pacificParts(now);
  return weekday === 'Mon' && hour === 8;
}

/** ISO week of the Pacific calendar date, e.g. "2026-W40". */
export function isoWeekKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const d = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  const dow = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // the Thursday of this week decides the year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400e3 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function claimKey(workspaceId, now = new Date()) {
  return `${CLAIM_PREFIX}:${Number(workspaceId)}:${isoWeekKey(now)}`;
}

/**
 * Owners -> their overdue published articles, grouped by category name.
 * Pure over rows. [{ ownerEmail, count, groups: [{ category, articles: [...] }] }]
 */
export function groupByOwner(rows, categoryNames = new Map(), now = Date.now()) {
  const byOwner = new Map();
  for (const r of rows || []) {
    if (!r.ownerEmail || r.source === 'fs_solution' || !isReviewOverdue({ ...r, status: 'published' }, now)) continue;
    const owner = String(r.ownerEmail).toLowerCase();
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(r);
  }
  return [...byOwner.entries()].map(([ownerEmail, list]) => {
    const groups = new Map();
    for (const a of list.slice(0, PER_OWNER_MAX)) {
      const cat = categoryNames.get(a.subcategoryId) || categoryNames.get(a.categoryId) || 'No category';
      if (!groups.has(cat)) groups.set(cat, []);
      const due = reviewDueAt(a);
      groups.get(cat).push({
        id: a.id,
        title: a.title,
        reviewDueAt: due,
        daysOverdue: due ? Math.max(0, Math.floor((now - due.getTime()) / 86400e3)) : null,
        lastVerifiedAt: a.lastVerifiedAt || null,
      });
    }
    return {
      ownerEmail,
      count: list.length,
      groups: [...groups.entries()]
        .map(([category, articles]) => ({ category, articles: articles.sort((x, y) => (y.daysOverdue || 0) - (x.daysOverdue || 0)) }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
  }).sort((a, b) => b.count - a.count);
}

/** The digest e-mail (plain HTML, table-free, no gradients — Outlook-safe). */
export function digestEmail({ owner, workspaceName, baseUrl }) {
  const link = (id) => (baseUrl ? `${baseUrl}/knowledge/articles/${id}` : null);
  const lines = [];
  lines.push(`<p style="margin:0 0 12px">${owner.count === 1 ? 'One article you own is' : `${owner.count} articles you own are`} due for an accuracy check in ${escapeHtml(workspaceName || 'Knowledge')}. Open each one, check the steps still work, then press <b>Mark as verified</b> (or fix it first).</p>`);
  for (const g of owner.groups) {
    lines.push(`<p style="margin:14px 0 4px;font-weight:600">${escapeHtml(g.category)}</p>`);
    lines.push('<ul style="margin:0;padding-left:18px">');
    for (const a of g.articles) {
      const url = link(a.id);
      const title = url ? `<a href="${escapeHtml(url)}">${escapeHtml(a.title)}</a>` : escapeHtml(a.title);
      lines.push(`<li style="margin:2px 0">${title}${a.daysOverdue ? ` <span style="color:#6b7280">— ${a.daysOverdue} day${a.daysOverdue === 1 ? '' : 's'} overdue</span>` : ''}</li>`);
    }
    lines.push('</ul>');
  }
  lines.push('<p style="margin:16px 0 0;color:#6b7280;font-size:12px">Auto-help ranks overdue articles lower until someone checks them. You get this on Mondays while any of your articles is due.</p>');
  const text = [
    `${owner.count} article(s) you own are due for an accuracy check.`,
    ...owner.groups.flatMap((g) => ['', g.category, ...g.articles.map((a) => `- ${a.title}${link(a.id) ? ` (${link(a.id)})` : ''}`)]),
  ].join('\n');
  return {
    subject: `${owner.count} Knowledge article${owner.count === 1 ? '' : 's'} due for review`,
    html: lines.join(''),
    text,
  };
}

class KnowledgeReviewDigestService {
  async _rows(workspaceId, ownerEmail = null) {
    return Promise.resolve()
      .then(() => prisma.knowledgeArticle.findMany({
        where: {
          workspaceId: Number(workspaceId),
          status: 'published',
          source: { not: 'fs_solution' },
          ownerEmail: ownerEmail ? { equals: String(ownerEmail).toLowerCase(), mode: 'insensitive' } : { not: null },
        },
        select: {
          id: true, title: true, source: true, ownerEmail: true, categoryId: true, subcategoryId: true,
          lastVerifiedAt: true, createdAt: true, reviewEveryDays: true,
        },
        take: SCAN,
      }))
      .catch((err) => { logger.warn(`Review digest: articles unavailable (ws ${workspaceId}): ${err.message}`); return []; });
  }

  async _categoryNames(workspaceId) {
    const rows = await Promise.resolve()
      .then(() => prisma.competencyCategory.findMany({
        where: { workspaceId: Number(workspaceId) },
        select: { id: true, name: true, parentId: true },
        take: 2000,
      }))
      .catch(() => []);
    const byId = new Map((rows || []).map((c) => [c.id, c]));
    const names = new Map();
    for (const c of rows || []) {
      const parent = c.parentId ? byId.get(c.parentId) : null;
      names.set(c.id, parent ? `${parent.name} → ${c.name}` : c.name);
    }
    return names;
  }

  /** The signed-in person's own due list (in-app). */
  async forOwner(workspaceId, ownerEmail) {
    if (!ownerEmail) return { count: 0, groups: [] };
    const [rows, names] = await Promise.all([this._rows(workspaceId, ownerEmail), this._categoryNames(workspaceId)]);
    const [mine] = groupByOwner(rows, names);
    return mine ? { count: mine.count, groups: mine.groups } : { count: 0, groups: [] };
  }

  /**
   * One workspace's weekly digest. Production sends; anywhere else it only
   * builds and logs. Returns { owners, sent, dryRun }.
   */
  async sendForWorkspace(workspaceId, { now = new Date(), send: sendWanted = mailSendingAllowed() } = {}) {
    const ws = Number(workspaceId);
    // Hard stop: a local or preview process never sends (tests stub the mail module).
    const send = sendWanted && (mailSendingAllowed() || process.env.NODE_ENV === 'test');
    const [rows, names, wsRow] = await Promise.all([
      this._rows(ws),
      this._categoryNames(ws),
      Promise.resolve().then(() => prisma.workspace.findUnique({ where: { id: ws }, select: { name: true } })).catch(() => null),
    ]);
    const owners = groupByOwner(rows, names, now.getTime());
    let sent = 0;
    const baseUrl = (() => { try { return resolvePublicBaseUrl(); } catch { return null; } })();
    for (const owner of owners) {
      const mail = digestEmail({ owner, workspaceName: wsRow?.name || null, baseUrl });
      if (!send) {
        logger.info(`Review digest (dry run, ws ${ws}): would mail ${owner.ownerEmail} about ${owner.count} article(s)`);
        continue;
      }
      const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
      const res = await sendTransactionalEmail({
        workspaceId: ws, to: [owner.ownerEmail], subject: mail.subject, html: mail.html, text: mail.text, label: 'knowledge-review-digest',
      });
      if (res?.sent) sent += 1;
    }
    await knowledgeSettingsService.record(ws, { reviewDigestSentAt: now });
    return { owners: owners.length, sent, dryRun: !send };
  }

  /**
   * Claim this workspace's digest for this ISO week BEFORE sending: insert
   * the claim row; the unique key makes a second container's insert fail
   * (P2002) and that one skips. Any other failure also skips — better one
   * missed Monday than a double send. Old claims are tidied away.
   * @returns {Promise<boolean>} true when this process owns the week
   */
  async claimWeek(workspaceId, now = new Date()) {
    const key = claimKey(workspaceId, now);
    try {
      await prisma.appSettings.create({
        data: { key, value: JSON.stringify({ claimedAt: now.toISOString(), pid: process.pid }), description: 'Knowledge review digest: this week is sent (or being sent)' },
      });
    } catch (err) {
      if (err?.code !== 'P2002') logger.warn(`Review digest: week claim failed (ws ${workspaceId}), skipping this week: ${err.message}`);
      return false;
    }
    await Promise.resolve()
      .then(() => prisma.appSettings.deleteMany({
        where: { key: { startsWith: `${CLAIM_PREFIX}:${Number(workspaceId)}:`, not: key }, updatedAt: { lt: new Date(now.getTime() - CLAIM_KEEP_MS) } },
      }))
      .catch(() => {});
    return true;
  }

  /** Worker entry: Monday 08:00 PT, each opted-in workspace at most once a week (claimed first). */
  async tick(now = new Date()) {
    if (!isDigestWindow(now)) return { skipped: 'not_monday_8am' };
    const workspaces = await knowledgeSettingsService.enabledWorkspaces('reviewDigestEnabled');
    const out = [];
    for (const s of workspaces) {
      const last = s.reviewDigestSentAt ? new Date(s.reviewDigestSentAt).getTime() : 0;
      if (now.getTime() - last < WEEK_MS - 2 * 3600e3) continue; // already sent this week
      if (!(await this.claimWeek(s.workspaceId, now))) {
        out.push({ workspaceId: s.workspaceId, skipped: 'claimed' });
        continue;
      }
      out.push({ workspaceId: s.workspaceId, ...(await this.sendForWorkspace(s.workspaceId, { now }).catch((err) => ({ error: err.message }))) });
    }
    return { workspaces: out };
  }
}

const knowledgeReviewDigestService = new KnowledgeReviewDigestService();
export default knowledgeReviewDigestService;
export { KnowledgeReviewDigestService };
