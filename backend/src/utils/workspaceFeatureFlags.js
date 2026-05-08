const SKILL_HIERARCHY_WORKSPACE_IDS = new Set(
  String(process.env.SKILL_HIERARCHY_WORKSPACE_IDS || '1')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isInteger),
);

export function isSkillHierarchyWorkspace(workspaceId) {
  return SKILL_HIERARCHY_WORKSPACE_IDS.has(Number(workspaceId));
}
