import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
  RESOLUTION_REASONS, isResolutionReason, reasonLabel, requiresResolutionReason,
  validateResolution, resolvedByKindFromActor,
} from '../src/services/resolutionReasonService.js';
import { WORKFLOW_TEMPLATES } from '../src/services/notificationWorkflowDefinition.js';
import { compileConditionGroup, validateConditionGroup, registerCustomFieldConditionOps } from '../src/services/notificationConditionModel.js';
import jsonLogic from 'json-logic-js';

registerCustomFieldConditionOps(jsonLogic);

/**
 * Simorgh Release B — resolution reason (their C4, carried on D3).
 *
 * "This is the single most valuable change for us." The security agent needs
 * to reconcile what the analyst concluded against its own verdict, and a
 * free-text "closed, thanks" cannot be reconciled — one of seven words can.
 * Required only where it means something: tickets whose top-level category is
 * Security. Everyone else's resolve flow is untouched.
 */

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the vocabulary is theirs, verbatim', () => {
  test('exactly the seven reasons from the request, in their order', () => {
    expect(RESOLUTION_REASONS.map((r) => r.value)).toEqual([
      'confirmed_threat_contained', 'false_positive', 'benign_expected', 'duplicate',
      'needs_detection_tuning', 'no_action_required', 'other',
    ]);
  });

  test('every reason has a label and a one-line hint an agent can read', () => {
    for (const r of RESOLUTION_REASONS) {
      expect(r.label.length).toBeGreaterThan(3);
      expect(r.hint.length).toBeGreaterThan(8);
    }
    expect(reasonLabel('false_positive')).toBe('False positive');
    expect(reasonLabel('nope')).toBeNull();
  });
});

describe('required only on Security-category tickets', () => {
  test('matches the top-level internal category, case-insensitively', () => {
    expect(requiresResolutionReason({ internalCategory: { name: 'Security' } })).toBe(true);
    expect(requiresResolutionReason({ internalCategory: { name: 'security' } })).toBe(true);
    expect(requiresResolutionReason({ internalCategoryName: 'Security' })).toBe(true);
  });

  test('every other category, and no category, is not required', () => {
    expect(requiresResolutionReason({ internalCategory: { name: 'Software & Apps' } })).toBe(false);
    expect(requiresResolutionReason({ internalCategory: null })).toBe(false);
    expect(requiresResolutionReason({})).toBe(false);
    expect(requiresResolutionReason(null)).toBe(false);
  });
});

describe('the API problem carries the documented code', () => {
  test('resolution_reason_required survives the problem+json mapping (their finding, 14 Sep)', async () => {
    const { toProblem } = await import('../src/utils/apiProblem.js');
    let err;
    try { validateResolution({}, { required: true }); } catch (e) { err = e; }
    expect(err?.code).toBe('resolution_reason_required');
    const problem = toProblem(err);
    expect(problem.status).toBe(400);
    expect(problem.code).toBe('resolution_reason_required');
    // A plain validation error without its own code keeps the family code.
    const { ValidationError } = await import('../src/utils/errors.js');
    expect(toProblem(new ValidationError('nope')).code).toBe('invalid_request');
  });
});

describe('validation', () => {
  test('a known reason with an optional note passes through trimmed', () => {
    expect(validateResolution({ resolutionReason: ' false_positive ', resolutionNote: '  Consumer VPN. ' }))
      .toEqual({ resolutionReason: 'false_positive', resolutionNote: 'Consumer VPN.' });
  });

  test('nothing sent and nothing required is fine', () => {
    expect(validateResolution({})).toEqual({ resolutionReason: null, resolutionNote: null });
  });

  test('required and missing is a 400 with the list attached, so a client can render the picker', () => {
    let err;
    try { validateResolution({}, { required: true }); } catch (e) { err = e; }
    expect(err.code).toBe('resolution_reason_required');
    expect(err.details.reasons).toHaveLength(7);
  });

  test('an unknown reason is rejected even when nothing was required', () => {
    expect(() => validateResolution({ resolutionReason: 'closed_thanks' })).toThrow(/Unknown resolution reason/);
  });

  test('"other" without a note is refused — that word alone reconciles nothing', () => {
    let err;
    try { validateResolution({ resolutionReason: 'other' }); } catch (e) { err = e; }
    expect(err.code).toBe('resolution_note_required');
    expect(validateResolution({ resolutionReason: 'other', resolutionNote: 'Merged into the RTBT epic' }).resolutionNote)
      .toBe('Merged into the RTBT epic');
  });

  test('a note over the cap is refused', () => {
    expect(() => validateResolution({ resolutionReason: 'duplicate', resolutionNote: 'x'.repeat(4001) })).toThrow(/longer than/);
  });

  test('isResolutionReason is a plain membership test', () => {
    expect(isResolutionReason('duplicate')).toBe(true);
    expect(isResolutionReason('')).toBe(false);
    expect(isResolutionReason(undefined)).toBe(false);
  });
});

describe('who resolved it, as a kind the events already speak', () => {
  test.each([
    [{ role: 'api' }, 'api'],
    [{ role: 'workflow' }, 'workflow'],
    [{ role: 'system' }, 'automation'],
    [{ role: 'admin', name: 'Mehdi' }, 'human'],
    [{}, 'human'],
    [null, 'human'],
  ])('%p -> %s', (actor, kind) => {
    expect(resolvedByKindFromActor(actor)).toBe(kind);
  });
});

describe('the reason travels everywhere it must', () => {
  const ticketSvc = src('../src/services/ticketService.js');
  const lifecycle = src('../src/services/ticketLifecycleNotificationService.js');
  const api = src('../src/routes/apiV1.routes.js');
  const routes = src('../src/routes/tickets.routes.js');
  const mirror = src('../src/services/mirrorService.js');
  const engine = src('../src/services/notificationWorkflowEngine.js');

  test('changeStatus validates BEFORE writing and clears the reason on reopen', () => {
    const fn = ticketSvc.slice(ticketSvc.indexOf('async changeStatus('), ticketSvc.indexOf('async assignTicket('));
    const validateAt = fn.indexOf('validateResolution(');
    const writeAt = fn.indexOf('prisma.ticket.update(');
    expect(validateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(writeAt);
    expect(fn).toMatch(/required: requiresResolutionReason\(ticket\) && !ticket\.resolutionReason/);
    expect(fn).toMatch(/patch\.resolutionReason = null;\s*patch\.resolutionNote = null;\s*patch\.resolvedByKind = null;/);
  });

  test('the actor reaches the lifecycle emitter, and the status-family events carry who/when/why', () => {
    expect(ticketSvc).toMatch(/_notifyLifecycle\(ticket, updated, \{ actorKind: resolvedByKindFromActor\(actor\), actor \}\)/);
    expect(lifecycle).toMatch(/\['ticket\.status_changed', 'ticket\.resolved_closed', 'ticket\.reopened'\]\.includes\(event\.type\)/);
    expect(lifecycle).toMatch(/resolutionReason: ticket\.resolutionReason \|\| null,/);
  });

  test('the webhook payload exposes resolution, correlation keys, the actor, and the assignee id/email (D3/D4)', () => {
    const fn = lifecycle.slice(lifecycle.indexOf('export function webhookPayloadFromContext'), lifecycle.indexOf('async function dispatchLifecycleWebhook'));
    for (const key of ['externalRef', 'externalReferences', 'resolvedAt', 'closedAt', 'firstAssignedAt', 'resolutionTimeSeconds', 'resolutionReason', 'resolutionNote', 'resolvedByKind']) {
      expect(fn).toContain(`${key}:`);
    }
    expect(fn).toMatch(/technicianId: eventContext\.assignedAgent\.id/);
    expect(fn).toMatch(/actor: eventContext\.event\?\.extra\?\.actor \|\| null/);
  });

  test('the public API accepts the reason on PATCH and returns it on GET', () => {
    expect(api).toMatch(/resolutionReason: body\.resolutionReason \?\? null/);
    for (const key of ['closedAt', 'firstAssignedAt', 'resolutionTimeSeconds', 'resolutionReason', 'resolutionNote', 'resolvedByKind']) {
      expect(api).toMatch(new RegExp(`^\\s+${key}: t\\.${key}`, 'm'));
    }
    expect(routes).toMatch(/resolutionReason: req\.body\?\.resolutionReason \?\? null/);
  });

  test('the FreshService copy states the reason as its resolution note', () => {
    expect(mirror).toMatch(/resolution_notes: ticket\.resolutionReason\s*\?/);
  });

  test('a workflow that resolves stamps its reason and is marked as the resolver', () => {
    expect(engine).toMatch(/patch\.resolvedByKind = 'workflow'/);
    expect(engine).toMatch(/node\.data\?\.resolutionReason/);
  });

  test('the benign-verdict template resolves as benign_expected', () => {
    const t = WORKFLOW_TEMPLATES.find((x) => x.key === 'simorgh_resolve_benign');
    // A resolve must not sit in the 3-minute change-mail coalescing window.
    expect(t.build().nodes.find((n) => n.type === 'trigger').data.coalesceMinutes).toBe(0);
    const node = t.build().nodes.find((n) => n.type === 'update_ticket');
    expect(node.data.setStatus).toBe('Resolved');
    expect(node.data.resolutionReason).toBe('benign_expected');
  });

  test('the template condition compiles and decides the way the C2 rule says', () => {
    // Run 2 of the sandbox acceptance: every run ended in
    // compileError "Unknown condition field: ticket.customFields.simorgh_verdict".
    const t = WORKFLOW_TEMPLATES.find((x) => x.key === 'simorgh_resolve_benign');
    const group = t.build().nodes.find((n) => n.id === 'verdict').data.conditionGroup;
    const types = { simorgh_recommends_close: 'boolean', simorgh_verdict: 'text', simorgh_containment: 'text' };
    expect(validateConditionGroup(group, { customFieldTypes: types })).toEqual([]);
    const rule = compileConditionGroup(group, { customFieldTypes: types });
    const scope = (cf, status = 'Open') => ({ ticket: { status, customFields: cf } });
    const benign = { simorgh_verdict: 'BenignPositive', simorgh_containment: 'none', simorgh_recommends_close: true };
    expect(Boolean(jsonLogic.apply(rule, scope(benign)))).toBe(true);
    expect(Boolean(jsonLogic.apply(rule, scope({ ...benign, simorgh_verdict: 'FalsePositive' })))).toBe(true);
    expect(Boolean(jsonLogic.apply(rule, scope({ ...benign, simorgh_verdict: 'TruePositive' })))).toBe(false);
    expect(Boolean(jsonLogic.apply(rule, scope({ ...benign, simorgh_containment: 'queued' })))).toBe(false);
    expect(Boolean(jsonLogic.apply(rule, scope({ ...benign, simorgh_recommends_close: false })))).toBe(false);
    expect(Boolean(jsonLogic.apply(rule, scope(benign, 'Resolved')))).toBe(false);
    // Untyped (no definitions supplied) still compiles — string fallback.
    expect(() => compileConditionGroup(group)).not.toThrow();
  });
});
