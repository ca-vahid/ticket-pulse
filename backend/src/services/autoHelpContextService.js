/**
 * What the rest of Ticket Pulse can know about Auto-help on a ticket
 * (integration W3 + W4, plans/AUTO_HELP_INTEGRATION_PLAN.md designs D + E).
 *
 *   contextFor        → workflow context `ticket.autoHelp`:
 *                       { state, expected, playbook, mode, sentAt, outcome }
 *   expectedFor       → "Auto-help will SEND an answer on its own" (the ack
 *                       merge waits only then). Needs auto mode, which this
 *                       build keeps locked, so it is false today — approve
 *                       mode never holds an ack back (an agent may take hours).
 *   pipelineContextFor → the assignment pipeline's Auto-help block and the
 *                       noise-close guard: was an answer sent, did the
 *                       requester reply to it.
 *
 * Reads only; every lookup fails soft (a missing table reads as "off").
 */
import prisma from './prisma.js';
import autoHelpPlaybookService from './autoHelpPlaybookService.js';
import { SENT_DECISIONS, PRE_SEND_OUTCOMES } from './autoHelpOutcomes.js';

export const AUTO_HELP_STATES = Object.freeze([
  'off', 'pending', 'skipped', 'no_match', 'not_answerable', 'drafted', 'staged', 'sent', 'dismissed', 'withdrawn', 'superseded', 'failed',
]);
const REAL_RUN_EXCLUDED = ['skipped', 'no_match'];

const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback);

function iso(d) {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** The run state as one word (workflow conditions match on it). */
export function stateOfRun(run) {
  if (!run) return null;
  if (run.outcome === PRE_SEND_OUTCOMES.WITHDRAWN) return 'withdrawn';
  if (run.outcome === PRE_SEND_OUTCOMES.SUPERSEDED_BY) return 'superseded';
  if (SENT_DECISIONS.includes(run.decision)) return 'sent';
  if (run.decision === 'agent_dismissed') return 'dismissed';
  if (run.status === 'staged') return 'staged';
  if (run.status === 'running') return 'pending';
  if (['drafted', 'not_answerable', 'failed', 'skipped', 'no_match'].includes(run.status)) return run.status;
  return run.status || null;
}

async function latestRealRun(ticketId) {
  return soft(() => prisma.autoHelpRun.findFirst({
    where: { ticketId: Number(ticketId), trigger: 'categorized', status: { notIn: REAL_RUN_EXCLUDED } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true, status: true, mode: true, decision: true, decidedAt: true, outcome: true, outcomeAt: true, playbookId: true,
      gateDecision: true, draftSubject: true, draftText: true, transcript: true, createdAt: true,
    },
  }));
}

async function latestSkipRow(ticketId) {
  return soft(() => prisma.autoHelpRun.findFirst({
    where: { ticketId: Number(ticketId), trigger: 'categorized', status: { in: REAL_RUN_EXCLUDED } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, gateDecision: true, createdAt: true },
  }));
}

async function pendingJob(ticketId) {
  return soft(() => prisma.autoHelpJob.findFirst({
    where: { ticketId: Number(ticketId), status: { in: ['pending', 'running'] } },
    select: { id: true, status: true },
  }));
}

/**
 * Will Auto-help send an answer on its own for this ticket? Only when auto
 * sending is allowed in this build AND the workspace has an enabled playbook
 * whose saved mode is auto AND nothing is sent / decided on the ticket yet.
 */
export async function expectedFor(ticketId, workspaceId, { settings = null, at = new Date() } = {}) {
  const s = settings || await soft(() => autoHelpPlaybookService.getSettings(workspaceId));
  if (!s?.enabled || !s.approveModeEnabled) return false;
  const byBuild = autoHelpPlaybookService.autoModeAllowed() === true && Number(await soft(() => prisma.autoHelpPlaybook.count({
    where: { workspaceId: Number(workspaceId), enabled: true, mode: 'auto', sensitive: false },
  }), 0)) > 0;
  // Approve by day, auto by night (30 Sep 2026): after hours a proven
  // approve-mode playbook may send by itself, so an ack set to merge waits.
  const bySchedule = !byBuild && await scheduleMayAnswer(workspaceId, s, at);
  if (!byBuild && !bySchedule) return false;
  const run = await latestRealRun(ticketId);
  const state = stateOfRun(run);
  return !run || state === 'pending';
}

/** Some enabled playbook of the workspace may send by itself right now under the after-hours schedule. */
async function scheduleMayAnswer(workspaceId, settings, at) {
  if (settings?.autoAfterHours !== true) return false;
  if (!(await soft(() => autoHelpPlaybookService.isAfterHours(workspaceId, { at }), false))) return false;
  const playbooks = await soft(() => prisma.autoHelpPlaybook.findMany({
    where: { workspaceId: Number(workspaceId), enabled: true, sensitive: false, mode: { in: ['approve', 'auto'] } },
    take: 50,
  }), []);
  for (const pb of playbooks || []) {
    if (await soft(() => autoHelpPlaybookService.scheduledAuto(workspaceId, pb, settings, { at }), false)) return true;
  }
  return false;
}

/** `ticket.autoHelp` for workflow conditions, templates and the variable picker. */
export async function contextFor(ticketId, workspaceId) {
  const settings = await soft(() => autoHelpPlaybookService.getSettings(workspaceId));
  if (!settings?.enabled) {
    return { state: 'off', expected: false, playbook: null, mode: null, sentAt: null, outcome: null };
  }
  const [run, job] = await Promise.all([latestRealRun(ticketId), pendingJob(ticketId)]);
  let state = stateOfRun(run);
  if (job && (!run || !['sent', 'staged'].includes(state))) state = 'pending';
  if (!state) {
    const skip = await latestSkipRow(ticketId);
    state = skip ? skip.status : 'pending';
  }
  const playbook = run?.playbookId
    ? await soft(() => prisma.autoHelpPlaybook.findFirst({ where: { id: run.playbookId, workspaceId: Number(workspaceId) }, select: { name: true } }))
    : null;
  return {
    state,
    expected: await expectedFor(ticketId, workspaceId, { settings }),
    playbook: playbook?.name || null,
    mode: run?.mode || null,
    sentAt: SENT_DECISIONS.includes(run?.decision) ? iso(run.decidedAt) : null,
    outcome: run?.outcome || null,
  };
}

/** Does a workflow definition read `ticket.autoHelp`? (The engine only looks it up then.) */
export function definitionReadsAutoHelp(definition) {
  try {
    return JSON.stringify(definition || {}).includes('autoHelp');
  } catch {
    return false;
  }
}

/**
 * The pipeline's view (W4): state, the staged / sent answer in one line, and
 * whether the requester wrote back after it was sent. null = Auto-help never
 * drafted anything here (nothing to say, nothing to guard).
 */
export async function pipelineContextFor(ticketId) {
  const run = await latestRealRun(ticketId);
  if (!run) return null;
  const state = stateOfRun(run);
  const sent = SENT_DECISIONS.includes(run.decision);
  const answer = String(run.transcript?.body?.text || run.draftText || '').replace(/\s+/g, ' ').trim();
  let requesterReplied = false;
  if (sent && run.decidedAt) {
    const n = await soft(() => prisma.ticketThreadEntry.count({
      where: {
        ticketId: Number(ticketId),
        occurredAt: { gt: new Date(run.decidedAt) },
        NOT: { isPrivate: true },
        OR: [{ eventType: 'customer_reply' }, { authorType: 'requester', eventType: 'reply' }],
      },
    }), 0);
    requesterReplied = Number(n) > 0;
  }
  return {
    runId: run.id,
    state,
    mode: run.mode || null,
    sent,
    sentAt: sent ? iso(run.decidedAt) : null,
    requesterReplied,
    outcome: run.outcome || null,
    subject: run.draftSubject || null,
    answerSummary: answer ? (answer.length > 400 ? `${answer.slice(0, 399)}…` : answer) : null,
  };
}

export default { contextFor, expectedFor, pipelineContextFor, stateOfRun, definitionReadsAutoHelp };
