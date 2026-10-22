/**
 * Workflow watch (QA 10-05 #5) — catch a workflow that quietly stopped doing
 * its job, before a person notices.
 *
 * Two kinds of signal, both deterministic:
 *
 *  1. Definition lint (no data needed)
 *     - noise_check_replaced: a condition step whose built-in rule reads
 *       ticket.isNoise now has structured conditions that do not — the noise
 *       check is gone (the conditions replace the rule, they do not add to it).
 *     (A Stop step's fixed note is not a signal: several built-in workflows
 *     share one "Noise ticket skipped" stop for all their guards, and the run
 *     report now names the condition that really stopped the run.)
 *     - unknown_variable (QA 10-21 #10): a template prints {{ agent.name }} or
 *       another name that is not a Ticket Pulse variable, so it prints nothing.
 *
 *  2. Went quiet (run history)
 *     A live workflow that sent at least QUIET_MIN_PRIOR e-mails in the seven
 *     days before yesterday, ran at least QUIET_MIN_RUNS times in the last
 *     24 hours, and sent nothing in those 24 hours.
 *
 * Shown on the Mail Workflows list and logged hourly as one warn line per
 * workspace ("Workflow watch: …") so the production review picks it up.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ruleVarPaths } from './notificationConditionModel.js';
import { notificationVariableCatalog } from './notificationWorkflowDefinition.js';

export const QUIET_MIN_PRIOR = 7;
export const QUIET_MIN_RUNS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;
const WATCH_INTERVAL_MS = 60 * 60 * 1000;

const isGroup = (entry) => entry && typeof entry === 'object' && Array.isArray(entry.conditions);
const groupReadsNoise = (group) => isGroup(group) && group.conditions.some((entry) => (isGroup(entry) ? groupReadsNoise(entry) : entry?.field === 'ticket.isNoise'));
const ruleReadsNoise = (rule) => Boolean(rule && typeof rule === 'object') && ruleVarPaths(rule).includes('ticket.isNoise');

// Top-level names a template may print: every catalog root, plus the links and
// flags the engine adds to each run's context and Liquid's own loop object.
const CONTEXT_ROOTS = [
  'feedbackUrl', 'feedbackTheme', 'publicStatusUrl', 'raiseUrgencyUrl', 'selfEscalationUrl',
  'afterHoursEscalationUrl', 'hasRequester', 'hasAssignedAgent', 'notificationPolicy',
  'approval', 'approvals', 'actionLinks', 'links', 'llm', 'forloop',
];
let knownRoots = null;
let catalogPaths = null;
function variableCatalog() {
  if (!knownRoots) {
    let paths = [];
    try { paths = notificationVariableCatalog().map((v) => v.path); } catch { paths = []; }
    catalogPaths = paths;
    knownRoots = new Set([...paths.map((path) => path.split('.')[0]), ...CONTEXT_ROOTS]);
  }
  return { knownRoots, catalogPaths };
}

const OUTPUT_TAG_RE = /\{\{-?\s*([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g;
const LOCAL_TAG_RE = /\{%-?\s*(?:assign|capture|for|increment|decrement)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

function templateStrings(value, out = []) {
  if (typeof value === 'string') { if (value.includes('{{')) out.push(value); }
  else if (Array.isArray(value)) value.forEach((item) => templateStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => templateStrings(item, out));
  return out;
}

/** The catalog variable a mistyped one most likely meant: {{ agent.name }} → assignedAgent.name. */
export function suggestVariable(root, rest, paths = variableCatalog().catalogPaths) {
  const low = root.toLowerCase();
  const tail = rest || '';
  const sameTail = paths.filter((path) => tail && path.slice(path.indexOf('.')) === tail);
  return sameTail.find((path) => path.split('.')[0].toLowerCase().includes(low))
    || sameTail.find((path) => low.includes(path.split('.')[0].toLowerCase()))
    || null;
}

/** {{ names }} that are not Ticket Pulse variables in one node: [{ token, suggestion }]. */
export function unknownVariablesInNode(node) {
  const { knownRoots: roots } = variableCatalog();
  const texts = templateStrings(node?.data || {});
  if (!texts.length) return [];
  const locals = new Set();
  for (const text of texts) for (const m of text.matchAll(LOCAL_TAG_RE)) locals.add(m[1]);
  const seen = new Map();
  for (const text of texts) {
    for (const m of text.matchAll(OUTPUT_TAG_RE)) {
      const [, root, rest] = m;
      if (roots.has(root) || locals.has(root)) continue;
      // Liquid literals, not variables.
      if (['true', 'false', 'nil', 'null', 'empty', 'blank'].includes(root)) continue;
      const token = `${root}${rest}`;
      if (!seen.has(token)) seen.set(token, { token, suggestion: suggestVariable(root, rest) });
    }
  }
  return [...seen.values()];
}

/** Lint one workflow definition. Returns [{ code, nodeId, label, message }]. */
export function lintWorkflowDefinition(definition) {
  const out = [];
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  for (const node of nodes) {
    for (const { token, suggestion } of unknownVariablesInNode(node)) {
      const label = node.data?.label || node.id;
      out.push({
        code: 'unknown_variable',
        nodeId: node.id,
        label,
        variable: token,
        suggestion,
        message: `Step "${label}" prints {{ ${token} }}, which is not a Ticket Pulse variable, so it comes out blank.${suggestion ? ` Did you mean {{ ${suggestion} }}?` : ''}`,
      });
    }
    if (node.type !== 'condition') continue;
    const label = node.data?.label || node.id;
    // QA 10-06 #2: a step with the Skip noise tickets switch set (either way)
    // made the choice on purpose — only the old hidden-rule shape is linted.
    if (typeof node.data?.skipNoise !== 'boolean' && node.data?.conditionGroup && ruleReadsNoise(node.data?.rule) && !groupReadsNoise(node.data.conditionGroup)) {
      out.push({
        code: 'noise_check_replaced',
        nodeId: node.id,
        label,
        message: `Step "${label}" no longer skips noise tickets: its conditions replaced the built-in noise rule.`,
      });
    }
  }
  return out;
}

/** Pure: is this workflow quiet? */
export function wentQuiet({ runs24h = 0, sent24h = 0, sentPrior7d = 0 } = {}) {
  return sent24h === 0 && runs24h >= QUIET_MIN_RUNS && sentPrior7d >= QUIET_MIN_PRIOR;
}

class NotificationWorkflowWatchService {
  constructor() {
    this.cache = new Map(); // workspaceId -> { at, data }
    this.interval = null;
  }

  /** { [workflowId]: [{ code, message, … }] } for the workspace's workflows. Cached 5 min. */
  async signalsForWorkspace(workspaceId, { now = new Date(), fresh = false } = {}) {
    const ws = Number(workspaceId);
    const hit = this.cache.get(ws);
    if (!fresh && hit && now.getTime() - hit.at < CACHE_MS) return hit.data;
    const data = await this._compute(ws, now);
    this.cache.set(ws, { at: now.getTime(), data });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
    return data;
  }

  async _compute(workspaceId, now) {
    const workflows = await prisma.notificationWorkflow.findMany({
      where: { workspaceId, archivedAt: null },
      select: { id: true, name: true, isEnabled: true, mockModeEnabled: true, publishedDefinition: true, draftDefinition: true },
      take: 500,
    });
    const out = {};
    const add = (id, signal) => { (out[id] = out[id] || []).push(signal); };
    for (const w of workflows) {
      for (const finding of lintWorkflowDefinition(w.publishedDefinition || w.draftDefinition)) add(w.id, finding);
    }
    const live = workflows.filter((w) => w.isEnabled && !w.mockModeEnabled);
    if (live.length) {
      const dayAgo = new Date(now.getTime() - DAY_MS);
      const weekBefore = new Date(now.getTime() - 8 * DAY_MS);
      const ids = live.map((w) => w.id);
      const [runs, sent] = await Promise.all([
        prisma.notificationWorkflowRun.groupBy({
          by: ['workflowId'],
          where: { workspaceId, workflowId: { in: ids }, dryRun: false, executionMode: 'live', startedAt: { gte: dayAgo } },
          _count: { _all: true },
        }),
        prisma.notificationDelivery.findMany({
          where: { workspaceId, status: 'sent', createdAt: { gte: weekBefore }, workflowRun: { workflowId: { in: ids }, dryRun: false } },
          select: { createdAt: true, workflowRun: { select: { workflowId: true } } },
          orderBy: { id: 'desc' },
          take: 20000,
        }),
      ]);
      const runs24h = new Map(runs.map((r) => [r.workflowId, r._count._all]));
      const sent24h = new Map();
      const sentPrior = new Map();
      for (const d of sent) {
        const id = d.workflowRun?.workflowId;
        if (!id) continue;
        const bucket = d.createdAt >= dayAgo ? sent24h : sentPrior;
        bucket.set(id, (bucket.get(id) || 0) + 1);
      }
      for (const w of live) {
        const stats = { runs24h: runs24h.get(w.id) || 0, sent24h: sent24h.get(w.id) || 0, sentPrior7d: sentPrior.get(w.id) || 0 };
        if (wentQuiet(stats)) {
          add(w.id, {
            code: 'went_quiet',
            ...stats,
            message: `Ran ${stats.runs24h} time${stats.runs24h === 1 ? '' : 's'} in the last 24 hours and sent nothing; it sent ${stats.sentPrior7d} e-mails in the seven days before.`,
          });
        }
      }
    }
    return out;
  }

  /** One warn line per workspace with signals. Never throws. */
  async logSignals(now = new Date()) {
    try {
      const workspaces = await prisma.notificationWorkflow.groupBy({ by: ['workspaceId'], where: { archivedAt: null } });
      for (const { workspaceId } of workspaces) {
        const signals = await this.signalsForWorkspace(workspaceId, { now, fresh: true });
        const flat = Object.entries(signals).flatMap(([id, list]) => list.map((s) => `#${id} ${s.code}`));
        if (flat.length) logger.warn(`Workflow watch: workspace ${workspaceId} has ${flat.length} signal(s): ${flat.slice(0, 12).join(', ')}`);
      }
    } catch (err) {
      logger.warn(`Workflow watch could not run: ${err.message}`);
    }
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => { this.logSignals(); }, WATCH_INTERVAL_MS);
    this.interval.unref?.();
    // First pass a few minutes after boot, clear of the start-up queries.
    const first = setTimeout(() => { this.logSignals(); }, 4 * 60 * 1000);
    first.unref?.();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}

const notificationWorkflowWatchService = new NotificationWorkflowWatchService();
export default notificationWorkflowWatchService;
export { NotificationWorkflowWatchService };
