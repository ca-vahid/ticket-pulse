import logger from '../utils/logger.js';

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
export function transformTicket(fsTicket) {
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
      status: STATUS_MAP[fsTicket.status] || 'Open',
      priority: PRIORITY_MAP[fsTicket.priority] || 3,
      assignedTechId: null, // Will be resolved later with tech mapping
      assignedFreshserviceId: fsTicket.responder_id || null,
      isSelfPicked: false, // Will be determined by activity analysis
      // Requester information (from included data or IDs)
      requesterName: fsTicket.requester?.name || null,
      requesterEmail: fsTicket.requester?.email || null,
      requesterId: fsTicket.requester_id ? BigInt(fsTicket.requester_id) : null,
      // Timestamps
      createdAt: fsTicket.created_at ? new Date(fsTicket.created_at) : new Date(),
      assignedAt: fsTicket.assigned_at ? new Date(fsTicket.assigned_at) : null,
      resolvedAt: fsTicket.resolved_at ? new Date(fsTicket.resolved_at) : null,
      closedAt: fsTicket.closed_at ? new Date(fsTicket.closed_at) : null,
      dueBy: fsTicket.due_by ? new Date(fsTicket.due_by) : null,
      frDueBy: fsTicket.fr_due_by ? new Date(fsTicket.fr_due_by) : null,
      updatedAt: fsTicket.updated_at ? new Date(fsTicket.updated_at) : new Date(),
      // Additional metadata
      source: fsTicket.source || null,
      category: fsTicket.category || null,
      subCategory: fsTicket.sub_category || null,
      ticketCategory: fsTicket.custom_fields?.security || null, // Custom field: security (e.g., BST, GIS)
      department: fsTicket.department?.name || null,
      isEscalated: fsTicket.is_escalated || false,
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
      timezone: fsAgent.time_zone || 'America/Los_Angeles',
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
 * Analyze ticket activities to determine assignment details
 * @param {Array} activities - FreshService ticket activities/conversations
 * @returns {Object} Assignment analysis
 */
export function analyzeTicketActivities(activities) {
  if (!activities || !Array.isArray(activities) || activities.length === 0) {
    return {
      isSelfPicked: false,
      assignmentHistory: [],
      firstPublicAgentReplyAt: null,
    };
  }

  const assignmentHistory = [];
  let isSelfPicked = false;
  let firstAssignmentChecked = false; // Track if we've checked the first assignment
  let firstPublicAgentReplyAt = null;

  // Sort activities by created_at to find the FIRST assignment
  const sortedActivities = [...activities].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  );

  for (const activity of sortedActivities) {
    // Detect first public agent reply (outgoing + non-private).
    // FreshService activities often include fields like:
    // - created_at: timestamp
    // - incoming: boolean (true if customer/incoming)
    // - private: boolean (true if private note)
    // - body_text / body / note: message content for replies/notes
    // This is best-effort: if incoming/private flags are absent, we won't guess.
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

    // Check for assignment activity in the content field
    // FreshService activities use content like " set Agent as [Agent Name]"
    if (activity.content && activity.content.includes('set Agent as')) {
      // Extract the agent name from content (format: " set Agent as [Agent Name]")
      const match = activity.content.match(/set Agent as (.+)/);
      if (match) {
        const assignedAgentName = match[1].trim();
        const actorName = activity.actor?.name;

        // Log for debugging
        logger.debug(`Assignment activity found: Actor="${actorName}", Assigned="${assignedAgentName}"`);

        assignmentHistory.push({
          timestamp: new Date(activity.created_at),
          assignedBy: actorName,
          assignedTo: assignedAgentName,
        });

        // ONLY check the FIRST assignment for self-picking
        // Self-picked = the actor (who performed the action) is the same as the assigned agent
        if (!firstAssignmentChecked && actorName && assignedAgentName) {
          firstAssignmentChecked = true; // Mark that we've checked the first assignment
          if (actorName === assignedAgentName) {
            isSelfPicked = true;
            logger.debug(`Ticket is SELF-PICKED: ${actorName} assigned to themselves`);
          } else {
            logger.debug(`Ticket is COORDINATOR-ASSIGNED: ${actorName} assigned to ${assignedAgentName}`);
          }
        }
      }
    }
  }

  // Get the first assignment (coordinator who assigned the ticket)
  const firstAssignment = assignmentHistory.length > 0 ? assignmentHistory[0] : null;

  // IMPORTANT: If ticket is self-picked, assignedBy MUST be null
  // This ensures self-picked tickets never show an assigner name
  const assignedBy = isSelfPicked ? null : (firstAssignment ? firstAssignment.assignedBy : null);

  // Extract first assigned timestamp for pickup time calculation
  const firstAssignedAt = firstAssignment ? firstAssignment.timestamp : null;

  return {
    isSelfPicked,
    assignedBy, // The coordinator who assigned this ticket (null if self-picked)
    firstAssignedAt, // Timestamp when ticket was first assigned
    assignmentHistory,
    firstPublicAgentReplyAt,
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
export function transformTickets(fsTickets) {
  if (!Array.isArray(fsTickets)) {
    logger.warn('Invalid tickets array');
    return [];
  }

  return fsTickets
    .map(ticket => transformTicket(ticket))
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
