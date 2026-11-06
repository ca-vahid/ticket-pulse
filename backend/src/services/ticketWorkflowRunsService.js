/**
 * Workflow runs on one ticket, for the ticket page's Activity tab (QA 11-05
 * item 9). A Ticket Pulse workflow that only sent an e-mail, or that stopped
 * on a condition, left no trace on the ticket: its runs live in
 * notification_workflow_runs, never in the audit trail. This reads the newest
 * runs for a ticket and boils each one down to a short, safe summary — what
 * it did (e-mailed N people, set the status, added a note), whether it was
 * Shadow, why it stopped — and nothing else.
 *
 * Never reads e-mail bodies: the step outputs hold the rendered HTML, the
 * text body and the AI transcript, so the steps are read with a raw query
 * that pulls only the few small keys the summary needs.
 *
 * Internal ticket page only (GET /api/tickets/:id). The public v1 shape never
 * carries it — it is attached in the route, not in ticketService.getTicket.
 */
import prisma from './prisma.js';

const SHADOW_MODES = new Set(['mock', 'preview']);
const ACTION_TYPES = new Set(['send_email', 'update_ticket', 'add_note', 'park_ticket', 'call_webhook', 'send_teams_message', 'create_child_ticket', 'request_approval', 'propose_reply']);
const clip = (s, n = 300) => (s === null || s === undefined ? null : String(s).slice(0, n));
const truthy = (v) => v === true || v === 'true';
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** One step row (raw query shape) → the action it took, or null. */
export function stepAction(step) {
  const type = step.nodeType;
  if (!ACTION_TYPES.has(type) || step.status === 'failed') return null;
  if (type === 'send_email') {
    const sent = !truthy(step.mocked) && !truthy(step.skipped);
    return { type: 'email', to: num(step.toCount) || 0, cc: num(step.ccCount) || 0, sent, reason: sent ? null : clip(step.reason, 120) };
  }
  if (type === 'update_ticket') {
    if (truthy(step.skipped)) return null;
    const updated = step.updated && typeof step.updated === 'object' ? step.updated : {};
    const fields = Object.keys(updated);
    const status = updated.status && typeof updated.status === 'object' ? { from: clip(updated.status.from, 60), to: clip(updated.status.to, 60) } : null;
    const assignedTo = truthy(step.assignmentAssigned) ? clip(step.assignmentTechName, 120) : null;
    if (!fields.length && !assignedTo) return null;
    return { type: 'update', fields, status, assignedTo };
  }
  const map = {
    add_note: 'note', park_ticket: 'park', call_webhook: 'webhook', send_teams_message: 'teams',
    create_child_ticket: 'child', request_approval: 'approval', propose_reply: 'proposed_reply',
  };
  return { type: map[type] };
}

/** One plain note for a step, for the expanded row: why a condition passed or failed, why it stopped, how long it would wait. */
function stepNote(step) {
  if (step.nodeType === 'condition') return step.summary ? `${truthy(step.passed) ? 'Passed' : 'Did not pass'}: ${clip(step.summary, 240)}` : null;
  if (step.nodeType === 'stop') return clip(step.reason, 120);
  if (step.nodeType === 'delay' && step.waitMinutes !== null && step.waitMinutes !== undefined) return `Wait ${step.waitMinutes} min`;
  if (step.nodeType === 'send_email') {
    const n = (num(step.toCount) || 0) + (num(step.ccCount) || 0);
    return `${n} ${n === 1 ? 'recipient' : 'recipients'}${truthy(step.mocked) || truthy(step.skipped) ? ` · ${clip(step.reason, 80) || 'not sent'}` : ''}`;
  }
  return null;
}

/** Run row + its step rows → the summary the Activity tab draws. Pure; tested. */
export function summarizeWorkflowRun(run, steps = []) {
  const shadow = SHADOW_MODES.has(run.executionMode) || run.dryRun === true;
  const actions = steps.map(stepAction).filter(Boolean);
  const stop = steps.find((s) => s.nodeType === 'stop');
  const failedStep = steps.find((s) => s.status === 'failed');
  let outcome;
  if (run.status === 'failed') outcome = 'failed';
  else if (run.status === 'waiting') outcome = 'waiting';
  else if (run.status === 'running') outcome = 'running';
  else if (actions.length) outcome = 'acted';
  else if (stop) outcome = 'stopped';
  else outcome = 'nothing';
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflow?.name || null,
    eventType: run.eventType || null,
    status: run.status,
    executionMode: run.executionMode || 'live',
    shadow,
    triggerSource: run.triggerSource || null,
    startedAt: run.startedAt,
    completedAt: run.completedAt || null,
    durationMs: run.durationMs ?? null,
    error: clip(run.error || failedStep?.error, 300),
    outcome,
    // A stop node is also how a workflow ends after acting ("Workflow
    // stopped"); the reason only matters when it stopped before acting.
    stopReason: stop && outcome === 'stopped' ? clip(stop.reason, 120) : null,
    // The condition that did not pass, for a stopped run's one line.
    stopCause: outcome === 'stopped' ? stepNote(steps.find((s) => s.nodeType === 'condition' && !truthy(s.passed)) || {}) : null,
    actions,
    steps: steps.map((s) => ({
      nodeId: clip(s.nodeId, 120),
      nodeType: s.nodeType,
      status: s.status,
      durationMs: s.durationMs ?? null,
      error: clip(s.error, 200),
      note: stepNote(s),
    })),
  };
}

/**
 * Newest `take` runs on the ticket, summarised. A failure (missing table, a
 * partial mock, a slow database) returns [] — it only hides the rows.
 */
export async function listTicketWorkflowRuns(ticketId, { take = 50 } = {}) {
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const runs = await Promise.resolve()
    .then(() => prisma.notificationWorkflowRun.findMany({
      where: { ticketId: id },
      orderBy: { startedAt: 'desc' },
      take,
      select: {
        id: true, workflowId: true, eventType: true, status: true, executionMode: true, dryRun: true,
        triggerSource: true, startedAt: true, completedAt: true, durationMs: true, error: true,
        workflow: { select: { name: true } },
      },
    }))
    .catch(() => []);
  if (!Array.isArray(runs) || runs.length === 0) return [];
  const runIds = runs.map((r) => r.id);
  // Only small keys out of the step output — never htmlBody/textBody/llm.
  const rows = await Promise.resolve()
    .then(() => prisma.$queryRaw`
      SELECT run_id AS "runId", node_id AS "nodeId", node_type AS "nodeType", status,
             duration_ms AS "durationMs", left(error, 300) AS error,
             output->>'reason' AS reason,
             output->>'mocked' AS mocked,
             output->>'skipped' AS skipped,
             CASE WHEN jsonb_typeof(output->'toRecipients') = 'array' THEN jsonb_array_length(output->'toRecipients') END AS "toCount",
             CASE WHEN jsonb_typeof(output->'ccRecipients') = 'array' THEN jsonb_array_length(output->'ccRecipients') END AS "ccCount",
             CASE WHEN node_type = 'update_ticket' THEN output->'updated' END AS updated,
             output->'assignment'->>'assigned' AS "assignmentAssigned",
             left(output->'assignment'->>'techName', 120) AS "assignmentTechName",
             output->>'passed' AS passed,
             left(output->'explain'->>'summary', 300) AS summary,
             output->>'wouldWaitMinutes' AS "waitMinutes"
      FROM notification_workflow_step_runs
      WHERE run_id = ANY(${runIds}::int[])
      ORDER BY run_id, id`)
    .catch(() => []);
  const byRun = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const list = byRun.get(row.runId) || [];
    if (list.length < 40) list.push(row);
    byRun.set(row.runId, list);
  }
  return runs.map((run) => summarizeWorkflowRun(run, byRun.get(run.id) || []));
}

export default { listTicketWorkflowRuns, summarizeWorkflowRun, stepAction };
