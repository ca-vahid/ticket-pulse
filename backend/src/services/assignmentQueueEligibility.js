export const CLOSED_STATUSES = ['Closed', 'Resolved', 'closed', 'resolved', 'Deleted', 'Spam', '4', '5'];

const FRESHSERVICE_TERMINAL_STATUS_LABELS = new Map([
  [4, 'Resolved'],
  [5, 'Closed'],
]);

export function getLocalTicketQueueBlocker(ticket) {
  if (!ticket) {
    return {
      valid: false,
      reason: 'Ticket no longer exists',
    };
  }

  if (CLOSED_STATUSES.includes(String(ticket.status))) {
    return {
      valid: false,
      reason: `Ticket already ${ticket.status}`,
      localStatus: String(ticket.status),
    };
  }

  if (ticket.assignedTechId) {
    return {
      valid: false,
      reason: 'Ticket already assigned to a technician',
    };
  }

  return null;
}

export function getFreshServiceTicketQueueBlocker(fsTicket) {
  if (fsTicket === null) {
    return {
      valid: false,
      reason: 'Ticket no longer exists in FreshService (hard deleted / 404)',
      localStatus: 'Deleted',
      activityReason: 'Ticket no longer exists in FreshService (hard deleted / 404)',
    };
  }

  if (fsTicket?.__forbidden) {
    return {
      valid: false,
      reason: 'Ticket is no longer visible to the FreshService API credentials',
      shouldUpdateTicket: false,
    };
  }

  if (fsTicket?.deleted === true) {
    return {
      valid: false,
      reason: 'Ticket was deleted in FreshService',
      localStatus: 'Deleted',
      activityReason: 'Ticket was trashed/soft-deleted in FreshService (deleted=true)',
    };
  }

  if (fsTicket?.spam === true) {
    return {
      valid: false,
      reason: 'Ticket was marked as spam in FreshService',
      localStatus: 'Spam',
      activityReason: 'Ticket was marked as spam in FreshService (spam=true)',
    };
  }

  const statusCode = Number(fsTicket?.status);
  if (FRESHSERVICE_TERMINAL_STATUS_LABELS.has(statusCode)) {
    const label = FRESHSERVICE_TERMINAL_STATUS_LABELS.get(statusCode);
    return {
      valid: false,
      reason: `Ticket already ${label} in FreshService`,
      localStatus: label,
      activityReason: `Ticket status in FreshService is ${label}`,
    };
  }

  if (fsTicket?.responder_id) {
    return {
      valid: false,
      reason: 'Ticket already assigned in FreshService',
      freshserviceResponderId: fsTicket.responder_id,
    };
  }

  return null;
}
