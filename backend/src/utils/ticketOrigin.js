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

