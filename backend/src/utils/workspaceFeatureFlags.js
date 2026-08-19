// Workspace feature flags for the category system.
//
// Historically ONE env var — SKILL_HIERARCHY_WORKSPACE_IDS — gated two
// unrelated things at once:
//   1. whether a workspace uses the internal canonical (2-level) category
//      taxonomy for analytics/classification/competency semantics, and
//   2. whether Ticket Pulse mirrors that taxonomy into FreshService (custom
//      objects, lf_ticket_pulse_* custom-field write-back, drift/sync tools).
//
// The Project Accounting rollout (Phase PA, Aug 2026) needs a workspace that
// is canonical WITHOUT any FreshService taxonomy coupling, so the flag is now
// split into two independent sets:
//
//   CANONICAL_CATEGORY_WORKSPACE_IDS  → isCanonicalCategoryWorkspace()
//     "This workspace's category source of truth is the internal
//      competency_categories tree (internalCategoryId/internalSubcategoryId)."
//     Consumed by: ticketCategoryNormalizer (analytics canonical mode),
//     ticketReclassificationService, competencyTools / competencyRepository /
//     competencyAnalysisService / competencyPromptRepository (canonical
//     evidence + hierarchy semantics), assignmentDailyReview* (locked-tree
//     governance rules).
//
//   FS_TAXONOMY_SYNC_WORKSPACE_IDS    → isFsTaxonomySyncWorkspace()
//     "This workspace ALSO mirrors the taxonomy to FreshService."
//     Consumed by: freshServiceActionService (category custom-field
//     write-back), skillHierarchyService (FS objects drift/sync + legacy
//     draft editor), assignment.routes GET /config skillHierarchyEnabled
//     (frontend FS-tools toolbar), priorityBackfillService (legacy rollout
//     scope, kept narrow deliberately).
//
// BACKWARD COMPATIBILITY: while the new env vars are unset, BOTH sets fall
// back to the legacy SKILL_HIERARCHY_WORKSPACE_IDS value (default '1'), so a
// deploy with no env change is behavior-identical to the old single flag.
// Sets are resolved lazily and cached per raw env value so tests (and ops
// tooling) can flip process.env without a module reload.

const LEGACY_ENV = 'SKILL_HIERARCHY_WORKSPACE_IDS';
const LEGACY_DEFAULT = '1';

const cache = new Map();

function resolveSet(primaryEnv) {
  const raw = process.env[primaryEnv] ?? process.env[LEGACY_ENV] ?? LEGACY_DEFAULT;
  const key = `${primaryEnv}|${raw}`;
  let set = cache.get(key);
  if (!set) {
    set = new Set(
      String(raw)
        .split(',')
        .map((value) => Number(value.trim()))
        .filter(Number.isInteger),
    );
    cache.set(key, set);
  }
  return set;
}

/**
 * Canonical-category workspace: analytics + classification + competency
 * machinery treat the internal 2-level taxonomy as the source of truth.
 */
export function isCanonicalCategoryWorkspace(workspaceId) {
  return resolveSet('CANONICAL_CATEGORY_WORKSPACE_IDS').has(Number(workspaceId));
}

/**
 * FS-taxonomy-sync workspace: the canonical taxonomy is additionally mirrored
 * to FreshService (custom objects + lf_ticket_pulse_* field write-back and the
 * drift/sync toolbar). A workspace can be canonical without being FS-synced
 * (Project Accounting is the first such workspace).
 */
export function isFsTaxonomySyncWorkspace(workspaceId) {
  return resolveSet('FS_TAXONOMY_SYNC_WORKSPACE_IDS').has(Number(workspaceId));
}

/**
 * @deprecated Overloaded pre-split gate — kept only for external callers
 * (ops scripts / older tests). Aliases the FS-taxonomy-sync set, which is the
 * stricter of the two and identical to the historical behavior while the new
 * env vars are unset. In-repo services must use one of the named helpers.
 */
export function isSkillHierarchyWorkspace(workspaceId) {
  return isFsTaxonomySyncWorkspace(workspaceId);
}
