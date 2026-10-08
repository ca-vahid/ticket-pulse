import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { TICKET_SOURCE, TICKET_SOURCE_LABELS, AGENT_SELECTABLE_SOURCES } from '../src/utils/ticketOrigin.js';
import { isNativeSandbox } from '../src/services/ticketService.js';

/**
 * Simorgh Release C (part 2) — unattended requesters (A4) and the Security
 * Agent source (B8).
 *
 * simorgh@ is a mailbox nobody reads. Every requester-facing send — the ack,
 * status mails, CSAT, reply copies — must skip it without the caller opting
 * out per ticket.
 */

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('B8 — source 104 "Security Agent"', () => {
  test('exists, is labelled, and a caller may set it', () => {
    expect(TICKET_SOURCE.SECURITY_AGENT).toBe(104);
    expect(TICKET_SOURCE_LABELS[104]).toBe('Security Agent');
    expect(AGENT_SELECTABLE_SOURCES).toContain(104);
  });

  test('does not collide with a FreshService code', () => {
    // FS custom sources in this instance live at 11-19 and 1000+; ours at 100-104.
    expect(Object.keys(TICKET_SOURCE_LABELS).map(Number).filter((n) => n === 104)).toHaveLength(1);
  });
});

describe('A4 — an unattended requester never gets requester-facing mail', () => {
  const engine = src('../src/services/notificationWorkflowEngine.js');
  const svc = src('../src/services/ticketService.js');
  const lifecycle = src('../src/services/ticketLifecycleNotificationService.js');
  const api = src('../src/routes/apiV1.routes.js');

  test('the workflow recipient resolver: role "requester" of an unattended requester = the ticket Cc list (none for Simorgh)', () => {
    expect(engine).toMatch(/if \(!context\.requester\?\.unattended\) return \[context\.requester\?\.email\];/);
    expect(engine).toMatch(/return Array\.isArray\(context\.ticket\?\.ccEmails\) \? context\.ticket\.ccEmails : \[\];/);
  });

  test('the event context carries the flag so the resolver can see it', () => {
    expect(lifecycle).toMatch(/unattended: ticket\.requester\.unattended === true,/);
  });

  test('a reply to an unattended requester with nobody Cc\'d is stored but not emailed; with a Cc it goes to the Cc list', () => {
    const fn = svc.slice(svc.indexOf('async _emailRequesterReply('));
    expect(fn.slice(0, 1600)).toMatch(/const unattended = ticket\.requester\?\.unattended === true;[\s\S]{0,300}if \(unattended && ccPeople\.length === 0\)[\s\S]{0,200}return \{ sent: false, skipped: 'unattended_requester' \}/);
    expect(fn.slice(0, 2400)).toMatch(/const toAddress = unattended \? ccPeople\[0\] :/);
    // ...and the ticket include actually selects the column, or the guard is dead.
    expect(svc).toMatch(/entraCity: true, entraOfficeLocation: true, entraState: true,\s*(\/\/[^\n]*\n\s*)?unattended: true,/);
  });

  test('the public contact shape and /meta expose what an integrator needs', () => {
    expect(api).toMatch(/unattended: r\.unattended === true,/);
    expect(api).toMatch(/resolutionReasons: RESOLUTION_REASONS\.map/);
    expect(api).toMatch(/sources: AGENT_SELECTABLE_SOURCES\.map/);
  });
});

describe('Sandbox workspaces — inactive, but writable through a bound credential', () => {
  // Acceptance run 14 Sep: POST /tickets into the Simorgh sandbox (ws 7,
  // isActive:false by design) answered "Workspace 7 not found". The native
  // ticket service's workspace gate only knew "active".
  test('a native workspace with no FreshService binding passes the gate while inactive', () => {
    expect(isNativeSandbox({ isActive: false, nativeTicketingEnabled: true, freshserviceWorkspaceId: 0n })).toBe(true);
    expect(isNativeSandbox({ isActive: false, nativeTicketingEnabled: true, freshserviceWorkspaceId: null })).toBe(true);
  });

  test('a decommissioned FreshService workspace, or one without native ticketing, stays closed', () => {
    expect(isNativeSandbox({ isActive: false, nativeTicketingEnabled: true, freshserviceWorkspaceId: 1000208182n })).toBe(false);
    expect(isNativeSandbox({ isActive: false, nativeTicketingEnabled: false, freshserviceWorkspaceId: null })).toBe(false);
    expect(isNativeSandbox({ isActive: true, nativeTicketingEnabled: true, freshserviceWorkspaceId: null })).toBe(false);
  });
});
