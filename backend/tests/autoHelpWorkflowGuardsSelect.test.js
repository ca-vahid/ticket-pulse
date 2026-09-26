import { describe, expect, test } from '@jest/globals';
import {
  selectGuardTargets, guardMatchFor, installedTemplateKeyBase, isInstalledTemplateKey, nextVersionNumber,
  GUARD_EXCLUDED_WORKSPACES, GUARD_TEMPLATES,
} from '../src/services/autoHelpWorkflowGuards.js';
import { WORKFLOW_TEMPLATES } from '../src/services/notificationWorkflowDefinition.js';

/**
 * Audit S3 (26 Sep 2026): which workflows scripts/auto-help-workflow-guards.mjs
 * may change. Pure selection — sandboxes never, Auto-help-off workspaces only
 * when named, heuristic (name / step id) matches only with --include.
 */
const NUDGE_KEY = 'ticket_public_reply_added_follow_up_nudge_24h_after_agent_repl';
const SUMMARY_KEY = 'ticket_resolved_closed_resolution_summary_auto_send_at_high';
const wf = (over) => ({
  id: 1, workspaceId: 1, key: 'custom', name: 'Custom', triggerType: 'ticket.public_reply_added', publishedDefinition: null, draftDefinition: null, ...over,
});
const stillOpenDef = { nodes: [{ id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.public_reply_added' } }, { id: 'still-open', type: 'condition' }], edges: [] };

describe('template keys', () => {
  test('the install key mirrors notificationWorkflowRepository (slug cut at 36; prod/dev key for the summary template)', () => {
    expect(installedTemplateKeyBase(GUARD_TEMPLATES.follow_up_nudge.triggerType, GUARD_TEMPLATES.follow_up_nudge.name)).toBe(NUDGE_KEY);
    expect(installedTemplateKeyBase(GUARD_TEMPLATES.resolution_summary.triggerType, GUARD_TEMPLATES.resolution_summary.name)).toBe(SUMMARY_KEY);
  });

  test('the template names still exist in the gallery (a rename would silently stop matching)', () => {
    const byKey = Object.fromEntries(WORKFLOW_TEMPLATES.map((t) => [t.key, t]));
    expect(byKey.follow_up_nudge).toMatchObject(GUARD_TEMPLATES.follow_up_nudge);
    expect(byKey.resolution_summary_autosend).toMatchObject(GUARD_TEMPLATES.resolution_summary);
  });

  test('a second install (<base>_1) matches; a look-alike key does not', () => {
    expect(isInstalledTemplateKey(`${NUDGE_KEY.slice(0, 70)}_1`, GUARD_TEMPLATES.follow_up_nudge)).toBe(true);
    expect(isInstalledTemplateKey(NUDGE_KEY, GUARD_TEMPLATES.follow_up_nudge)).toBe(true);
    expect(isInstalledTemplateKey('ticket_public_reply_added_follow_up_nudge_custom', GUARD_TEMPLATES.follow_up_nudge)).toBe(false);
  });
});

describe('guardMatchFor says how it matched', () => {
  test('template key vs heuristic', () => {
    expect(guardMatchFor(wf({ key: NUDGE_KEY }))).toMatchObject({ kind: 'follow_up_nudge', by: 'template_key' });
    expect(guardMatchFor(wf({ name: 'Follow-up nudge for VIPs' }))).toMatchObject({ kind: 'follow_up_nudge', by: 'heuristic', why: 'name starts with "Follow-up nudge"' });
    expect(guardMatchFor(wf({ name: 'Chase', publishedDefinition: stillOpenDef }))).toMatchObject({ kind: 'follow_up_nudge', by: 'heuristic', why: 'has a "still-open" step' });
    expect(guardMatchFor(wf({ key: 'ticket_reply_received_reopen', triggerType: 'ticket.reply_received' }))).toMatchObject({ kind: 'reopen_on_reply', by: 'template_key' });
    expect(guardMatchFor(wf({ key: SUMMARY_KEY, triggerType: 'ticket.resolved_closed' }))).toMatchObject({ kind: 'resolution_summary', by: 'template_key' });
    expect(guardMatchFor(wf({ name: 'Something else' }))).toBeNull();
  });
});

describe('selectGuardTargets', () => {
  const list = [
    wf({ id: 10, workspaceId: 1, key: NUDGE_KEY }),
    wf({ id: 11, workspaceId: 1, name: 'Follow-up nudge (my team)' }),
    wf({ id: 12, workspaceId: 2, key: 'ticket_reply_received_reopen', triggerType: 'ticket.reply_received' }),
    wf({ id: 13, workspaceId: 7, key: NUDGE_KEY }),
    wf({ id: 14, workspaceId: 9, key: 'ticket_reply_received_reopen', triggerType: 'ticket.reply_received' }),
    wf({ id: 15, workspaceId: 1, name: 'Unrelated' }),
  ];
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.workflow.id, r]));

  test('default: only workspaces with Auto-help on; heuristic matches listed but not selected; sandboxes never', () => {
    const rows = byId(selectGuardTargets(list, { enabledWorkspaceIds: [1, 7, 9] }));
    expect(rows[10]).toMatchObject({ selected: true, by: 'template_key' });
    expect(rows[11]).toMatchObject({ selected: false, by: 'heuristic' });
    expect(rows[11].skip).toContain('--include 11');
    expect(rows[12]).toMatchObject({ selected: false });
    expect(rows[12].skip).toContain('Auto-help is off in workspace 2');
    expect(rows[13].selected).toBe(false);
    expect(rows[13].skip).toContain('sandbox');
    expect(rows[14].selected).toBe(false);
    expect(rows[15]).toBeUndefined(); // no guard at all: not listed
  });

  test('--include selects a heuristic match; --workspace N takes a workspace with Auto-help off, never a sandbox', () => {
    expect(byId(selectGuardTargets(list, { enabledWorkspaceIds: [1], include: [11] }))[11].selected).toBe(true);
    const ws2 = byId(selectGuardTargets(list, { enabledWorkspaceIds: [], onlyWorkspace: 2 }));
    expect(ws2[12].selected).toBe(true);
    expect(ws2[10].selected).toBe(false);
    const ws7 = byId(selectGuardTargets(list, { enabledWorkspaceIds: [], onlyWorkspace: 7, include: [13] }));
    expect(ws7[13].selected).toBe(false);
    expect(GUARD_EXCLUDED_WORKSPACES).toEqual([6, 7, 8, 9]);
  });
});

describe('nextVersionNumber', () => {
  test('one past the highest stored version, even when publishedVersion lags behind', () => {
    expect(nextVersionNumber([1, 2, 5], 3)).toBe(6);
    expect(nextVersionNumber([], 0)).toBe(1);
    expect(nextVersionNumber([], 4)).toBe(5);
  });
});
