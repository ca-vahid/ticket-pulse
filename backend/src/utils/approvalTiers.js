/**
 * Approvals v2 — pure helpers shared by the category, approval and ticket
 * services (kept out of approvalCategoryService.js so route tests that stub
 * that module keep working).
 */
export const MAX_TIERS = 3;

/**
 * Effective tier chain for a category row: the stored `tiers` when present,
 * else one tier from managerEmails (pre-v2 categories). Always >= 1 entry
 * (possibly with an empty manager list — the caller validates).
 */
export function categoryTiers(category) {
  const stored = Array.isArray(category?.tiers) ? category.tiers : null;
  if (stored && stored.length > 0) {
    return stored.map((t, i) => ({
      name: String(t?.name || '').trim() || `Tier ${i + 1}`,
      managerEmails: Array.isArray(t?.managerEmails) ? t.managerEmails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean) : [],
      limit: t?.limit === null || t?.limit === undefined || t?.limit === '' ? null : Number(t.limit),
    }));
  }
  return [{ name: 'Tier 1', managerEmails: (category?.managerEmails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean), limit: null }];
}
