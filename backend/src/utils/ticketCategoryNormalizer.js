// Flag-split assignment (Phase PA): analytics/category mode is the defining
// consumer of the CANONICAL set — it decides whether internalCategoryId or the
// legacy ticketCategory string is the workspace's source of truth.
import { isCanonicalCategoryWorkspace } from './workspaceFeatureFlags.js';

export function getCategoryMode(workspaceId) {
  return isCanonicalCategoryWorkspace(workspaceId) ? 'canonical' : 'legacy';
}

export function normalizeTicketCategory(ticket, workspaceId) {
  const mode = getCategoryMode(workspaceId);

  if (mode === 'legacy') {
    const label = ticket?.ticketCategory || null;
    return {
      categoryMode: 'legacy',
      categoryId: null,
      subcategoryId: null,
      categoryName: label,
      subcategoryName: null,
      categoryLabel: label,
      categorySource: label ? 'legacy' : 'unmapped',
      legacyCategory: label,
      taxonomyReviewNeeded: Boolean(ticket?.taxonomyReviewNeeded),
    };
  }

  // Self-heal: if the top category is missing but the subcategory relation is
  // loaded, derive the parent from it. A bare category delete once orphaned
  // 4.4k tickets into per-subcategory "Uncategorized" islands on the category
  // map — deletes are guarded now, but analytics shouldn't fracture on data
  // that arrives broken.
  const categoryId = ticket?.internalCategoryId
    ?? ticket?.internalCategory?.id
    ?? ticket?.internalSubcategory?.parentId
    ?? null;
  const subcategoryId = ticket?.internalSubcategoryId ?? ticket?.internalSubcategory?.id ?? null;
  const categoryName = ticket?.internalCategory?.name
    || ticket?.internalSubcategory?.parent?.name
    || null;
  const subcategoryName = ticket?.internalSubcategory?.name || null;

  if (categoryId || subcategoryId || categoryName || subcategoryName) {
    const safeCategoryName = categoryName || ticket?.tpSkill || null;
    const safeSubcategoryName = subcategoryName || ticket?.tpSubskill || null;
    return {
      categoryMode: 'canonical',
      categoryId,
      subcategoryId,
      categoryName: safeCategoryName,
      subcategoryName: safeSubcategoryName,
      categoryLabel: [safeCategoryName, safeSubcategoryName].filter(Boolean).join(' / ') || null,
      categorySource: 'canonical',
      legacyCategory: ticket?.ticketCategory || null,
      taxonomyReviewNeeded: Boolean(ticket?.taxonomyReviewNeeded),
    };
  }

  const fallbackCategory = ticket?.tpSkill || ticket?.ticketCategory || null;
  const fallbackSubcategory = ticket?.tpSubskill || null;
  const fallbackLabel = [fallbackCategory, fallbackSubcategory].filter(Boolean).join(' / ') || null;

  return {
    categoryMode: 'canonical',
    categoryId: null,
    subcategoryId: null,
    categoryName: fallbackCategory,
    subcategoryName: fallbackSubcategory,
    categoryLabel: fallbackLabel,
    categorySource: fallbackLabel ? 'legacyFallback' : 'unmapped',
    legacyCategory: ticket?.ticketCategory || null,
    taxonomyReviewNeeded: Boolean(ticket?.taxonomyReviewNeeded),
  };
}

export function buildTicketCategoryAliases(ticket, workspaceId) {
  const normalized = normalizeTicketCategory(ticket, workspaceId);
  return {
    ...normalized,
    skill: normalized.categoryName,
    subskill: normalized.subcategoryName,
    canonicalSkill: normalized.categoryLabel,
    canonicalCategory: normalized.categoryLabel,
  };
}
