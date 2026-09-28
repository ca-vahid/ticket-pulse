/**
 * Noise auto-close digest + "Reopen & route" (27 Sep 2026, Vahid's review of
 * the AI auto-closes).
 *
 * Weekday mornings, one e-mail per workspace that auto-closes noise, to that
 * workspace's admins: every ticket the AI closed since the last digest (with
 * its one-line reason and a link to the run, where "Reopen & route" is one
 * click), what the close guard held back, and a count per noise rule. The
 * rule closes are summarized, not listed — they are deterministic and the
 * noise-rule page already shows them. Monday's digest covers the weekend.
 *
 * reopenAndRoute puts a wrongly closed ticket back: status Open (through
 * FreshService for an FS-born ticket, locally for a TP-born one), the noise
 * flag cleared with an audit row — which the close guard reads, so the fresh
 * routing run can never close it again — and a new pipeline run to route it.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const SANDBOX_WORKSPACES = [6, 7, 8];
const DEFAULT_WINDOW_MS = 24 * 3600e3;
const MAX_WINDOW_MS = 96 * 3600e3;
const MAX_LISTED = 40;
const HELD_PREFIX = 'Noise close held:';

export const digestEnabledKey = (workspaceId) => `noise_close_digest_ws${Number(workspaceId)}`;
export const digestLastSentKey = (workspaceId) => `noise_close_digest_last_ws${Number(workspaceId)}`;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripHtml = (v) => String(v || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export function ticketRef(ticket) {
  if (!ticket) return 'ticket';
  if (ticket.origin === 'ticketpulse' && ticket.nativeNumber) return `TP-${ticket.nativeNumber}`;
  return ticket.freshserviceTicketId ? `#${ticket.freshserviceTicketId}` : `ticket ${ticket.id}`;
}

/** The AI's own one-line reason, best source first. */
export function closeReason(recommendation) {
  const rec = recommendation || {};
  const text = String(rec.nonActionableReason || '').trim()
    || stripHtml(rec.closureNoticeHtml)
    || String(rec.overallReasoning || '').trim();
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] || text;
  return firstSentence.length > 180 ? `${firstSentence.slice(0, 177)}…` : firstSentence;
}

class NoiseCloseDigestService {
  async _recipients(workspaceId) {
    const access = await prisma.workspaceAccess.findMany({
      where: { workspaceId: Number(workspaceId), role: 'admin' },
      select: { email: true },
    }).catch(() => []);
    const emails = [...new Set(access.map((a) => String(a.email || '').trim().toLowerCase()).filter(Boolean))];
    if (emails.length) return emails;
    const raw = await settingsRepository.get('admin_emails').catch(() => null);
    const source = raw && String(raw).trim() ? String(raw) : (process.env.ADMIN_EMAILS || '');
    return source.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  }

  async enabled(workspaceId) {
    const raw = await settingsRepository.get(digestEnabledKey(workspaceId)).catch(() => null);
    if (raw === null || raw === undefined || raw === '') return true;
    return raw === true || raw === 'true';
  }

  /** The window this workspace's next digest covers. */
  async window(workspaceId, now = new Date()) {
    const raw = await settingsRepository.get(digestLastSentKey(workspaceId)).catch(() => null);
    const last = raw ? new Date(raw) : null;
    const floor = now.getTime() - MAX_WINDOW_MS;
    const since = last && !Number.isNaN(last.getTime())
      ? new Date(Math.max(last.getTime(), floor))
      : new Date(now.getTime() - DEFAULT_WINDOW_MS);
    return { since, until: now };
  }

  async buildDigest(workspaceId, { since, until }) {
    const where = { workspaceId: Number(workspaceId), createdAt: { gte: since, lt: until } };
    const select = {
      id: true, triggerSource: true, recommendation: true, syncStatus: true, errorMessage: true,
      ticket: { select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true, isNoise: true, requester: { select: { name: true, email: true } } } },
    };
    const [closed, held] = await Promise.all([
      prisma.assignmentPipelineRun.findMany({
        where: { ...where, decision: 'noise_dismissed', syncStatus: 'synced' },
        select,
        orderBy: { id: 'asc' },
        take: 500,
      }),
      prisma.assignmentPipelineRun.findMany({
        where: { ...where, decision: 'pending_review', errorMessage: { startsWith: HELD_PREFIX } },
        select,
        orderBy: { id: 'asc' },
        take: 200,
      }),
    ]);
    const aiClosed = closed.filter((r) => r.triggerSource !== 'noise_rule');
    const ruleCounts = {};
    for (const r of closed.filter((x) => x.triggerSource === 'noise_rule')) {
      const name = r.recommendation?.noiseRuleMatched || 'Unnamed rule';
      ruleCounts[name] = (ruleCounts[name] || 0) + 1;
    }
    return {
      since, until,
      aiClosed: aiClosed.map((r) => ({
        runId: r.id,
        ref: ticketRef(r.ticket),
        subject: r.ticket?.subject || '(no subject)',
        requester: r.ticket?.requester?.name || r.ticket?.requester?.email || null,
        reason: closeReason(r.recommendation),
        stillClosed: r.ticket?.isNoise === true,
      })),
      held: held.map((r) => ({
        runId: r.id,
        ref: ticketRef(r.ticket),
        subject: r.ticket?.subject || '(no subject)',
        why: String(r.errorMessage || '').slice(HELD_PREFIX.length).trim(),
      })),
      rules: Object.entries(ruleCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      ruleTotal: closed.length - aiClosed.length,
    };
  }

  renderHtml(digest, { workspaceName, baseUrl }) {
    const link = (runId, extra = '') => `${baseUrl}/assignments/run/${runId}${extra}`;
    const cell = 'padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#0f172a;vertical-align:top;';
    const muted = 'color:#64748b;';
    const rows = digest.aiClosed.slice(0, MAX_LISTED).map((r) => `
      <tr>
        <td style="${cell}white-space:nowrap;"><a href="${esc(link(r.runId, '?reopen=1'))}" style="color:#1d4ed8;text-decoration:none;font-weight:600;">${esc(r.ref)}</a></td>
        <td style="${cell}">${esc(r.subject)}${r.requester ? `<br><span style="${muted}">${esc(r.requester)}</span>` : ''}<br><span style="${muted}">${esc(r.reason)}</span></td>
        <td style="${cell}white-space:nowrap;">${r.stillClosed ? `<a href="${esc(link(r.runId, '?reopen=1'))}" style="color:#1d4ed8;">Reopen &amp; route</a>` : `<span style="${muted}">already reopened</span>`}</td>
      </tr>`).join('');
    const more = digest.aiClosed.length > MAX_LISTED
      ? `<p style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#64748b;">…and ${digest.aiClosed.length - MAX_LISTED} more in Assignment Review → History.</p>` : '';
    const heldRows = digest.held.slice(0, MAX_LISTED).map((r) => `
      <tr>
        <td style="${cell}white-space:nowrap;"><a href="${esc(link(r.runId))}" style="color:#1d4ed8;text-decoration:none;font-weight:600;">${esc(r.ref)}</a></td>
        <td style="${cell}">${esc(r.subject)}<br><span style="${muted}">${esc(r.why)}</span></td>
      </tr>`).join('');
    const ruleLine = digest.rules.length
      ? `<p style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#334155;">Noise rules also closed ${digest.ruleTotal}: ${digest.rules.map((r) => `${esc(r.name)} (${r.count})`).join(', ')}.</p>` : '';
    const table = (head, body) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:8px 0 18px;">${head}${body}</table>`;
    const th = (t) => `<td style="padding:6px 10px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:600;color:#475569;border-bottom:2px solid #cbd5e1;">${t}</td>`;
    return `<!doctype html><html><body style="margin:0;padding:0;background-color:#f8fafc;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f8fafc" style="background-color:#f8fafc;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="max-width:680px;background-color:#ffffff;border:1px solid #e2e8f0;">
<tr><td bgcolor="#1e3a8a" style="background-color:#1e3a8a;padding:16px 20px;font-family:Segoe UI,Arial,sans-serif;font-size:17px;font-weight:600;color:#ffffff;">What the AI closed as noise - ${esc(workspaceName)}</td></tr>
<tr><td style="padding:16px 20px;">
<p style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;margin:0 0 6px;">${digest.aiClosed.length} ticket${digest.aiClosed.length === 1 ? '' : 's'} closed by the AI since ${esc(digest.since.toISOString().slice(0, 16).replace('T', ' '))} UTC. If one of them needed a person, open it and choose <strong>Reopen &amp; route</strong> - it reopens the ticket and routes it like a new one.</p>
${digest.aiClosed.length ? table(`<tr>${th('Ticket')}${th('Subject and why it was closed')}${th('')}</tr>`, rows) : ''}${more}
${digest.held.length ? `<p style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;margin:12px 0 6px;"><strong>Held for a person instead of closed (${digest.held.length})</strong></p>${table(`<tr>${th('Ticket')}${th('Why it was held')}</tr>`, heldRows)}` : ''}
${ruleLine}
</td></tr></table></td></tr></table></body></html>`;
  }

  /** The 08:00 weekday job. Never throws. */
  async sendDigests({ now = new Date(), dryRun = false } = {}) {
    const out = [];
    if (process.env.NOISE_CLOSE_DIGEST === 'false') return out;
    try {
      const configs = await prisma.assignmentConfig.findMany({
        where: { autoCloseNoise: true, workspaceId: { notIn: SANDBOX_WORKSPACES } },
        select: { workspaceId: true, workspace: { select: { name: true, isActive: true } } },
      });
      const baseUrl = resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
      for (const cfg of configs) {
        const workspaceId = cfg.workspaceId;
        if (cfg.workspace && cfg.workspace.isActive === false) continue;
        if (!(await this.enabled(workspaceId))) continue;
        try {
          const win = await this.window(workspaceId, now);
          const digest = await this.buildDigest(workspaceId, win);
          if (!digest.aiClosed.length && !digest.held.length) {
            if (!dryRun) await settingsRepository.set(digestLastSentKey(workspaceId), now.toISOString());
            out.push({ workspaceId, skipped: 'nothing_to_report' });
            continue;
          }
          const to = await this._recipients(workspaceId);
          if (!to.length) { out.push({ workspaceId, skipped: 'no_recipients' }); continue; }
          const workspaceName = cfg.workspace?.name || `Workspace ${workspaceId}`;
          const html = this.renderHtml(digest, { workspaceName, baseUrl });
          const subject = `Ticket Pulse: ${digest.aiClosed.length} closed as noise${digest.held.length ? `, ${digest.held.length} held` : ''} - ${workspaceName}`;
          if (dryRun) { out.push({ workspaceId, dryRun: true, to, subject, html, digest }); continue; }
          const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
          const result = await sendTransactionalEmail({ workspaceId, to, subject, html, label: 'noise-close-digest' });
          if (result?.sent) await settingsRepository.set(digestLastSentKey(workspaceId), now.toISOString());
          out.push({ workspaceId, sent: result?.sent === true, to: to.length, aiClosed: digest.aiClosed.length, held: digest.held.length });
        } catch (error) {
          logger.warn(`Noise close digest failed for workspace ${workspaceId} (non-fatal): ${error.message}`);
          out.push({ workspaceId, error: error.message });
        }
      }
    } catch (error) {
      logger.warn(`Noise close digest tick failed (non-fatal): ${error.message}`);
    }
    return out;
  }

  /**
   * Reopen a ticket the AI (or a rule) closed as noise and route it.
   * @returns {Promise<{ticketId:number, reopened:boolean, routing:boolean}>}
   */
  async reopenAndRoute(runId, workspaceId, actor) {
    const run = await prisma.assignmentPipelineRun.findUnique({
      where: { id: Number(runId) },
      select: { id: true, workspaceId: true, ticketId: true, decision: true },
    });
    if (!run || run.workspaceId !== Number(workspaceId)) throw new NotFoundError(`Run ${runId} not found in this workspace`);
    if (run.decision !== 'noise_dismissed') throw new ValidationError('Only a run that closed its ticket as noise can be reopened from here');

    const ticket = await prisma.ticket.findUnique({
      where: { id: run.ticketId },
      select: { id: true, origin: true, freshserviceTicketId: true, status: true },
    });
    if (!ticket) throw new NotFoundError('Ticket not found');

    const [{ default: ticketService }, { default: statusService }] = await Promise.all([
      import('./ticketService.js'),
      import('./statusService.js'),
    ]);
    const base = await statusService.baseStatusOf(workspaceId, ticket.status);
    let reopened = false;
    if (['Resolved', 'Closed'].includes(base)) {
      if (ticket.origin === 'ticketpulse' || !ticket.freshserviceTicketId) {
        await ticketService.changeStatus(ticket.id, Number(workspaceId), 'Open', actor);
      } else {
        await ticketService.updateFsTicket(ticket.id, Number(workspaceId), { status: 'Open' }, actor);
      }
      reopened = true;
    }
    // The audit row this writes ('noise_cleared') is what the close guard
    // reads: the routing run below may not close this ticket again.
    await ticketService.setNoise(ticket.id, Number(workspaceId), { noise: false }, actor);

    const { default: assignmentPipelineService } = await import('./assignmentPipelineService.js');
    assignmentPipelineService.runPipeline(ticket.id, Number(workspaceId), 'manual').catch((error) => {
      logger.error('Reopen & route: pipeline run failed', { runId, ticketId: ticket.id, error: error.message });
    });
    logger.info('Noise close reversed: ticket reopened and routed', {
      runId, ticketId: ticket.id, workspaceId, reopened, by: actor?.email || actor?.name || null,
    });
    return { ticketId: ticket.id, reopened, routing: true };
  }
}

export default new NoiseCloseDigestService();
