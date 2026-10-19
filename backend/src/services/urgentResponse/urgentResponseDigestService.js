/**
 * Urgent response — the weekly e-mail to a workspace's admins
 * (plans/URGENT_RESPONSE_PLAN.md).
 *
 * Monday 08:10 Pacific, one e-mail per workspace whose Urgent rule is in
 * Shadow or Live: what the rule did in the last seven days (in Shadow: what it
 * would have done), counted by layer, with a few of its own sentences and a
 * link to the log. Counts of tickets only — never a number per person.
 *
 * Quiet when the mode is off or the week had nothing; the sandbox workspaces
 * never get one. Kill switch: URGENT_RESPONSE_DIGEST=false.
 */
import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import { resolvePublicBaseUrl } from '../../utils/publicBaseUrl.js';
import { soft } from './settingsService.js';

const SANDBOX_WORKSPACES = [6, 7, 8];
const WINDOW_MS = 7 * 24 * 3600e3;
const MAX_WORKSPACES = 100;
const MAX_EXAMPLES = 5;
const COUNT_KEYS = ['redirected', 'held', 'moved', 'raiseMoved', 'clockMoved', 'toldOwnerAway', 'teamTold', 'coordinator', 'onCallAssigned', 'undone'];

/** The table of the e-mail: layer by layer, in the order things happen to a ticket. */
const SECTIONS = [
  { title: 'When assigning', rows: [['redirected', 'Assigned to someone at work instead'], ['held', 'Held: nobody was at work']] },
  { title: 'When it became urgent', rows: [['raiseMoved', 'Moved to someone at work'], ['toldOwnerAway', 'Owner away, team told'], ['onCallAssigned', 'Given to the on-call person']] },
  { title: 'Untouched clock', rows: [['teamTold', 'Team told'], ['clockMoved', 'Moved'], ['coordinator', 'Sent to the coordinator']] },
  { title: 'Undone', rows: [['undone', 'Moves put back by a person']] },
];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const counts = (src) => Object.fromEntries(COUNT_KEYS.map((k) => [k, Number(src?.[k]) || 0]));
const total = (c) => COUNT_KEYS.reduce((sum, k) => sum + c[k], 0);

class UrgentResponseDigestService {
  enabled() {
    return process.env.URGENT_RESPONSE_DIGEST !== 'false';
  }

  /** The week the e-mail covers: the seven days that end at the run. */
  window(now = new Date()) {
    return { since: new Date(now.getTime() - WINDOW_MS), until: now };
  }

  /** Workspace admins plus every super admin (reportRecipients). */
  async _recipients(workspaceId) {
    const { reportRecipients } = await import('../reportRecipients.js');
    return reportRecipients(workspaceId);
  }

  /**
   * The week's numbers and example sentences, from the engine's weeklySummary.
   * `empty` = nothing happened on either side (live or Shadow).
   */
  async buildDigest(workspaceId, { since, until }) {
    const { default: engine } = await import('./urgentResponseService.js');
    const summary = await engine.weeklySummary(Number(workspaceId), { since, until }) || {};
    const live = counts(summary.live);
    const shadow = counts(summary.shadow);
    return {
      since,
      until,
      mode: summary.mode || 'off',
      live,
      shadow,
      examples: (Array.isArray(summary.examples) ? summary.examples : []).filter((e) => e?.sentence).slice(0, MAX_EXAMPLES),
      empty: total(live) + total(shadow) === 0,
    };
  }

  /**
   * Outlook-safe: tables only, every coloured band a cell with bgcolor and
   * background-color, an explicit colour on every piece of text, no gradients.
   */
  renderHtml(digest, { workspaceName, baseUrl }) {
    const font = 'font-family:Segoe UI,Arial,sans-serif;';
    const shadowMode = digest.mode !== 'live';
    const main = shadowMode ? digest.shadow : digest.live;
    const other = shadowMode ? digest.live : digest.shadow;
    const cell = `padding:7px 10px;border-bottom:1px solid #e2e8f0;${font}font-size:13px;color:#0f172a;vertical-align:top;`;
    const head = `padding:12px 10px 5px;border-bottom:2px solid #cbd5e1;${font}font-size:12px;font-weight:600;color:#475569;`;
    const rows = SECTIONS.map((section) => `
      <tr><td colspan="2" style="${head}">${esc(section.title)}</td></tr>${section.rows.map(([key, label]) => `
      <tr><td style="${cell}">${esc(label)}</td><td align="right" style="${cell}font-weight:600;white-space:nowrap;">${main[key]}</td></tr>`).join('')}`).join('');
    const modeLine = shadowMode
      ? 'Shadow: nothing was moved; this is what would have happened.'
      : 'Live: these tickets were really moved, and the people named were told.';
    const otherLine = total(other)
      ? `<p style="${font}font-size:13px;color:#64748b;margin:0 0 12px;">The mode changed during the week: ${total(other)} more ${total(other) === 1 ? 'entry was' : 'entries were'} logged in ${shadowMode ? 'Live' : 'Shadow'}. The log has them.</p>` : '';
    const examples = digest.examples.map((e) => {
      const ref = e.displayRef || (e.ticketId ? `Ticket ${e.ticketId}` : '');
      const link = e.ticketId
        ? `<a href="${esc(`${baseUrl}/tickets/${e.ticketId}`)}" style="color:#1d4ed8;text-decoration:none;font-weight:600;">${esc(ref)}</a>`
        : `<span style="color:#475569;font-weight:600;">${esc(ref)}</span>`;
      return `
      <tr><td style="${cell}white-space:nowrap;">${link}</td><td style="${cell}">${esc(e.sentence)}</td></tr>`;
    }).join('');
    const logUrl = `${baseUrl}/settings#urgent-response`;
    return `<!doctype html><html><body style="margin:0;padding:0;background-color:#f8fafc;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f8fafc" style="background-color:#f8fafc;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;background-color:#ffffff;border:1px solid #e2e8f0;">
<tr><td bgcolor="#1e3a8a" style="background-color:#1e3a8a;padding:16px 20px;${font}font-size:17px;font-weight:600;color:#ffffff;">Urgent response last week - ${esc(workspaceName)}</td></tr>
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:16px 20px;">
<p style="${font}font-size:14px;color:#0f172a;margin:0 0 6px;"><strong style="color:#0f172a;">${esc(modeLine)}</strong></p>
<p style="${font}font-size:13px;color:#475569;margin:0 0 12px;">${total(main)} ${total(main) === 1 ? 'entry' : 'entries'} in the seven days to ${esc(digest.until.toISOString().slice(0, 10))}. Counts are tickets, not people.</p>
${otherLine}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 18px;">${rows}
</table>
${examples ? `<p style="${font}font-size:14px;color:#0f172a;margin:0 0 4px;"><strong style="color:#0f172a;">In its own words</strong></p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 18px;">${examples}
</table>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#1d4ed8" style="background-color:#1d4ed8;padding:9px 16px;"><a href="${esc(logUrl)}" style="${font}font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Open the log</a></td></tr></table>
<p style="${font}font-size:12px;color:#64748b;margin:14px 0 0;">Settings, Urgent Response, Log. A live move can be undone there.</p>
</td></tr></table></td></tr></table></body></html>`;
  }

  /** The Monday 08:10 job. Never throws. */
  async sendDigests({ now = new Date(), dryRun = false } = {}) {
    const out = [];
    if (!this.enabled()) return out;
    try {
      const rows = await soft(() => prisma.urgentResponseSettings.findMany({
        where: { mode: { not: 'off' }, workspaceId: { notIn: SANDBOX_WORKSPACES } },
        select: { workspaceId: true, mode: true },
        orderBy: { workspaceId: 'asc' },
        take: MAX_WORKSPACES,
      }), []);
      if (!rows.length) return out;
      const ids = rows.map((r) => r.workspaceId);
      const workspaces = await soft(() => prisma.workspace.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, isActive: true },
        take: ids.length,
      }), []);
      const byId = new Map(workspaces.map((w) => [w.id, w]));
      const baseUrl = resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
      const win = this.window(now);
      for (const row of rows) {
        const workspaceId = row.workspaceId;
        const workspace = byId.get(workspaceId);
        if (SANDBOX_WORKSPACES.includes(workspaceId) || workspace?.isActive === false) continue;
        try {
          const digest = await this.buildDigest(workspaceId, win);
          if (digest.mode === 'off') { out.push({ workspaceId, skipped: 'mode_off' }); continue; }
          if (digest.empty) { out.push({ workspaceId, skipped: 'nothing_to_report' }); continue; }
          const to = await this._recipients(workspaceId);
          if (!to.length) { out.push({ workspaceId, skipped: 'no_recipients' }); continue; }
          const workspaceName = workspace?.name || `Workspace ${workspaceId}`;
          const html = this.renderHtml(digest, { workspaceName, baseUrl });
          const subject = `Ticket Pulse - Urgent response last week: ${workspaceName}`;
          if (dryRun) { out.push({ workspaceId, dryRun: true, to, subject, html, digest }); continue; }
          const { sendTransactionalEmail } = await import('../transactionalEmailService.js');
          const result = await sendTransactionalEmail({ workspaceId, to, subject, html, label: 'urgent-response-digest' });
          out.push({ workspaceId, sent: result?.sent === true, to: to.length, mode: digest.mode });
        } catch (error) {
          logger.warn(`Urgent response digest failed for workspace ${workspaceId} (non-fatal): ${error.message}`);
          out.push({ workspaceId, error: error.message });
        }
      }
    } catch (error) {
      logger.warn(`Urgent response digest tick failed (non-fatal): ${error.message}`);
    }
    return out;
  }
}

const urgentResponseDigestService = new UrgentResponseDigestService();
export default urgentResponseDigestService;
export { UrgentResponseDigestService };
