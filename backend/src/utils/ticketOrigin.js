/**
 * Ticket origin — the dual-origin ownership model for native ticketing.
 *
 * 'freshservice' — synced from FreshService. FS is the source of truth; the FS
 *                  ingest pipeline (poll, webhook, backfill, sweeps) may write it.
 * 'ticketpulse'  — born inside Ticket Pulse. TP is the source of truth; FS ingest
 *                  must NEVER write these rows, even after the fallback mirror
 *                  assigns them a freshserviceTicketId. The mirror/reconciliation
 *                  service is the only deliberate path for FS-side deltas.
 */
export const TICKET_ORIGIN = {
  FRESHSERVICE: 'freshservice',
  TICKETPULSE: 'ticketpulse',
};

export function isTicketPulseOrigin(ticketOrRow) {
  return ticketOrRow?.origin === TICKET_ORIGIN.TICKETPULSE;
}

// Canonical AssignmentPipelineRun.triggerSource for tickets created inside the
// app (the column is free-form VARCHAR(60); this is the agreed value).
export const APP_NATIVE_TRIGGER_SOURCE = 'app_native';

/**
 * Ticket arrival channel (QA 07-07 #1). One numeric space across both
 * origins: 1–10 are FreshService's own source codes (synced as-is);
 * 100+ is the Ticket Pulse extension range so FS can never collide.
 * TP-born tickets persist their channel at creation.
 */
export const TICKET_SOURCE = {
  EMAIL: 1,
  PORTAL: 2, // reserved for future TP portal intake
  PHONE: 3,
  WALK_UP: 9, // FS's own walk-up code, reused for TP-born tickets
  API: 100,
  WEBHOOK: 101, // reserved for future webhook intake
  MS_TEAMS: 102, // requests arriving via Teams chat (QA 07-10 #6/#7)
  AGENT: 103, // created by staff inside the Ticket Pulse app
};

export const TICKET_SOURCE_LABELS = {
  1: 'Email', 2: 'Portal', 3: 'Phone', 4: 'Chat', 5: 'Feedback widget',
  6: 'Yammer', 7: 'AWS CloudWatch', 8: 'PagerDuty', 9: 'Walk-up', 10: 'Slack',
  // 11–19 and 1000+ are this FS instance's custom source choices (QA 07-14 #5;
  // names read from FS /ticket_form_fields on 2026-07-14).
  13: 'Employee Onboarding', 14: 'Alerts', 15: 'MS Teams (FS)',
  18: 'Employee Offboarding', 19: 'Journey',
  100: 'API', 101: 'Webhook', 102: 'MS Teams', 103: 'Agent',
  1001: 'API (FreshService)', 1002: 'Company Portal',
};

// Channels a staff member can pick when logging or editing a TP-born ticket
// (how the request actually reached them). FS-born tickets keep FS's value.
export const AGENT_SELECTABLE_SOURCES = [
  TICKET_SOURCE.AGENT, TICKET_SOURCE.EMAIL, TICKET_SOURCE.PHONE,
  TICKET_SOURCE.WALK_UP, TICKET_SOURCE.MS_TEAMS, TICKET_SOURCE.PORTAL,
];

export function ticketSourceLabel(source) {
  if (source === null || source === undefined) return null;
  return TICKET_SOURCE_LABELS[Number(source)] || `Source ${source}`;
}

/**
 * Human-facing ticket reference: TP-born tickets show their native number
 * ("TP-1042"); FS-born tickets keep the familiar FreshService "#12345".
 */
export function ticketDisplayRef(ticket) {
  if (isTicketPulseOrigin(ticket) && ticket.nativeNumber !== null && ticket.nativeNumber !== undefined) {
    return `TP-${ticket.nativeNumber}`;
  }
  if (ticket?.freshserviceTicketId !== null && ticket?.freshserviceTicketId !== undefined) {
    return `#${ticket.freshserviceTicketId}`;
  }
  return ticket?.id !== null && ticket?.id !== undefined ? `TP-ID-${ticket.id}` : 'ticket';
}

