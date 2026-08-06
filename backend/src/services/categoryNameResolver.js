import competencyRepository from './competencyRepository.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Category/subcategory BY NAME → internal taxonomy IDs (FR 08-05 #1, Phase 1a).
 *
 * API senders (Power Automate, portals, scripts) know their workspace's
 * category NAMES, not Ticket Pulse's internal IDs — this resolves free-form
 * names case-insensitively against the workspace's ACTIVE taxonomy
 * (CompetencyCategory), modeled on ticketTypeService.normalizeTypeName:
 * a miss throws a ValidationError that lists the allowed values.
 *
 * Contract notes:
 * - A subcategory name is only valid as a CHILD of the resolved category.
 * - Explicit internalCategoryId always wins over names — callers skip this
 *   resolver entirely when an ID was sent.
 * - Inactive (retired) taxonomy rows never match; they're not offered either.
 */

// Keep validation errors readable on large taxonomies: name the first N
// values and summarize the rest.
const MAX_LISTED_NAMES = 30;

export function formatAllowedValues(names, cap = MAX_LISTED_NAMES) {
  if (!names.length) return '(none configured)';
  if (names.length <= cap) return names.join(', ');
  return `${names.slice(0, cap).join(', ')}, …and ${names.length - cap} more`;
}

/**
 * @param {number} workspaceId
 * @param {string|null|undefined} categoryName
 * @param {string|null|undefined} subcategoryName
 * @returns {Promise<{categoryId: number|null, subcategoryId: number|null, categoryName: string|null, subcategoryName: string|null}>}
 *          Canonical (as-stored) names come back alongside the IDs.
 * @throws {ValidationError} on an unknown category, an unknown/wrong-parent
 *         subcategory, or a subcategory without a category.
 */
export async function resolveCategoryNames(workspaceId, categoryName, subcategoryName) {
  const catKey = String(categoryName ?? '').trim().toLowerCase();
  const subKey = String(subcategoryName ?? '').trim().toLowerCase();

  if (!catKey && subKey) {
    throw new ValidationError('A subcategory name requires its parent category name');
  }
  if (!catKey) {
    return { categoryId: null, subcategoryId: null, categoryName: null, subcategoryName: null };
  }

  // One query serves both levels: active rows only, parents (parentId null)
  // and children together.
  const rows = await competencyRepository.getActiveCategories(workspaceId);
  const tops = rows.filter((r) => r.parentId === null);
  const category = tops.find((r) => r.name.trim().toLowerCase() === catKey);
  if (!category) {
    throw new ValidationError(
      `Unknown category "${String(categoryName).trim()}" for this workspace. Valid categories: ${formatAllowedValues(tops.map((t) => t.name))}`,
    );
  }

  if (!subKey) {
    return { categoryId: category.id, subcategoryId: null, categoryName: category.name, subcategoryName: null };
  }

  const children = rows.filter((r) => r.parentId === category.id);
  const subcategory = children.find((r) => r.name.trim().toLowerCase() === subKey);
  if (!subcategory) {
    throw new ValidationError(
      `Unknown subcategory "${String(subcategoryName).trim()}" under "${category.name}". Valid subcategories: ${formatAllowedValues(children.map((c) => c.name))}`,
    );
  }

  return {
    categoryId: category.id,
    subcategoryId: subcategory.id,
    categoryName: category.name,
    subcategoryName: subcategory.name,
  };
}

export default { resolveCategoryNames, formatAllowedValues };
