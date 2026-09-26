/**
 * Seeded-template guards for workflows installed BEFORE the Auto-help
 * integration (W3, plans/AUTO_HELP_INTEGRATION_PLAN.md D). Pure transforms of
 * a workflow definition; backend/scripts/auto-help-workflow-guards.mjs applies
 * them (dry-run by default) to published + draft definitions.
 *
 *   follow_up_nudge      condition 'still-open' gains ticket.parkKind is_not
 *                        auto_help (Auto-help checks in itself while it waits)
 *                        and ticket.resolvedByKind is_not auto_help
 *   resolution_summary   a 'not-auto-help-close' condition after the trigger:
 *                        resolvedByKind is_not auto_help → carry on, else stop
 *   reopen_on_reply      the seeded 'is-resolved' rule also requires the reply
 *                        after an Auto-help close NOT to read as thanks / an
 *                        out-of-office (event.extra.autoHelpReplyVerdict)
 *
 * Every transform is idempotent and returns { changed, definition, why }.
 */
import {
  AUTO_HELP_CLOSE_GUARD_NODE, AUTO_HELP_NUDGE_CLOSED_GUARD_ROW, AUTO_HELP_NUDGE_GUARD_ROW, AUTO_HELP_REOPEN_GUARD_RULE,
} from './notificationWorkflowDefinition.js';

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

function triggerOf(definition) {
  return (definition?.nodes || []).find((n) => n?.type === 'trigger') || null;
}

/** Which guard (if any) a workflow needs, from its key / name / shape. */
export function guardKindFor(workflow, definition) {
  return guardMatchFor(workflow, definition)?.kind || null;
}

/**
 * Sandbox / integration workspaces the one-off never touches (audit S3):
 * 6, 7 (Simorgh sandbox), 8, 9 (Sentinel sandbox).
 */
export const GUARD_EXCLUDED_WORKSPACES = Object.freeze([6, 7, 8, 9]);

/** The gallery templates the guards were written for (installed copies get a key from trigger + name). */
export const GUARD_TEMPLATES = Object.freeze({
  follow_up_nudge: { triggerType: 'ticket.public_reply_added', name: 'Follow-up nudge (24h after agent reply)' },
  resolution_summary: { triggerType: 'ticket.resolved_closed', name: 'Resolution summary (auto-send at high confidence)' },
});
/** The seeded (not installed) reopen workflow's fixed key. */
export const REOPEN_SEEDED_KEY = 'ticket_reply_received_reopen';

function slugPart(value) {
  return String(value || '').trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36) || 'custom';
}

/** The key an installed template gets on its first install (mirrors notificationWorkflowRepository.uniqueWorkflowKey). */
export function installedTemplateKeyBase(triggerType, name) {
  return `${String(triggerType).replace('ticket.', 'ticket_').replace(/\./g, '_')}_${slugPart(name)}`.slice(0, 72);
}

/** Does `key` equal the template's install key, or one of its de-duplicated variants (`<base>_<n>`)? */
export function isInstalledTemplateKey(key, template) {
  if (!key || !template) return false;
  const base = installedTemplateKeyBase(template.triggerType, template.name);
  if (key === base) return true;
  const m = /^(.*)_(\d{1,2})$/.exec(String(key));
  if (!m) return false;
  return m[1] === base.slice(0, 72 - m[2].length - 1);
}

/**
 * { kind, by: 'template_key' | 'heuristic', why } or null. A template-key
 * match is the gallery template / seeded workflow itself; a heuristic match
 * (name or node ids) may be somebody's own workflow and needs --include.
 */
export function guardMatchFor(workflow, definition) {
  const def = definition || workflow?.publishedDefinition || workflow?.draftDefinition;
  const trigger = triggerOf(def)?.data?.triggerType || workflow?.triggerType;
  const name = String(workflow?.name || '');
  const key = String(workflow?.key || '');
  const ids = new Set((def?.nodes || []).map((n) => n?.id));
  if (trigger === 'ticket.reply_received' && key === REOPEN_SEEDED_KEY) {
    return { kind: 'reopen_on_reply', by: 'template_key', why: `seeded key ${REOPEN_SEEDED_KEY}` };
  }
  if (trigger === 'ticket.public_reply_added') {
    if (isInstalledTemplateKey(key, GUARD_TEMPLATES.follow_up_nudge)) return { kind: 'follow_up_nudge', by: 'template_key', why: `template key ${key}` };
    if (name.startsWith('Follow-up nudge')) return { kind: 'follow_up_nudge', by: 'heuristic', why: 'name starts with "Follow-up nudge"' };
    if (ids.has('still-open')) return { kind: 'follow_up_nudge', by: 'heuristic', why: 'has a "still-open" step' };
  }
  if (trigger === 'ticket.resolved_closed') {
    if (isInstalledTemplateKey(key, GUARD_TEMPLATES.resolution_summary)) return { kind: 'resolution_summary', by: 'template_key', why: `template key ${key}` };
    if (name.startsWith('Resolution summary')) return { kind: 'resolution_summary', by: 'heuristic', why: 'name starts with "Resolution summary"' };
    if (ids.has('summary') && ids.has('send')) return { kind: 'resolution_summary', by: 'heuristic', why: 'has "summary" and "send" steps' };
  }
  return null;
}

/**
 * Which workflows the guard script may change (audit S3). Pure.
 *   - workspaces 6, 7, 8, 9 are never touched;
 *   - by default only workspaces with Auto-help enabled; --workspace N picks
 *     one workspace explicitly (still never a sandbox);
 *   - a template-key match is selected; a heuristic match only when its id is
 *     in `include` (--include 12,34) — it may be a custom workflow.
 * Returns one row per workflow that matched a guard, with `selected` and
 * `skip` (why not) so the script can print every match and the reason.
 */
export function selectGuardTargets(workflows, { enabledWorkspaceIds = [], onlyWorkspace = null, include = [] } = {}) {
  const enabled = new Set((enabledWorkspaceIds || []).map(Number));
  const included = new Set((include || []).map(Number));
  const only = onlyWorkspace === null || onlyWorkspace === undefined || onlyWorkspace === '' ? null : Number(onlyWorkspace);
  const rows = [];
  for (const wf of workflows || []) {
    const match = guardMatchFor(wf);
    if (!match) continue;
    const ws = Number(wf.workspaceId);
    let skip = null;
    if (GUARD_EXCLUDED_WORKSPACES.includes(ws)) skip = `workspace ${ws} is a sandbox (never touched)`;
    else if (only !== null && ws !== only) skip = `not workspace ${only}`;
    else if (only === null && !enabled.has(ws)) skip = `Auto-help is off in workspace ${ws} (pass --workspace ${ws} to include it)`;
    else if (match.by !== 'template_key' && !included.has(Number(wf.id))) skip = `matched by ${match.why} only - could be a custom workflow; pass --include ${wf.id} to change it`;
    rows.push({ workflow: wf, kind: match.kind, by: match.by, why: match.why, selected: !skip, skip });
  }
  return rows;
}

/** The next version number: one past the highest stored version (never publishedVersion + 1, which can collide). */
export function nextVersionNumber(versionNumbers = [], publishedVersion = 0) {
  const max = Math.max(0, Number(publishedVersion) || 0, ...(versionNumbers || []).map((v) => Number(v) || 0));
  return max + 1;
}

export function addNudgeGuard(definition) {
  const def = clone(definition);
  const node = (def?.nodes || []).find((n) => n?.id === 'still-open' && n?.type === 'condition');
  if (!node) return { changed: false, definition, why: 'no still-open condition' };
  const group = node.data?.conditionGroup;
  if (!group || !Array.isArray(group.conditions)) return { changed: false, definition, why: 'condition is not a condition group' };
  if (group.logic !== 'all') return { changed: false, definition, why: 'condition group is not ALL — left for a person' };
  const has = (row) => group.conditions.some((c) => c?.field === row.field && c?.operator === row.operator && c?.value === row.value);
  const missing = [AUTO_HELP_NUDGE_GUARD_ROW, AUTO_HELP_NUDGE_CLOSED_GUARD_ROW].filter((row) => !has(row));
  if (!missing.length) return { changed: false, definition, why: 'already guarded' };
  if (group.conditions.length + missing.length > 20) return { changed: false, definition, why: 'too many conditions to add the guard' };
  for (const row of missing) group.conditions.push({ ...row });
  return { changed: true, definition: def, why: `added ${missing.map((r) => `${r.field} is_not auto_help`).join(' + ')}` };
}

export function addResolutionSummaryGuard(definition) {
  const def = clone(definition);
  if (!def?.nodes || !Array.isArray(def.edges)) return { changed: false, definition, why: 'no graph' };
  if (def.nodes.some((n) => n?.id === AUTO_HELP_CLOSE_GUARD_NODE.id)) return { changed: false, definition, why: 'already guarded' };
  const trigger = triggerOf(def);
  const out = def.edges.filter((e) => e.source === trigger?.id);
  if (!trigger || out.length !== 1) return { changed: false, definition, why: 'trigger does not lead to exactly one step — left for a person' };
  if (def.nodes.length + 2 > 30) return { changed: false, definition, why: 'too many steps to add the guard' };
  const firstTarget = out[0].target;
  const guard = clone(AUTO_HELP_CLOSE_GUARD_NODE);
  guard.position = { x: (trigger.position?.x ?? 80) + 120, y: (trigger.position?.y ?? 80) + 140 };
  const stop = { id: 'skip-auto-help', type: 'stop', data: { reason: 'Auto-help closed this ticket' }, position: { x: guard.position.x + 240, y: guard.position.y + 120 } };
  def.nodes.push(guard, stop);
  out[0].target = guard.id;
  def.edges.push(
    { id: 'e-auto-help-guard-true', source: guard.id, sourceHandle: 'true', target: firstTarget },
    { id: 'e-auto-help-guard-false', source: guard.id, sourceHandle: 'false', target: stop.id },
  );
  return { changed: true, definition: def, why: 'added the not-closed-by-Auto-help condition after the trigger' };
}

export function addReopenGuard(definition) {
  const def = clone(definition);
  const node = (def?.nodes || []).find((n) => n?.id === 'is-resolved' && n?.type === 'condition');
  if (!node) return { changed: false, definition, why: 'no is-resolved condition' };
  const text = JSON.stringify(node.data || {});
  if (text.includes('autoHelpReplyVerdict')) return { changed: false, definition, why: 'already guarded' };
  if (node.data?.conditionGroup) {
    const g = node.data.conditionGroup;
    if (g.logic !== 'all' || !Array.isArray(g.conditions)) return { changed: false, definition, why: 'condition group is not ALL — left for a person' };
    g.conditions.push({ field: 'event.autoHelpReplyVerdict', operator: 'not_in', value: ['confirmed', 'auto_reply'] });
    return { changed: true, definition: def, why: 'added the reply-verdict row' };
  }
  if (!node.data?.rule) return { changed: false, definition, why: 'no rule to extend' };
  node.data.rule = { and: [node.data.rule, clone(AUTO_HELP_REOPEN_GUARD_RULE)] };
  return { changed: true, definition: def, why: 'wrapped the rule with the reply-verdict guard' };
}

export function applyGuard(kind, definition) {
  if (!definition) return { changed: false, definition, why: 'no definition' };
  if (kind === 'follow_up_nudge') return addNudgeGuard(definition);
  if (kind === 'resolution_summary') return addResolutionSummaryGuard(definition);
  if (kind === 'reopen_on_reply') return addReopenGuard(definition);
  return { changed: false, definition, why: 'no guard for this workflow' };
}

export default {
  guardKindFor, guardMatchFor, selectGuardTargets, nextVersionNumber, applyGuard, addNudgeGuard, addResolutionSummaryGuard, addReopenGuard,
};
