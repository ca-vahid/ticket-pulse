function toMillis(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function getActivityRefreshReason({
  fsTicket,
  preparedTicket = null,
  existingTicket = null,
  activeEpisode = null,
  hasActiveRun = false,
} = {}) {
  if (!existingTicket) return 'new_ticket';

  const fsTicketId = fsTicket?.id ?? preparedTicket?.freshserviceTicketId;
  const fsResponderId = fsTicket?.responder_id ?? preparedTicket?.assignedFreshserviceId ?? null;
  const hasAssignedResponder = fsResponderId !== null && fsResponderId !== undefined;
  const incomingTechId = normalizeId(preparedTicket?.assignedTechId);
  const existingTechId = normalizeId(existingTicket.assignedTechId);

  if (hasAssignedResponder && (!existingTicket.assignedBy || !existingTicket.firstAssignedAt)) {
    return 'missing_assignment_analysis';
  }

  if (incomingTechId !== existingTechId) {
    return 'responder_changed';
  }

  if (activeEpisode) {
    const activeEpisodeTechId = normalizeId(activeEpisode.technicianId);
    if (!hasAssignedResponder) return 'active_episode_but_unassigned';
    if (incomingTechId && activeEpisodeTechId !== incomingTechId) {
      return 'active_episode_mismatch';
    }
  } else if (hasAssignedResponder && incomingTechId && !existingTicket.activitiesSyncFreshserviceUpdatedAt) {
    return 'assigned_without_active_episode';
  }

  const fsUpdatedMs = toMillis(fsTicket?.updated_at ?? preparedTicket?.freshserviceUpdatedAt);
  const activityFreshMs = toMillis(existingTicket.activitiesSyncFreshserviceUpdatedAt);
  if (fsUpdatedMs && (!activityFreshMs || fsUpdatedMs > activityFreshMs)) {
    return 'freshservice_update_newer_than_activity_sync';
  }

  if (existingTicket.activitiesSyncError) {
    return 'previous_activity_sync_error';
  }

  if (hasActiveRun) return 'active_assignment_run';

  if (fsTicketId === undefined || fsTicketId === null) return 'missing_ticket_id';

  return null;
}

export function shouldRefreshTicketActivities(args) {
  return Boolean(getActivityRefreshReason(args));
}
