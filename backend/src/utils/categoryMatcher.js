/**
 * Fuzzy category matching utility.
 * Prevents near-duplicate competency categories by finding the best existing match.
 */

const SYNONYM_GROUPS = [
  ['a/v', 'av', 'audio visual', 'audio/visual', 'audiovisual'],
  ['mfa', 'multi-factor authentication', 'multi factor authentication', '2fa', 'two-factor'],
  ['setup', 'configuration', 'config', 'provisioning'],
  ['vpn', 'remote access', 'remote connectivity'],
  ['pc', 'computer', 'workstation', 'desktop', 'laptop', 'hardware'],
  ['phone', 'telephony', 'pbx', 'mobile'],
  ['wifi', 'wi-fi', 'wireless'],
  ['printer', 'printers', 'printing'],
  ['peripheral', 'peripherals'],
  ['monitor', 'display', 'screen'],
  ['onboard', 'onboarding', 'new hire'],
  ['offboard', 'offboarding', 'departure', 'termination'],
  ['script', 'scripting', 'automation'],
  ['security', 'incident', 'threat', 'alert', 'phishing', 'spam'],
  ['devops', 'dev ops', 'ci/cd', 'pipeline'],
  ['sharepoint', 'coreshack'],
  ['license', 'licensing'],
  ['order', 'purchase', 'procurement'],
];

const STOP_WORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'in', 'on', 'to', 'with',
  'is', 'it', 'its', 'by', '&', '/', '-', 'client', 'server', 'system',
  'support', 'management', 'service', 'services', 'tasks', 'update', 'updates',
  'response', 'alert', 'tool', 'tools', 'application', 'applications',
  'hardware', 'software', 'infrastructure', 'general',
]);

function normalize(name) {
  return (name || '').trim().replace(/\s+/g, ' ');
}

function tokenize(name) {
  return normalize(name)
    .toLowerCase()
    .replace(/[&/\-(),.]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function significantTokens(name) {
  return tokenize(name).filter((w) => !STOP_WORDS.has(w));
}

function getSynonymGroup(word) {
  const lower = word.toLowerCase();
  return SYNONYM_GROUPS.find((group) => group.includes(lower));
}

function wordsAreSynonyms(a, b) {
  if (a === b) return true;
  const groupA = getSynonymGroup(a);
  const groupB = getSynonymGroup(b);
  if (groupA && groupB && groupA === groupB) return true;
  if (groupA && groupA.includes(b)) return true;
  if (groupB && groupB.includes(a)) return true;
  return false;
}

/**
 * Calculate word overlap score between two category names.
 * Returns 0.0 to 1.0 where 1.0 means all significant words match.
 */
function wordOverlapScore(nameA, nameB) {
  const tokensA = significantTokens(nameA);
  const tokensB = significantTokens(nameB);

  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  let matchCount = 0;
  const usedB = new Set();

  for (const a of tokensA) {
    for (let i = 0; i < tokensB.length; i++) {
      if (usedB.has(i)) continue;
      if (wordsAreSynonyms(a, tokensB[i]) || a.startsWith(tokensB[i]) || tokensB[i].startsWith(a)) {
        matchCount++;
        usedB.add(i);
        break;
      }
    }
  }

  const maxLen = Math.max(tokensA.length, tokensB.length);
  return matchCount / maxLen;
}

/**
 * Check if one name contains the other (after normalization).
 */
function containmentMatch(nameA, nameB) {
  const a = normalize(nameA).toLowerCase();
  const b = normalize(nameB).toLowerCase();
  return a.includes(b) || b.includes(a);
}

/**
 * Find the best matching existing category for a proposed name.
 *
 * @param {string} proposedName - The category name being proposed
 * @param {Array<{id: number, name: string}>} existingCategories - Existing categories
 * @param {number} [threshold=0.7] - Minimum word overlap score to consider a match
 * @returns {{ match: object|null, score: number, reason: string }}
 */
export function findBestCategoryMatch(proposedName, existingCategories, threshold = 0.7) {
  const normalizedProposed = normalize(proposedName);
  if (!normalizedProposed) return { match: null, score: 0, reason: 'empty_name' };

  let bestMatch = null;
  let bestScore = 0;
  let bestReason = 'no_match';

  for (const existing of existingCategories) {
    const normalizedExisting = normalize(existing.name);

    // Rule 1: Exact match (case-insensitive)
    if (normalizedProposed.toLowerCase() === normalizedExisting.toLowerCase()) {
      return { match: existing, score: 1.0, reason: 'exact_match' };
    }

    // Rule 2: Containment match
    if (containmentMatch(normalizedProposed, normalizedExisting)) {
      if (bestScore < 0.95) {
        bestMatch = existing;
        bestScore = 0.95;
        bestReason = 'containment_match';
      }
      continue;
    }

    // Rule 3: Word overlap with synonym awareness
    const overlap = wordOverlapScore(normalizedProposed, normalizedExisting);
    if (overlap >= threshold && overlap > bestScore) {
      bestMatch = existing;
      bestScore = overlap;
      bestReason = `word_overlap_${Math.round(overlap * 100)}pct`;
    }
  }

  return { match: bestMatch, score: bestScore, reason: bestReason };
}

/**
 * Find all duplicate groups among a list of categories.
 * Returns groups of 2+ categories that appear to be duplicates.
 *
 * @param {Array<{id: number, name: string}>} categories
 * @param {number} [threshold=0.7]
 * @returns {Array<{ keepId: number, keepName: string, duplicates: Array<{id: number, name: string, score: number, reason: string}> }>}
 */
export function findDuplicateGroups(categories, threshold = 0.7) {
  const groups = [];
  const consumed = new Set();

  for (let i = 0; i < categories.length; i++) {
    if (consumed.has(categories[i].id)) continue;

    const duplicates = [];
    for (let j = i + 1; j < categories.length; j++) {
      if (consumed.has(categories[j].id)) continue;

      const { score, reason } = findBestCategoryMatch(
        categories[j].name,
        [categories[i]],
        threshold,
      );

      if (score >= threshold) {
        duplicates.push({
          id: categories[j].id,
          name: categories[j].name,
          score,
          reason,
        });
        consumed.add(categories[j].id);
      }
    }

    if (duplicates.length > 0) {
      consumed.add(categories[i].id);
      groups.push({
        keepId: categories[i].id,
        keepName: categories[i].name,
        duplicates,
      });
    }
  }

  return groups;
}
