import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { TICKET_SOURCE, TICKET_SOURCE_LABELS, AGENT_SELECTABLE_SOURCES } from '../src/utils/ticketOrigin.js';

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

  test('the workflow recipient resolver returns nobody for role "requester"', () => {
    expect(engine).toMatch(/if \(value === 'requester'\) return context\.requester\?\.unattended \? \[\] : \[context\.requester\?\.email\];/);
  });

  test('the event context carries the flag so the resolver can see it', () => {
    expect(lifecycle).toMatch(/unattended: ticket\.requester\.unattended === true,/);
  });

  test('a reply to an unattended requester is stored but not emailed', () => {
    const fn = svc.slice(svc.indexOf('async _emailRequesterReply('));
    expect(fn.slice(0, 900)).toMatch(/ticket\.requester\?\.unattended === true[\s\S]{0,200}return \{ sent: false, skipped: 'unattended_requester' \}/);
    // ...and the ticket include actually selects the column, or the guard is dead.
    expect(svc).toMatch(/entraCity: true, entraOfficeLocation: true, entraState: true,\s*(\/\/[^\n]*\n\s*)?unattended: true,/);
  });

  test('the public contact shape and /meta expose what an integrator needs', () => {
    expect(api).toMatch(/unattended: r\.unattended === true,/);
    expect(api).toMatch(/resolutionReasons: RESOLUTION_REASONS\.map/);
    expect(api).toMatch(/sources: AGENT_SELECTABLE_SOURCES\.map/);
  });
});
