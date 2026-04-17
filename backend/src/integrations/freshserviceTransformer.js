import logger from '../utils/logger.js';
import { FRESHSERVICE_TZ_TO_IANA } from '../config/constants.js';

/**
 * Transform FreshService API data to our database schema
 */

/**
 * Map FreshService status ID to status string
 */
const STATUS_MAP = {
  2: 'Open',
  3: 'Pending',
  4: 'Resolved',
  5: 'Closed',
  6: 'Waiting on Customer',
  7: 'Waiting on Third Party',
};

/**
 * Map FreshService priority ID to priority number
 */
const PRIORITY_MAP = {
  1: 1, // Low
  2: 2, // Medium
  3: 3, // High
  4: 4, // Urgent
};

/**
 * Transform FreshService ticket to our database format
 * @param {Object} fsTicket - FreshService ticket object
 * @returns {Object} Transformed ticket data
 */
export function transformTicket(fsTicket, { categoryCustomField = 'security' } = {}) {
  if (!fsTicket || !fsTicket.id) {
    logger.warn('Invalid FreshService ticket data');
    return null;
  }

  try {
    return {
      freshserviceTicketId: fsTicket.id,
      subject: fsTicket.subject || 'No Subject',
      description: fsTicket.description || null,
      descriptionText: fsTicket.description_text || null,
      status: fsTicket.deleted ? 'Deleted' : fsTicket.spam ? 'Spam' : (STATUS_MAP[fsTicket.status] || 'Open'),
      priority: PRIORITY_MAP[fsTicket.priority] || 3,
      assignedTechId: null,
      assignedFreshserviceId: fsTicket.responder_id || null,
      isSelfPicked: false,
      requesterName: fsTicket.requester?.name || null,
      requesterEmail: fsTicket.requester?.email || null,
      requesterId: fsTicket.requester_id ? BigInt(fsTicket.requester_id) : null,
      createdAt: fsTicket.created_at ? new Date(fsTicket.created_at) : new Date(),
      assignedAt: fsTicket.assigned_at ? new Date(fsTicket.assigned_at) : null,
      resolvedAt: fsTicket.resolved_at ? new Date(fsTicket.resolved_at) : null,
      closedAt: fsTicket.closed_at ? new Date(fsTicket.closed_at) : null,
      dueBy: fsTicket.due_by ? new Date(fsTicket.due_by) : null,
      frDueBy: fsTicket.fr_due_by ? new Date(fsTicket.fr_due_by) : null,
      updatedAt: fsTicket.updated_at ? new Date(fsTicket.updated_at) : new Date(),
      source: fsTicket.source || null,
      category: fsTicket.category || null,
      subCategory: fsTicket.sub_category || null,
      ticketCategory: fsTicket.custom_fields?.[categoryCustomField] || null,
      department: fsTicket.department?.name || null,
      isEscalated: fsTicket.is_escalated || false,
      groupId: fsTicket.group_id ? BigInt(fsTicket.group_id) : null,
      // Time tracking - Logged work hours (would need separate /time_entries API call)
      timeSpentMinutes: null,
      billableMinutes: null,
      nonBillableMinutes: null,
      // Resolution time - Available in stats field
      resolutionTimeSeconds: fsTicket.stats?.resolution_time_in_secs || null,
      // First assigned time - Will be populated by activity analysis
      firstAssignedAt: null, // Populated later in sync process
    };
  } catch (error) {
    logger.error('Error transforming ticket:', error);
    return null;
  }
}

/**
 * Transform FreshService agent to our database format
 * @param {Object} fsAgent - FreshService agent object
 * @param {number|string} workspaceId - Optional workspace ID
 * @returns {Object} Transformed technician data
 */
export function transformAgent(fsAgent, workspaceId = null) {
  if (!fsAgent || !fsAgent.id) {
    logger.warn('Invalid FreshService agent data');
    return null;
  }

  try {
    // Determine workspace ID from agent's workspace_ids array or use provided one
    let agentWorkspaceId = workspaceId;
    if (!agentWorkspaceId && fsAgent.workspace_ids && fsAgent.workspace_ids.length > 0) {
      agentWorkspaceId = fsAgent.workspace_ids[0]; // Use first workspace
    }

    // NOTE: We don't sync location from FreshService anymore
    // Location is manually managed in the Visuals page
    // This prevents FreshService syncs from overwriting manually set locations

    return {
      freshserviceId: fsAgent.id,
      name: `${fsAgent.first_name || ''} ${fsAgent.last_name || ''}`.trim() || 'Unknown',
      email: fsAgent.email || null,
      timezone: FRESHSERVICE_TZ_TO_IANA[fsAgent.time_zone] || fsAgent.time_zone || 'America/Los_Angeles',
      // location: explicitly NOT included - managed manually
      workspaceId: agentWorkspaceId ? BigInt(agentWorkspaceId) : null,
      isActive: fsAgent.active !== undefined ? fsAgent.active : true,
    };
  } catch (error) {
    logger.error('Error transforming agent:', error);
    return null;
  }
}

/**
 * Analyze ticket activities to determine full assignment history.
 *
 * Emits:
 *  - events[]    – every agent assign / unassign / group change as a typed event
 *  - episodes[]  – one entry per ownership period (assign → unassign/reassign/close)
 *  - legacy fields (isSelfPicked, assignedBy, firstAssignedAt, assignmentHistory)
 *    kept for backward-compat but isSelfPicked now reflects the CURRENT owner.
 *
 * @param {Array} activities - FreshService ticket activities
 * @returns {Object} Full assignment analysis
 */
export function analyzeTicketActivities(activities) {
  const empty = {
    isSelfPicked: false,
    assignedBy: null,
    firstAssignedAt: null,
    assignmentHistory: [],
    firstPublicAgentReplyAt: null,
    events: [],
    episodes: [],
    currentEpisode: null,
    currentIsSelfPicked: false,
    rejectionCount: 0,
    groupChanges: [],
  };

  if (!activities || !Array.isArray(activities) || activities.length === 0) {
    return empty;
  }

  const sortedActivities = [...activities].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  );

  const events = [];
  const assignmentHistory = [];
  const groupChanges = [];
  let firstPublicAgentReplyAt = null;

  for (const activity of sortedActivities) {
    // Detect first public agent reply
    if (!firstPublicAgentReplyAt) {
      const isIncoming = activity.incoming === true;
      const isPrivate = activity.private === true;
      const hasMessageBody =
        (typeof activity.body_text === 'string' && activity.body_text.trim().length > 0) ||
        (typeof activity.body === 'string' && activity.body.trim().length > 0) ||
        (typeof activity.note === 'string' && activity.note.trim().length > 0);
      if (!isIncoming && !isPrivate && hasMessageBody && activity.created_at) {
        firstPublicAgentReplyAt = new Date(activity.created_at);
      }
    }

    if (!activity.content) continue;
    const content = activity.content;
    const actorName = activity.actor?.name || null;
    const actorFsId = activity.actor?.id || null;
    const timestamp = new Date(activity.created_at);

    // Agent assignments: "set Agent as <name>" or "set Agent as none"
    // FreshService often combines: "set Agent as X and set Group as Y"
    const agentMatch = content.match(/set Agent as (.+?)(?:\s+and\s+set\s+|$)/);
    if (agentMatch) {
      let assignedTo = agentMatch[1].trim();
      // Clean trailing "and set Group..." that may leak past the regex
      assignedTo = assignedTo.replace(/\s+and\s+set\s+.*/i, '').trim();

      if (assignedTo.toLowerCase() === 'none') {
        events.push({
          type: 'rejected',
          timestamp,
          actorName,
          actorFsId,
          agentName: null,
        });
        logger.debug(`Rejection detected: Actor="${actorName}" unassigned ticket at ${timestamp.toISOString()}`);
      } else {
        const isSelf = actorName && actorName === assignedTo;
        events.push({
          type: isSelf ? 'self_picked' : 'coordinator_assigned',
          timestamp,
          actorName,
          actorFsId,
          agentName: assignedTo,
        });

        assignmentHistory.push({
          timestamp,
          assignedBy: actorName,
          assignedTo,
        });

        logger.debug(`Assignment: Actor="${actorName}", Assigned="${assignedTo}" (${isSelf ? 'self' : 'coord'}) at ${timestamp.toISOString()}`);
      }
    }

    // Workflow-driven "set Agent as none" inside sub_contents (FS escalation workflows)
    if (activity.sub_contents && Array.isArray(activity.sub_contents)) {
      for (const sc of activity.sub_contents) {
        if (typeof sc === 'string' && /^set Agent as none$/i.test(sc.trim())) {
          // Only emit if we didn't already emit a rejection from the main content
          if (!agentMatch || agentMatch[1].trim().toLowerCase() !== 'none') {
            events.push({
              type: 'rejected',
              timestamp,
              actorName: actorName || 'Ticket Workflow',
              actorFsId,
              agentName: null,
              source: 'workflow_sub_content',
            });
          }
        }
      }
    }

    // Group changes: "set Group as <name>"
    const groupMatch = content.match(/set Group as (.+?)(?:\s+and\s+set\s+|$)/);
    if (groupMatch) {
      let groupName = groupMatch[1].trim();
      groupName = groupName.replace(/\s+and\s+set\s+.*/i, '').trim();
      const isNone = groupName.toLowerCase() === 'none';
      events.push({
        type: 'group_changed',
        timestamp,
        actorName,
        actorFsId,
        groupName: isNone ? null : groupName,
      });
      groupChanges.push({
        timestamp,
        actorName,
        groupName: isNone ? null : groupName,
      });
    }
  }

  // --- Build episodes from events ---
  const episodes = [];
  let currentHolder = null; // { agentName, startedAt, startMethod, startAssignedByName }

  for (const evt of events) {
    if (evt.type === 'self_picked' || evt.type === 'coordinator_assigned') {
      // Close previous episode if open
      if (currentHolder) {
        episodes.push({
          ...currentHolder,
          endedAt: evt.timestamp,
          endMethod: 'reassigned',
          endActorName: evt.actorName,
        });
      }
      currentHolder = {
        agentName: evt.agentName,
        startedAt: evt.timestamp,
        startMethod: evt.type,
        startAssignedByName: evt.type === 'coordinator_assigned' ? evt.actorName : null,
      };
    } else if (evt.type === 'rejected') {
      if (currentHolder) {
        episodes.push({
          ...currentHolder,
          endedAt: evt.timestamp,
          endMethod: 'rejected',
          endActorName: evt.actorName,
        });
        currentHolder = null;
      }
    }
  }

  // If there is still an open holder, mark as still_active
  if (currentHolder) {
    episodes.push({
      ...currentHolder,
      endedAt: null,
      endMethod: 'still_active',
      endActorName: null,
    });
  }

  const currentEpisode = episodes.length > 0 ? episodes[episodes.length - 1] : null;
  const rejectionCount = episodes.filter((e) => e.endMethod === 'rejected').length;

  // --- Derive legacy fields for backward-compat ---
  // isSelfPicked now reflects the CURRENT owner's acquisition method
  const currentIsSelfPicked = currentEpisode?.endMethod === 'still_active' && currentEpisode?.startMethod === 'self_picked';

  const firstAssignment = assignmentHistory.length > 0 ? assignmentHistory[0] : null;
  const firstAssignedAt = firstAssignment ? firstAssignment.timestamp : null;

  // assignedBy: for the current episode (not the first one) if coordinator-assigned
  const assignedBy = currentIsSelfPicked
    ? null
    : (currentEpisode?.startAssignedByName || firstAssignment?.assignedBy || null);

  return {
    isSelfPicked: currentIsSelfPicked,
    assignedBy,
    firstAssignedAt,
    assignmentHistory,
    firstPublicAgentReplyAt,
    events,
    episodes,
    currentEpisode,
    currentIsSelfPicked,
    rejectionCount,
    groupChanges,
  };
}

/**
 * Transform FreshService ticket activity to our database format
 * @param {Object} fsActivity - FreshService activity/conversation object
 * @param {number} ticketId - Our internal ticket ID
 * @returns {Object} Transformed activity data
 */
export function transformTicketActivity(fsActivity, ticketId) {
  if (!fsActivity || !ticketId) {
    logger.warn('Invalid activity or ticket ID');
    return null;
  }

  try {
    // Determine activity type based on FreshService data
    let activityType = 'note';
    if (fsActivity.incoming) {
      activityType = 'customer_reply';
    } else if (fsActivity.private) {
      activityType = 'note';
    } else if (fsActivity.body_text?.includes('assigned')) {
      activityType = 'assigned';
    } else if (fsActivity.body_text?.includes('status')) {
      activityType = 'status_changed';
    }

    return {
      ticketId,
      activityType,
      fromTechId: null, // Will be resolved with tech mapping
      toTechId: null, // Will be resolved with tech mapping
      oldStatus: null,
      newStatus: null,
      oldPriority: null,
      newPriority: null,
      note: fsActivity.body_text || null,
      createdAt: fsActivity.created_at ? new Date(fsActivity.created_at) : new Date(),
    };
  } catch (error) {
    logger.error('Error transforming ticket activity:', error);
    return null;
  }
}

/**
 * Batch transform tickets
 * @param {Array} fsTickets - Array of FreshService tickets
 * @returns {Array} Array of transformed tickets
 */
export function transformTickets(fsTickets, options = {}) {
  if (!Array.isArray(fsTickets)) {
    logger.warn('Invalid tickets array');
    return [];
  }

  return fsTickets
    .map(ticket => transformTicket(ticket, options))
    .filter(ticket => ticket !== null);
}

/**
 * Batch transform agents
 * @param {Array} fsAgents - Array of FreshService agents
 * @param {number|string} workspaceId - Optional workspace ID to filter by
 * @returns {Array} Array of transformed technicians
 */
export function transformAgents(fsAgents, workspaceId = null) {
  if (!Array.isArray(fsAgents)) {
    logger.warn('Invalid agents array');
    return [];
  }

  // Filter by workspace if specified
  let filteredAgents = fsAgents;
  if (workspaceId !== null) {
    const workspaceIdNum = Number(workspaceId);
    filteredAgents = fsAgents.filter(agent => {
      return agent.workspace_ids && agent.workspace_ids.includes(workspaceIdNum);
    });
    logger.info(`Filtered ${filteredAgents.length} agents from ${fsAgents.length} by workspace ${workspaceIdNum}`);
  }

  return filteredAgents
    .map(agent => transformAgent(agent, workspaceId))
    .filter(agent => agent !== null);
}

/**
 * Map FreshService responder IDs to our internal technician IDs
 * @param {Array} tickets - Tickets with assignedFreshserviceId
 * @param {Map} freshserviceIdToInternalIdMap - Map of FreshService ID to internal ID
 * @returns {Array} Tickets with assignedTechId populated
 */
export function mapTechnicianIds(tickets, freshserviceIdToInternalIdMap) {
  if (!Array.isArray(tickets) || !freshserviceIdToInternalIdMap) {
    return tickets;
  }

  return tickets.map(ticket => {
    if (ticket.assignedFreshserviceId) {
      const internalId = freshserviceIdToInternalIdMap.get(
        Number(ticket.assignedFreshserviceId),
      );
      if (internalId) {
        ticket.assignedTechId = internalId;
      }
    }
    return ticket;
  });
}

/**
 * Get status string from FreshService status ID
 * @param {number} statusId - FreshService status ID
 * @returns {string} Status string
 */
export function getStatusString(statusId) {
  return STATUS_MAP[statusId] || 'Open';
}

/**
 * Get priority number from FreshService priority ID
 * @param {number} priorityId - FreshService priority ID
 * @returns {number} Priority number
 */
export function getPriorityNumber(priorityId) {
  return PRIORITY_MAP[priorityId] || 3;
}

/**
 * Convert status string to FreshService status ID
 * @param {string} status - Status string
 * @returns {number} FreshService status ID
 */
export function getStatusId(status) {
  const reverseMap = Object.entries(STATUS_MAP).find(([_id, str]) => str === status);
  return reverseMap ? Number(reverseMap[0]) : 2; // Default to Open
}

/**
 * Convert priority number to FreshService priority ID
 * @param {number} priority - Priority number
 * @returns {number} FreshService priority ID
 */
export function getPriorityId(priority) {
  return priority >= 1 && priority <= 4 ? priority : 3; // Default to High
}
