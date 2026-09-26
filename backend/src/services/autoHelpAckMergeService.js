/**
 * "Ticket arrived" ack + Auto-help answer = ONE e-mail (integration W3, Vahid:
 * "merge", plans/AUTO_HELP_INTEGRATION_PLAN.md D).
 *
 * A send-email node with `autoHelpMerge: { enabled, waitMinutes }` (default 5,
 * max 15) asks here before it sends. When Auto-help is EXPECTED to send an
 * answer on its own (autoHelpContextService.expectedFor — auto mode, locked in
 * this build), the node parks for waitMinutes (a durable workflow delay) and
 * leaves a pending ack. If Auto-help sends its answer inside that window, the
 * delivery service takes the ack and puts it on top of the answer as a short
 * paragraph, and the node — when it wakes — finds it consumed and sends
 * nothing. Otherwise the node wakes, releases the ack and sends as usual.
 *
 * Nothing is held back when Auto-help will not send by itself: shadow runs,
 * and approve mode (an agent's click may come hours later) — there the ack
 * goes out at once, unchanged.
 *
 * Race safety: the pending row moves only by conditional updates —
 *   pending ─(answer being sent)→ merging ─(sent)→ consumed
 *        │                           └─(send failed)→ pending
 *        └─(node woke)→ released
 * so exactly one of "the answer carries the ack" / "the node sends the ack"
 * happens. A node that wakes while the answer is mid-send waits a minute and
 * looks again; a merging row older than MERGING_STALE_MS is treated as a
 * failed send and released - but first (audit nice-to-have 5) the thread is
 * read for the answering run's send key: an answer that went out whose
 * "merged" mark was lost (the confirm retried and still failed) consumes the
 * ack instead of sending it a second time. The run that took the ack is kept
 * on the row (consumed_run_id) from the moment it is taken.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const ACK_MERGE_DEFAULT_WAIT_MINUTES = 5;
export const ACK_MERGE_MAX_WAIT_MINUTES = 15;
export const MERGING_STALE_MS = 10 * 60 * 1000;
export const MERGE_RECHECK_MINUTES = 1;
export const MAX_MERGE_RECHECKS = 12;
/** confirmMerged retries (ms before each retry). */
export const CONFIRM_RETRY_MS = Object.freeze([250, 1000]);
const MAX_ACK_CHARS = 700;

/** Node option → { enabled, waitMinutes } (1..15, default 5). */
export function normalizeMergeOption(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const n = Math.round(Number(o.waitMinutes));
  const waitMinutes = Number.isFinite(n) && n >= 1 ? Math.min(n, ACK_MERGE_MAX_WAIT_MINUTES) : ACK_MERGE_DEFAULT_WAIT_MINUTES;
  return { enabled: o.enabled === true, waitMinutes };
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The ack as a short plain text (from the rendered e-mail), kept small. */
export function ackTextFrom(email = {}) {
  const raw = String(email.text || '').trim()
    || String(email.html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const text = raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > MAX_ACK_CHARS ? `${text.slice(0, MAX_ACK_CHARS - 1)}…` : text;
}

/** The answer mail with the ack paragraph on top (html + text). */
export function mergeAckIntoMail(mail, ackText) {
  const text = String(ackText || '').trim();
  if (!text) return mail;
  const paragraphs = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return {
    ...mail,
    html: `${paragraphs}${mail.html || ''}`,
    text: [text, mail.text].filter(Boolean).join('\n\n'),
    ackMerged: true,
  };
}

class AutoHelpAckMergeService {
  /** The node decided to wait: leave the ack for the answer to pick up. */
  async hold({ workspaceId, ticketId, workflowRunId = null, nodeId = null, ackText, waitMinutes, now = new Date() }) {
    const minutes = normalizeMergeOption({ enabled: true, waitMinutes }).waitMinutes;
    return prisma.autoHelpPendingAck.create({
      data: {
        workspaceId: Number(workspaceId),
        ticketId: Number(ticketId),
        workflowRunId: workflowRunId ? Number(workflowRunId) : null,
        nodeId: nodeId ? String(nodeId).slice(0, 120) : null,
        ackText: String(ackText || '').slice(0, 4000),
        status: 'pending',
        expiresAt: new Date(now.getTime() + minutes * 60e3),
      },
    });
  }

  /**
   * The node woke. Returns { send: true } (it sends the ack itself),
   * { send: false, merged: true, runId } (the answer carried it), or
   * { wait: true } (the answer is being sent right now — look again shortly).
   */
  async settle(pendingAckId, { now = new Date() } = {}) {
    const id = Number(pendingAckId);
    if (!id) return { send: true, reason: 'no_pending_ack' };
    const released = await prisma.autoHelpPendingAck.updateMany({ where: { id, status: 'pending' }, data: { status: 'released' } });
    if (released?.count) return { send: true, reason: 'window_passed' };
    const row = await prisma.autoHelpPendingAck.findFirst({ where: { id } }).catch(() => null);
    if (!row) return { send: true, reason: 'no_pending_ack' };
    if (row.status === 'consumed') return { send: false, merged: true, runId: row.consumedRunId ?? null };
    if (row.status === 'merging') {
      // The answer may have gone out with the ack on top and only the
      // "merged" mark failed: the thread carries the run's send key.
      if (row.consumedRunId && await this._answerDelivered(row.ticketId, row.consumedRunId)) {
        await Promise.resolve().then(() => prisma.autoHelpPendingAck.updateMany({ where: { id, status: 'merging' }, data: { status: 'consumed' } })).catch(() => null);
        logger.warn(`Auto-help ack ${id}: the answer (run ${row.consumedRunId}) is on the thread — marked merged, the ack is not sent again`);
        return { send: false, merged: true, runId: row.consumedRunId, recovered: true };
      }
      const age = now.getTime() - new Date(row.updatedAt || row.createdAt).getTime();
      if (age < MERGING_STALE_MS) return { wait: true };
      const forced = await prisma.autoHelpPendingAck.updateMany({ where: { id, status: 'merging' }, data: { status: 'released' } });
      if (forced?.count) {
        logger.warn(`Auto-help ack ${id}: the answer never finished sending — the ack goes on its own`);
        return { send: true, reason: 'merge_stale' };
      }
      return this.settle(id, { now });
    }
    return { send: true, reason: row.status };
  }

  /**
   * An Auto-help answer is about to go out: take the ticket's pending ack (one,
   * inside its window) for the answer. Returns { id, ackText } or null.
   */
  async takeForAnswer(ticketId, { now = new Date(), runId = null } = {}) {
    const rows = await Promise.resolve()
      .then(() => prisma.autoHelpPendingAck.findMany({
        where: { ticketId: Number(ticketId), status: 'pending', expiresAt: { gt: now } },
        orderBy: { createdAt: 'asc' },
        take: 3,
      }))
      .catch(() => []);
    for (const row of rows || []) {
      const res = await Promise.resolve()
        .then(() => prisma.autoHelpPendingAck.updateMany({
          where: { id: row.id, status: 'pending', expiresAt: { gt: now } },
          data: { status: 'merging', consumedRunId: runId ? Number(runId) : null },
        }))
        .catch(() => ({ count: 0 }));
      if (res?.count) return { id: row.id, ackText: row.ackText };
    }
    return null;
  }

  /**
   * The answer (with the ack on top) went out. Retried (audit nice-to-have
   * 5): a lost mark would let the waking node send the ack a second time -
   * settle() also reads the thread before it does.
   */
  async confirmMerged(pendingAckId, runId = null, { retryDelaysMs = CONFIRM_RETRY_MS } = {}) {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        await prisma.autoHelpPendingAck.updateMany({ where: { id: Number(pendingAckId), status: 'merging' }, data: { status: 'consumed', consumedRunId: runId ? Number(runId) : null } });
        return true;
      } catch (err) {
        if (attempt === retryDelaysMs.length) {
          logger.warn(`Auto-help ack ${pendingAckId} not marked merged after ${attempt + 1} tries: ${err.message} — the waking node reads the thread first`);
          return false;
        }
        await new Promise((r) => { const t = setTimeout(r, retryDelaysMs[attempt]); t.unref?.(); });
      }
    }
    return false;
  }

  /** Did this run's answer reach the requester? (its send key on the thread, with proof of delivery) */
  async _answerDelivered(ticketId, runId) {
    try {
      const { answerKey, findKeyedEntry } = await import('./autoHelpDeliveryService.js');
      const run = await Promise.resolve().then(() => prisma.autoHelpRun.findFirst({ where: { id: Number(runId) }, select: { outcomeDetail: true } })).catch(() => null);
      const failed = Array.isArray(run?.outcomeDetail?.failedSends) ? run.outcomeDetail.failedSends.map(Number).filter(Number.isFinite) : [];
      return Boolean(await findKeyedEntry(ticketId, answerKey(runId), failed));
    } catch (err) {
      logger.warn(`Auto-help ack: could not read the thread for run ${runId} (${err.message})`);
      return false;
    }
  }

  /** The answer did not go out: the ack is the node's again. */
  async giveBack(pendingAckId) {
    await Promise.resolve()
      .then(() => prisma.autoHelpPendingAck.updateMany({ where: { id: Number(pendingAckId), status: 'merging' }, data: { status: 'pending', consumedRunId: null } }))
      .catch((err) => logger.warn(`Auto-help ack ${pendingAckId} not given back: ${err.message}`));
  }
}

const autoHelpAckMergeService = new AutoHelpAckMergeService();
export default autoHelpAckMergeService;
export { AutoHelpAckMergeService };
