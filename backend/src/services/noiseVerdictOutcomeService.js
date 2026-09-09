import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * What actually happened after each noise verdict (QA 09-05, Accounting
 * option 4).
 *
 * The Accounting problem was argued from an inference: "a person worked it
 * anyway, so the verdict was wrong". That inference was strong enough to act
 * on but nobody could SEE it — there was no surface showing that 718 of 1,295
 * verdicts had been overridden. This service turns the inference into a
 * measurement, per workspace, so the prompt and routing changes shipping
 * alongside it can be judged against a baseline instead of a feeling.
 *
 * Deliberately computed on read from rows we already write (pipeline runs +
 * current ticket state). No new pipeline writes, no backfill, nothing to keep
 * in sync — the cost is one query per panel load, on a surface an admin opens
 * occasionally.
 *
 * Honest about its limits: these are still PROXIES for "wrong", not confirmed
 * errors. A ticket can be assigned for reasons unrelated to the verdict. The
 * panel says so, and the QA report asks Accounting for ten confirmed examples
 * to calibrate against.
 */

const DEFAULT_DAYS = 180;
const MAX_DAYS = 730;
const SAMPLE_LIMIT = 25;

function clampDays(days) {
  const n = Number.parseInt(days, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

function num(value) {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : Number(value) || 0;
}

class NoiseVerdictOutcomeService {
  /**
   * Per-workspace accuracy for AI noise verdicts.
   *
   * "Overridden" counts only signals that mean a PERSON took the ticket on:
   *   - assigned     — the ticket now has an assignee  (strong)
   *   - agentReplied — an agent wrote a public reply after the verdict (strong)
   *   - noiseCleared — the isNoise flag came back off   (strong, but ONLY
   *                    where the workspace auto-closes noise)
   *
   * That last caveat is load-bearing. The noise flag is only written when
   * assignmentConfig.autoCloseNoise is on, so in Accounting (where it is off)
   * 1,324 of 1,535 dismissed tickets have isNoise = false simply because
   * nothing ever set it. Counting that as "a human cleared the flag" scored
   * Accounting at 3.8% accuracy on the first run of this query — a number
   * that would have gone in front of the Accounting team and been wrong.
   * Where auto-close is off the signal is dropped, and the honest figure
   * (~45%) then agrees with the independent 718-of-1,295 estimate in the
   * Sep 5 report.
   *
   * `stillOpen` is reported for context but NEVER counted: where nothing
   * auto-closes, "still open" is the resting state of an untouched ticket,
   * not evidence anybody looked at it.
   */
  async accuracy(workspaceId, { days = DEFAULT_DAYS } = {}) {
    const wsId = Number.parseInt(workspaceId, 10);
    if (!Number.isFinite(wsId) || wsId <= 0) return null;
    const window = clampDays(days);

    try {
      const config = await prisma.assignmentConfig.findUnique({
        where: { workspaceId: wsId },
        select: { autoCloseNoise: true },
      }).catch(() => null);
      const flagIsAuthoritative = config?.autoCloseNoise === true;
      const rows = await prisma.$queryRawUnsafe(`
        WITH verdicts AS (
          SELECT r.id AS run_id, r.ticket_id, r.created_at AS decided_at,
                 r.llm_model,
                 r.decision, r.non_actionable,
                 t.assigned_tech_id, t.is_noise, t.status, t.subject,
                 t.native_number, t.freshservice_ticket_id, t.origin
          FROM assignment_pipeline_runs r
          JOIN tickets t ON t.id = r.ticket_id
          WHERE r.workspace_id = ${wsId}
            -- A "verdict" is the AI judging the ticket non-actionable, in
            -- EITHER form: the classic empty-recommendations dismissal, or the
            -- decoupled label that replaced it where auto-close is off
            -- (QA 09-05 option 3). Counting only the first would make this
            -- panel read as "the AI stopped judging" the day option 3 shipped.
            AND (r.decision = 'noise_dismissed' OR r.non_actionable = true)
            AND r.created_at > now() - interval '${window} days'
        ), scored AS (
          SELECT v.*,
                 (v.assigned_tech_id IS NOT NULL) AS assigned,
                 (v.is_noise IS NOT TRUE) AS noise_cleared,
                 (v.status NOT IN ('Resolved', 'Closed')) AS still_open,
                 EXISTS (
                   SELECT 1 FROM ticket_thread_entries e
                   WHERE e.ticket_id = v.ticket_id
                     AND e.occurred_at > v.decided_at
                     AND e.author_type = 'agent'
                     AND COALESCE(e.is_private, false) = false
                 ) AS agent_replied
          FROM verdicts v
        )
        SELECT
          count(*)::text AS total,
          count(*) FILTER (WHERE llm_model = 'noise-rule')::text AS by_rule,
          count(*) FILTER (WHERE llm_model IS DISTINCT FROM 'noise-rule')::text AS by_ai,
          count(*) FILTER (WHERE decision = 'noise_dismissed')::text AS as_dismissal,
          count(*) FILTER (WHERE non_actionable AND decision IS DISTINCT FROM 'noise_dismissed')::text AS as_label,
          count(*) FILTER (WHERE assigned)::text AS assigned,
          count(*) FILTER (WHERE noise_cleared)::text AS noise_cleared,
          count(*) FILTER (WHERE agent_replied)::text AS agent_replied,
          count(*) FILTER (WHERE still_open)::text AS still_open,
          count(*) FILTER (WHERE assigned OR agent_replied${flagIsAuthoritative ? ' OR noise_cleared' : ''})::text AS overridden
        FROM scored
      `);

      const r = rows?.[0] || {};
      const total = num(r.total);
      const overridden = num(r.overridden);

      const samples = total > 0 ? await this._samples(wsId, window) : [];

      return {
        workspaceId: wsId,
        days: window,
        total,
        byAi: num(r.by_ai),
        byRule: num(r.by_rule),
        // How the verdict was expressed: a dismissal (auto-close path) or a
        // label alongside a real recommendation (QA 09-05 option 3).
        asDismissal: num(r.as_dismissal),
        asLabel: num(r.as_label),
        overridden,
        upheld: Math.max(0, total - overridden),
        // Null rather than 100% when there is nothing to judge — an empty
        // workspace must not read as a perfect score.
        accuracy: total > 0 ? Math.round(((total - overridden) / total) * 1000) / 10 : null,
        // autoCloseNoise decides whether the isNoise flag means anything here,
        // so the UI can label the excluded signal instead of hiding it.
        autoCloseNoise: flagIsAuthoritative,
        signals: {
          assigned: { count: num(r.assigned), counted: true },
          agentReplied: { count: num(r.agent_replied), counted: true },
          noiseCleared: { count: num(r.noise_cleared), counted: flagIsAuthoritative },
          stillOpen: { count: num(r.still_open), counted: false },
        },
        samples,
      };
    } catch (err) {
      logger.warn(`Noise verdict accuracy failed for ws ${wsId}: ${err.message}`);
      return null;
    }
  }

  /** A few overridden tickets, newest first, so an admin can spot-check. */
  async _samples(wsId, window) {
    // Same override definition as accuracy(): a person owns it or answered it.
    try {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT r.created_at AS decided_at, t.id::text AS ticket_id, t.subject,
               t.status, t.origin, t.native_number, t.freshservice_ticket_id::text AS fs_id,
               (t.assigned_tech_id IS NOT NULL) AS assigned,
               (t.is_noise IS NOT TRUE) AS noise_cleared,
               tech.name AS assignee_name
        FROM assignment_pipeline_runs r
        JOIN tickets t ON t.id = r.ticket_id
        LEFT JOIN technicians tech ON tech.id = t.assigned_tech_id
        WHERE r.workspace_id = ${wsId}
          AND (r.decision = 'noise_dismissed' OR r.non_actionable = true)
          AND r.created_at > now() - interval '${window} days'
          AND (t.assigned_tech_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM ticket_thread_entries e
                WHERE e.ticket_id = t.id AND e.occurred_at > r.created_at
                  AND e.author_type = 'agent' AND COALESCE(e.is_private, false) = false))
        ORDER BY r.created_at DESC
        LIMIT ${SAMPLE_LIMIT}
      `);
      return (rows || []).map((row) => ({
        ticketId: num(row.ticket_id),
        ref: row.origin === 'ticketpulse' && row.native_number
          ? `TP-${row.native_number}`
          : `#${row.fs_id || row.ticket_id}`,
        subject: row.subject || '(no subject)',
        status: row.status,
        decidedAt: row.decided_at,
        assignedTo: row.assignee_name || null,
        noiseCleared: row.noise_cleared === true,
      }));
    } catch (err) {
      logger.debug(`Noise verdict samples failed: ${err.message}`);
      return [];
    }
  }
}

export default new NoiseVerdictOutcomeService();
