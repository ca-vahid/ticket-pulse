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

