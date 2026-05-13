export const BROAD_ASSIGNMENT_GROUP_NAME = 'Everyone IT';

export function normalizeFreshServiceGroupMemberIds(group) {
  const memberIds = Array.isArray(group?.members)
    ? group.members
    : Array.isArray(group?.agent_ids) ? group.agent_ids : null;

  if (!Array.isArray(memberIds)) return null;
  return memberIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
}

export function freshServiceGroupHasAgent(group, agentId) {
  const memberIds = normalizeFreshServiceGroupMemberIds(group);
  if (!memberIds) return true;
  return memberIds.includes(Number(agentId));
}

export async function resolveBroadAssignmentGroup(client, fsConfig, agentId, currentGroupId) {
  const filters = fsConfig?.workspaceId ? { workspace_id: Number(fsConfig.workspaceId) } : {};
  const groups = await client.listGroups(filters);
  const broadGroup = groups.find((group) =>
    String(group?.name || '').trim().toLowerCase() === BROAD_ASSIGNMENT_GROUP_NAME.toLowerCase());

  if (!broadGroup?.id) {
    return {
      ok: false,
      reason: `Fallback group "${BROAD_ASSIGNMENT_GROUP_NAME}" was not found`,
    };
  }

  if (Number(broadGroup.id) === Number(currentGroupId)) {
    return {
      ok: false,
      reason: `Target agent is not a member of fallback group "${broadGroup.name || BROAD_ASSIGNMENT_GROUP_NAME}"`,
    };
  }

  if (!freshServiceGroupHasAgent(broadGroup, agentId)) {
    return {
      ok: false,
      reason: `Target agent is not a member of fallback group "${broadGroup.name || BROAD_ASSIGNMENT_GROUP_NAME}"`,
    };
  }

  return {
    ok: true,
    group: {
      id: Number(broadGroup.id),
      name: broadGroup.name || BROAD_ASSIGNMENT_GROUP_NAME,
    },
  };
}
