import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { isSkillHierarchyWorkspace } from '../utils/workspaceFeatureFlags.js';

const DEFAULT_TP_SKILL_FIELD = 'lf_ticket_pulse_category';
const DEFAULT_TP_SUBSKILL_FIELD = 'lf_ticket_pulse_subcategory';
const TP_SKILL_OBJECT_TITLE = 'Ticket Pulse Skills';
const TP_SUBSKILL_OBJECT_TITLE = 'Ticket Pulse Subskills';
const TP_SUBSKILL_PARENT_FIELD = 'parent_skill';
const LEVEL_RANK = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };
function assertSkillHierarchyWorkspace(workspaceId) {
  if (!isSkillHierarchyWorkspace(workspaceId)) {
    throw new ValidationError('The category/subcategory hierarchy editor is not enabled for this workspace');
  }
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function keyFor(value) {
  return normalizeName(value).toLowerCase();
}

function tempId(prefix, name, index) {
  const slug = keyFor(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
  return `${prefix}-${slug}-${index}`;
}

function isPlaceholderName(name) {
  return /^(new\s+)?(top\s+)?(category|subcategory|skill|subskill)(\s+\d+)?$/i.test(normalizeName(name));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeSkillState(input = {}) {
  const sourceSkills = asArray(input.skills || input.categories || input.categoryTree);
  const warnings = [];
  // Name uniqueness is PER PARENT (matching the DB's partial unique indexes):
  // skills dedupe against other skills, subskills against siblings under the
  // same skill. "Quebec" may exist under two different parents.
  const seenSkillNames = new Set();
  const skills = [];

  sourceSkills.forEach((rawSkill, skillIndex) => {
    const name = normalizeName(rawSkill?.name);
    if (!name || isPlaceholderName(name) || rawSkill?.deleted) {
      if (name) warnings.push({ type: 'placeholder_removed', name });
      return;
    }

    const skillKey = keyFor(name);
    if (seenSkillNames.has(skillKey)) {
      warnings.push({ type: 'duplicate_removed', level: 'skill', name });
      return;
    }
    seenSkillNames.add(skillKey);

    const subskills = [];
    const seenSiblingNames = new Set();
    for (const [subIndex, rawSubskill] of asArray(rawSkill.subskills || rawSkill.subcategories || rawSkill.children).entries()) {
      const subName = normalizeName(rawSubskill?.name);
      if (!subName || isPlaceholderName(subName) || rawSubskill?.deleted) {
        if (subName) warnings.push({ type: 'placeholder_removed', name: subName, parent: name });
        continue;
      }
      const subKey = keyFor(subName);
      if (seenSiblingNames.has(subKey)) {
        warnings.push({ type: 'duplicate_removed', level: 'subskill', name: subName, parent: name });
        continue;
      }
      seenSiblingNames.add(subKey);
      subskills.push({
        id: rawSubskill.id || tempId('subskill', subName, subIndex),
        name: subName,
        description: normalizeName(rawSubskill.description || rawSubskill.evidence || ''),
        sortOrder: Number.isFinite(Number(rawSubskill.sortOrder)) ? Number(rawSubskill.sortOrder) : subIndex,
      });
    }

    skills.push({
      id: rawSkill.id || tempId('skill', name, skillIndex),
      name,
      description: normalizeName(rawSkill.description || rawSkill.evidence || ''),
      sortOrder: Number.isFinite(Number(rawSkill.sortOrder)) ? Number(rawSkill.sortOrder) : skillIndex,
      subskills,
    });
  });

  return {
    state: { schemaVersion: 1, skills },
    warnings,
  };
}

function categoryTreeToDraftState(categories = []) {
  return normalizeSkillState({
    skills: categories
      .filter((category) => !category.parentId)
      .map((category) => ({
        id: `category-${category.id}`,
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        subskills: asArray(category.subcategories).map((sub) => ({
          id: `category-${sub.id}`,
          name: sub.name,
          description: sub.description,
          sortOrder: sub.sortOrder,
        })),
      })),
  }).state;
}

function flattenDraftTargets(state) {
  const targets = [];
  for (const skill of asArray(state?.skills)) {
    targets.push({
      tempId: skill.id,
      name: skill.name,
      skillName: skill.name,
      subskillName: null,
      level: 'skill',
    });
    for (const subskill of asArray(skill.subskills)) {
      targets.push({
        tempId: subskill.id,
        name: subskill.name,
        skillName: skill.name,
        subskillName: subskill.name,
        level: 'subskill',
      });
    }
  }
  return targets;
}

function scoreNameMatch(source, target) {
  const sourceKey = keyFor(source);
  const targetKey = keyFor(target);
  if (!sourceKey || !targetKey) return 0;
  if (sourceKey === targetKey) return 1;
  const sourceWords = new Set(sourceKey.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const targetWords = new Set(targetKey.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  if (sourceWords.size === 0 || targetWords.size === 0) return 0;
  const overlap = [...sourceWords].filter((word) => targetWords.has(word)).length;
  return overlap / Math.max(sourceWords.size, targetWords.size);
}

export function buildLegacyMappings(existingCategories = [], draftState = {}) {
  const targets = flattenDraftTargets(draftState);
  return existingCategories.map((category) => {
    let best = null;
    let bestScore = 0;
    for (const target of targets) {
      const score = scoreNameMatch(category.name, target.name);
      if (score > bestScore) {
        best = target;
        bestScore = score;
      }
    }

    const confidence = bestScore === 1 ? 'exact' : bestScore >= 0.5 ? 'weak' : 'unmapped';
    const status = confidence === 'exact' ? 'mapped' : confidence === 'weak' ? 'review' : 'unmapped';
    return {
      legacyCategoryId: category.id,
      legacyName: category.name,
      legacyParentId: category.parentId || null,
      targetSkillTempId: best?.level === 'skill' ? best.tempId : null,
      targetSubskillTempId: best?.level === 'subskill' ? best.tempId : null,
      targetSkillName: best?.skillName || null,
      targetSubskillName: best?.subskillName || null,
      confidence,
      score: Number(bestScore.toFixed(2)),
      status,
    };
  });
}

function pickHighestLevel(a, b) {
  return (LEVEL_RANK[a] || 0) >= (LEVEL_RANK[b] || 0) ? a : b;
}

function choiceNames(field) {
  const choices = field?.choices || field?.choices_data || field?.nested_fields || [];
  if (!Array.isArray(choices)) return [];
  return choices
    .map((choice) => normalizeName(choice?.value || choice?.name || choice?.label || choice))
    .filter(Boolean);
}

function recordName(record) {
  return normalizeName(record?.data?.name || record?.name);
}

function recordNames(records = []) {
  return records
    .map((record) => recordName(record))
    .filter(Boolean);
}

function recordDisplayId(record) {
  const value = record?.data?.bo_display_id ?? record?.bo_display_id ?? record?.display_id ?? record?.id ?? null;
  return value === undefined || value === null || value === '' ? null : Number(value);
}

function lookupRecordId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') {
    const id = value.id;
    if (id && typeof id === 'object' && Object.keys(id).length === 0) return null;
    const candidate = id ?? value.bo_display_id ?? value.display_id ?? value.value ?? null;
    return candidate === undefined || candidate === null || candidate === '' ? null : Number(candidate);
  }
  return Number(value);
}

function lookupRecordLabel(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value.value || value.name || value.label || null;
  return String(value);
}

function recordsByName(records = []) {
  return new Map(records
    .map((record) => [keyFor(recordName(record)), record])
    .filter(([name]) => name));
}

/** All records sharing a (normalized) name. FS custom-object records keep
 *  BARE subskill names, so per-parent duplicate subs ("Quebec" under two
 *  parents) appear as same-named records — callers disambiguate via the
 *  parent_skill lookup field, never by collapsing them into one map slot. */
function groupRecordsByName(records = []) {
  const map = new Map();
  for (const record of records) {
    const key = keyFor(recordName(record));
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(record);
  }
  return map;
}

function recordParentDisplayId(record) {
  return lookupRecordId(record?.data?.[TP_SUBSKILL_PARENT_FIELD]);
}

/**
 * Parent-aware mirror comparison for the subskill custom-lookup object.
 * Published subskills are keyed by (parent skill, name); mirror records
 * resolve their parent through the parent_skill lookup. A record without a
 * resolvable parent satisfies a bare-name match (the parent-drift pass adopts
 * and re-points it) instead of being flagged missing+extra. Counts are
 * consumed one-for-one so per-parent duplicate names reconcile correctly.
 * (Dropdown-choice mirrors stay a flat name-set compare — choices carry no
 * parent, a residual FS-side constraint.)
 */
export function compareSubskillLookupMirror(published, skillRecords = [], subskillRecords = []) {
  const skillKeyByDisplayId = new Map();
  for (const record of skillRecords) {
    const displayId = recordDisplayId(record);
    const nameKey = keyFor(recordName(record));
    if (displayId && nameKey) skillKeyByDisplayId.set(displayId, nameKey);
  }

  const scopedCounts = new Map(); // `${parentKey}\u0000${nameKey}` -> count
  const bareCounts = new Map(); // nameKey -> count (records without a resolvable parent)
  const displayNameByKey = new Map();
  for (const record of subskillRecords) {
    const name = recordName(record);
    const nameKey = keyFor(name);
    if (!nameKey) continue;
    const parentId = recordParentDisplayId(record);
    const parentKey = parentId ? skillKeyByDisplayId.get(parentId) : null;
    const counts = parentKey ? scopedCounts : bareCounts;
    const key = parentKey ? `${parentKey}\u0000${nameKey}` : nameKey;
    counts.set(key, (counts.get(key) || 0) + 1);
    displayNameByKey.set(key, name);
  }

  const missing = [];
  for (const skill of asArray(published?.skills)) {
    for (const subskill of asArray(skill.subskills)) {
      const scopedKey = `${keyFor(skill.name)}\u0000${keyFor(subskill.name)}`;
      if ((scopedCounts.get(scopedKey) || 0) > 0) {
        scopedCounts.set(scopedKey, scopedCounts.get(scopedKey) - 1);
        continue;
      }
      const bareKey = keyFor(subskill.name);
      if ((bareCounts.get(bareKey) || 0) > 0) {
        bareCounts.set(bareKey, bareCounts.get(bareKey) - 1);
        continue;
      }
      missing.push(subskill.name);
    }
  }

  const extra = [];
  for (const [key, count] of [...scopedCounts.entries(), ...bareCounts.entries()]) {
    for (let i = 0; i < count; i += 1) extra.push(displayNameByKey.get(key));
  }
  return { missing, extra };
}

function expectedSubskillParents(published) {
  const expectations = [];
  for (const skill of asArray(published?.skills)) {
    for (const subskill of asArray(skill.subskills)) {
      expectations.push({
        subskill: subskill.name,
        parent: skill.name,
      });
    }
  }
  return expectations;
}

export function buildSubskillParentDrift(published, skillRecords = [], subskillRecords = []) {
  const skillByName = recordsByName(skillRecords);
  const subskillsByName = groupRecordsByName(subskillRecords);
  const missingParent = [];
  const wrongParent = [];
  const unresolved = [];
  const claimed = new Set();

  for (const expected of expectedSubskillParents(published)) {
    const candidates = (subskillsByName.get(keyFor(expected.subskill)) || [])
      .filter((record) => !claimed.has(record));
    const parentRecord = skillByName.get(keyFor(expected.parent));
    if (candidates.length === 0 || !parentRecord) continue;

    const expectedParentId = recordDisplayId(parentRecord);
    if (!expectedParentId) {
      unresolved.push({ subskill: expected.subskill, expectedParent: expected.parent, reason: 'parent_record_has_no_display_id' });
      continue;
    }

    // Same-named records are disambiguated by their parent lookup: an exact
    // parent match means no drift; a parentless record can be adopted
    // (missingParent); a single leftover record is a wrongParent fix; several
    // leftover same-named records are ambiguous — report, never guess.
    const exact = candidates.find((record) => recordParentDisplayId(record) === expectedParentId);
    if (exact) {
      claimed.add(exact);
      continue;
    }
    const subskillRecord = candidates.find((record) => !recordParentDisplayId(record))
      || (candidates.length === 1 ? candidates[0] : null);
    if (!subskillRecord) {
      unresolved.push({ subskill: expected.subskill, expectedParent: expected.parent, reason: 'ambiguous_same_named_records' });
      continue;
    }
    claimed.add(subskillRecord);

    const currentParentId = recordParentDisplayId(subskillRecord);
    const item = {
      subskill: expected.subskill,
      expectedParent: expected.parent,
      expectedParentDisplayId: expectedParentId,
      actualParentDisplayId: currentParentId,
      actualParent: lookupRecordLabel(subskillRecord?.data?.[TP_SUBSKILL_PARENT_FIELD]),
      subskillDisplayId: recordDisplayId(subskillRecord),
    };
    if (!currentParentId) {
      missingParent.push(item);
    } else {
      wrongParent.push(item);
    }
  }

  return { missingParent, wrongParent, unresolved };
}

function fieldIdentity(field) {
  return field?.name || field?.field_name || field?.key || field?.label || null;
}

class SkillHierarchyService {
  async getDraft(workspaceId) {
    assertSkillHierarchyWorkspace(workspaceId);
    const [draft, categories] = await Promise.all([
      prisma.skillHierarchyDraft.findFirst({
        where: { workspaceId, status: 'draft' },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.competencyCategory.findMany({
        where: { workspaceId, isActive: true },
        include: { subcategories: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const published = categoryTreeToDraftState(categories);
    return {
      draft,
      published,
      terminology: { top: 'Category', child: 'Subcategory', topPlural: 'Categories', childPlural: 'Subcategories' },
    };
  }

  async saveDraft(workspaceId, payload = {}, userEmail = null) {
    assertSkillHierarchyWorkspace(workspaceId);
    const { state, warnings } = normalizeSkillState(payload.state || payload);
    if (state.skills.length === 0) throw new ValidationError('Draft must include at least one category');

    const existingCategories = await prisma.competencyCategory.findMany({ where: { workspaceId, isActive: true } });
    const mappings = Array.isArray(payload.mappings) ? payload.mappings : buildLegacyMappings(existingCategories, state);
    const existingDraft = await prisma.skillHierarchyDraft.findFirst({
      where: { workspaceId, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
    });

    const data = {
      state,
      mappings,
      warnings,
      source: payload.source || existingDraft?.source || 'manual',
      updatedBy: userEmail,
    };

    return existingDraft
      ? prisma.skillHierarchyDraft.update({ where: { id: existingDraft.id }, data })
      : prisma.skillHierarchyDraft.create({ data: { ...data, workspaceId, createdBy: userEmail } });
  }

  async importSummit(workspaceId, userEmail = null) {
    assertSkillHierarchyWorkspace(workspaceId);
    const session = await prisma.summitWorkshopSession.findFirst({
      where: { workspaceId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    if (!session) throw new NotFoundError('No summit workshop session found for this workspace');

    const { state, warnings } = normalizeSkillState(session.state);
    if (state.skills.length === 0) throw new ValidationError('Summit session does not contain publishable categories');

    const existingCategories = await prisma.competencyCategory.findMany({ where: { workspaceId, isActive: true } });
    const mappings = buildLegacyMappings(existingCategories, state);
    return prisma.skillHierarchyDraft.create({
      data: {
        workspaceId,
        source: 'summit_workshop',
        state,
        mappings,
        warnings,
        createdBy: userEmail,
        updatedBy: userEmail,
      },
    });
  }

  async getMappings(workspaceId) {
    assertSkillHierarchyWorkspace(workspaceId);
    const draft = await prisma.skillHierarchyDraft.findFirst({
      where: { workspaceId, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
    });
    if (!draft) return { mappings: [], draft: null };
    return { mappings: draft.mappings || [], draft };
  }

  async updateMappings(workspaceId, mappings = [], userEmail = null) {
    assertSkillHierarchyWorkspace(workspaceId);
    if (!Array.isArray(mappings)) throw new ValidationError('mappings must be an array');
    const draft = await prisma.skillHierarchyDraft.findFirst({
      where: { workspaceId, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
    });
    if (!draft) throw new NotFoundError('No editable skill draft found');
    return prisma.skillHierarchyDraft.update({
      where: { id: draft.id },
      data: { mappings, updatedBy: userEmail },
    });
  }

  async publish(workspaceId, userEmail = null) {
    assertSkillHierarchyWorkspace(workspaceId);
    const draft = await prisma.skillHierarchyDraft.findFirst({
      where: { workspaceId, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
    });
    if (!draft) throw new NotFoundError('No editable skill draft found');

    const { state, warnings } = normalizeSkillState(draft.state);
    if (state.skills.length === 0) throw new ValidationError('Draft must include at least one category');

    const mappings = Array.isArray(draft.mappings) ? draft.mappings : [];
    const unresolvedMappings = mappings.filter((mapping) => (
      mapping.status !== 'mapped'
      || (!mapping.targetSkillTempId && !mapping.targetSubskillTempId)
    ));
    if (unresolvedMappings.length > 0) {
      throw new ValidationError(`Resolve ${unresolvedMappings.length} legacy category mappings before publishing`);
    }

    return prisma.$transaction(async (tx) => {
      const current = await tx.competencyCategory.findMany({
        where: { workspaceId },
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      });
      // Rows are matched by PARENT-SCOPED name (parents keyed separately from
      // children, \u0000 separator) so same-named subs under different parents
      // resolve to their own rows. A unique bare-name fallback preserves the
      // old promote/move-across-parents behavior when it is unambiguous.
      const topKeyOf = (name) => `\u0000${keyFor(name)}`;
      const childKeyOf = (parentId, name) => `${parentId}\u0000${keyFor(name)}`;
      const currentByScopedKey = new Map();
      const currentByBareName = new Map();
      for (const category of current) {
        currentByScopedKey.set(
          category.parentId ? childKeyOf(category.parentId, category.name) : topKeyOf(category.name),
          category,
        );
        const bareKey = keyFor(category.name);
        if (!currentByBareName.has(bareKey)) currentByBareName.set(bareKey, []);
        currentByBareName.get(bareKey).push(category);
      }
      const targetByTempId = new Map();
      const targetIds = new Set();
      const uniqueBareMatch = (name, excludeId = null) => {
        const rows = (currentByBareName.get(keyFor(name)) || [])
          .filter((row) => row.id !== excludeId && !targetIds.has(row.id));
        return rows.length === 1 ? rows[0] : null;
      };

      for (const [skillIndex, skill] of state.skills.entries()) {
        let skillRow = currentByScopedKey.get(topKeyOf(skill.name)) || uniqueBareMatch(skill.name);
        if (skillRow) {
          skillRow = await tx.competencyCategory.update({
            where: { id: skillRow.id },
            data: {
              parentId: null,
              description: skill.description || null,
              isActive: true,
              source: 'skill_hierarchy_publish',
              sortOrder: Number.isFinite(Number(skill.sortOrder)) ? Number(skill.sortOrder) : skillIndex,
            },
          });
        } else {
          skillRow = await tx.competencyCategory.create({
            data: {
              workspaceId,
              parentId: null,
              name: skill.name,
              description: skill.description || null,
              source: 'skill_hierarchy_publish',
              sortOrder: Number.isFinite(Number(skill.sortOrder)) ? Number(skill.sortOrder) : skillIndex,
            },
          });
        }
        targetIds.add(skillRow.id);
        targetByTempId.set(skill.id, { skillId: skillRow.id, subskillId: null, skillName: skillRow.name, subskillName: null });

        for (const [subIndex, subskill] of asArray(skill.subskills).entries()) {
          let subRow = currentByScopedKey.get(childKeyOf(skillRow.id, subskill.name))
            || uniqueBareMatch(subskill.name, skillRow.id);
          if (subRow) {
            subRow = await tx.competencyCategory.update({
              where: { id: subRow.id },
              data: {
                parentId: skillRow.id,
                description: subskill.description || null,
                isActive: true,
                source: 'skill_hierarchy_publish',
                sortOrder: Number.isFinite(Number(subskill.sortOrder)) ? Number(subskill.sortOrder) : subIndex,
              },
            });
          } else {
            subRow = await tx.competencyCategory.create({
              data: {
                workspaceId,
                parentId: skillRow.id,
                name: subskill.name,
                description: subskill.description || null,
                source: 'skill_hierarchy_publish',
                sortOrder: Number.isFinite(Number(subskill.sortOrder)) ? Number(subskill.sortOrder) : subIndex,
              },
            });
          }
          targetIds.add(subRow.id);
          targetByTempId.set(subskill.id, {
            skillId: skillRow.id,
            subskillId: subRow.id,
            skillName: skillRow.name,
            subskillName: subRow.name,
          });
        }
      }

      let remappedCompetencies = 0;
      let remappedTickets = 0;
      for (const mapping of mappings) {
        const legacyId = Number(mapping.legacyCategoryId);
        if (!Number.isInteger(legacyId)) continue;
        const target = targetByTempId.get(mapping.targetSubskillTempId) || targetByTempId.get(mapping.targetSkillTempId);
        const targetId = target?.subskillId || target?.skillId;
        if (!targetId || legacyId === targetId) continue;

        const oldRows = await tx.technicianCompetency.findMany({ where: { workspaceId, competencyCategoryId: legacyId } });
        for (const oldRow of oldRows) {
          const existing = await tx.technicianCompetency.findUnique({
            where: { technicianId_competencyCategoryId: { technicianId: oldRow.technicianId, competencyCategoryId: targetId } },
          });
          if (existing) {
            const highest = pickHighestLevel(existing.proficiencyLevel, oldRow.proficiencyLevel);
            if (highest !== existing.proficiencyLevel) {
              await tx.technicianCompetency.update({ where: { id: existing.id }, data: { proficiencyLevel: highest } });
            }
            await tx.technicianCompetency.delete({ where: { id: oldRow.id } });
          } else {
            await tx.technicianCompetency.update({ where: { id: oldRow.id }, data: { competencyCategoryId: targetId } });
          }
          remappedCompetencies += 1;
        }

        const subRemap = await tx.ticket.updateMany({
          where: { workspaceId, internalSubcategoryId: legacyId },
          data: { internalCategoryId: target.skillId, internalSubcategoryId: target.subskillId },
        });
        const topRemap = await tx.ticket.updateMany({
          where: { workspaceId, internalCategoryId: legacyId, internalSubcategoryId: null },
          data: { internalCategoryId: target.skillId, internalSubcategoryId: target.subskillId },
        });
        remappedTickets += subRemap.count + topRemap.count;
      }

      const retired = await tx.competencyCategory.updateMany({
        where: { workspaceId, isActive: true, id: { notIn: [...targetIds] } },
        data: { isActive: false, source: 'skill_hierarchy_retired' },
      });

      const published = await tx.skillHierarchyDraft.update({
        where: { id: draft.id },
        data: {
          status: 'published',
          state,
          warnings,
          updatedBy: userEmail,
          publishedAt: new Date(),
        },
      });

      return {
        draft: published,
        skillCount: state.skills.length,
        subskillCount: state.skills.reduce((sum, skill) => sum + asArray(skill.subskills).length, 0),
        retiredCount: retired.count,
        remappedCompetencies,
        remappedTickets,
      };
    });
  }

  async getFreshserviceFields(workspaceId) {
    assertSkillHierarchyWorkspace(workspaceId);
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
      priority: 'normal',
      source: 'skill-field-discovery',
    });
    const fields = await client.listTicketFormFields({ workspace_id: fsConfig.workspaceId });
    const objects = await client.listCustomObjects({ workspace_id: fsConfig.workspaceId });
    const configured = {
      legacyCategoryCustomField: fsConfig.categoryCustomField || 'security',
      tpSkillCustomField: fsConfig.tpSkillCustomField || DEFAULT_TP_SKILL_FIELD,
      tpSubskillCustomField: fsConfig.tpSubskillCustomField || DEFAULT_TP_SUBSKILL_FIELD,
    };
    const byName = new Map(fields.map((field) => [fieldIdentity(field), field]).filter(([name]) => name));
    const byTitle = new Map(objects.map((object) => [object.title, object]));
    return {
      configured,
      fields,
      objects,
      found: {
        legacyCategory: byName.get(configured.legacyCategoryCustomField) || null,
        skill: byName.get(configured.tpSkillCustomField) || null,
        subskill: byName.get(configured.tpSubskillCustomField) || null,
        skillObject: byTitle.get(TP_SKILL_OBJECT_TITLE) || null,
        subskillObject: byTitle.get(TP_SUBSKILL_OBJECT_TITLE) || null,
      },
    };
  }

  async getFreshserviceDrift(workspaceId) {
    assertSkillHierarchyWorkspace(workspaceId);
    const [categories, fieldReport] = await Promise.all([
      prisma.competencyCategory.findMany({
        where: { workspaceId, isActive: true },
        include: { subcategories: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.getFreshserviceFields(workspaceId),
    ]);

    const published = categoryTreeToDraftState(categories);
    const skillNames = published.skills.map((skill) => skill.name);
    const subskillNames = published.skills.flatMap((skill) => skill.subskills.map((subskill) => subskill.name));
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
      priority: 'normal',
      source: 'skill-field-drift',
    });
    const [skillRecords, subskillRecords] = await Promise.all([
      fieldReport.found.skillObject?.id ? client.listCustomObjectRecords(fieldReport.found.skillObject.id) : Promise.resolve([]),
      fieldReport.found.subskillObject?.id ? client.listCustomObjectRecords(fieldReport.found.subskillObject.id) : Promise.resolve([]),
    ]);
    const fsSkillNames = fieldReport.found.skill?.field_type === 'custom_lookup'
      ? recordNames(skillRecords)
      : choiceNames(fieldReport.found.skill);
    const fsSubskillNames = fieldReport.found.subskill?.field_type === 'custom_lookup'
      ? recordNames(subskillRecords)
      : choiceNames(fieldReport.found.subskill);
    const compare = (source, mirror) => {
      const sourceSet = new Set(source.map(keyFor));
      const mirrorSet = new Set(mirror.map(keyFor));
      return {
        missing: source.filter((name) => !mirrorSet.has(keyFor(name))),
        extra: mirror.filter((name) => !sourceSet.has(keyFor(name))),
      };
    };
    const skillDrift = compare(skillNames, fsSkillNames);
    // Subskill names are only unique PER PARENT — for lookup-object mirrors,
    // compare by (parent, name) so same-named siblings reconcile; flat
    // dropdown choices can't carry a parent, so they keep the name-set compare.
    const subskillDrift = fieldReport.found.subskill?.field_type === 'custom_lookup'
      ? compareSubskillLookupMirror(published, skillRecords, subskillRecords)
      : compare(subskillNames, fsSubskillNames);
    const subskillParentDrift = fieldReport.found.skill?.field_type === 'custom_lookup'
      && fieldReport.found.subskill?.field_type === 'custom_lookup'
      ? buildSubskillParentDrift(published, skillRecords, subskillRecords)
      : { missingParent: [], wrongParent: [], unresolved: [] };
    const csv = (names) => ['value', ...names.map((name) => `"${String(name).replace(/"/g, '""')}"`)].join('\n');

    return {
      configured: fieldReport.configured,
      fieldsFound: fieldReport.found,
      objectRecords: {
        skills: skillRecords.length,
        subskills: subskillRecords.length,
      },
      published,
      skillDrift,
      subskillDrift,
      subskillParentDrift,
      exports: {
        skillCsv: csv(skillNames),
        subskillCsv: csv(subskillNames),
        skillText: skillNames.join('\n'),
        subskillText: subskillNames.join('\n'),
        hierarchyText: published.skills
          .map((skill) => [skill.name, ...skill.subskills.map((subskill) => `  - ${subskill.name}`)].join('\n'))
          .join('\n'),
      },
    };
  }

  async syncFreshserviceObjects(workspaceId, options = {}) {
    assertSkillHierarchyWorkspace(workspaceId);
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
      priority: 'normal',
      source: 'skill-object-sync',
    });
    const [categories, objects] = await Promise.all([
      prisma.competencyCategory.findMany({
        where: { workspaceId, isActive: true },
        include: { subcategories: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
      client.listCustomObjects({ workspace_id: fsConfig.workspaceId }),
    ]);
    const byTitle = new Map(objects.map((object) => [object.title, object]));
    const skillObject = byTitle.get(TP_SKILL_OBJECT_TITLE);
    const subskillObject = byTitle.get(TP_SUBSKILL_OBJECT_TITLE);
    if (!skillObject || !subskillObject) {
      throw new ValidationError('Ticket Pulse custom objects must exist in Freshservice before syncing records');
    }

    const published = categoryTreeToDraftState(categories);
    const skillNames = published.skills.map((skill) => skill.name);
    const subskillTargets = expectedSubskillParents(published);
    let [skillRecords, subskillRecords] = await Promise.all([
      client.listCustomObjectRecords(skillObject.id),
      client.listCustomObjectRecords(subskillObject.id),
    ]);
    const beforeCounts = { skills: skillRecords.length, subskills: subskillRecords.length };
    const existingSkills = new Set(recordNames(skillRecords).map(keyFor));

    const createdSkills = [];
    for (const name of skillNames) {
      if (!existingSkills.has(keyFor(name))) {
        await client.createCustomObjectRecord(skillObject.id, { name });
        existingSkills.add(keyFor(name));
        createdSkills.push(name);
      }
    }

    if (createdSkills.length > 0) {
      skillRecords = await client.listCustomObjectRecords(skillObject.id);
    }

    const skillByName = recordsByName(skillRecords);
    // Records keep BARE subskill names in FS (per-parent duplicates look
    // identical in the FS UI — a residual FS-side constraint), so "already
    // exists" is judged per (parent, name): an exact parent match counts, a
    // parentless record is adopted (the parent-drift pass below re-points
    // it), and each record satisfies at most one expected subskill.
    const subskillsByName = groupRecordsByName(subskillRecords);
    const claimedRecords = new Set();
    const createdSubskills = [];
    for (const { subskill: name, parent } of subskillTargets) {
      const parentRecord = skillByName.get(keyFor(parent));
      const parentDisplayId = recordDisplayId(parentRecord);
      if (!parentDisplayId) {
        throw new ValidationError(`Freshservice parent skill lookup record not found for "${parent}"`);
      }
      const candidates = (subskillsByName.get(keyFor(name)) || [])
        .filter((record) => !claimedRecords.has(record));
      const match = candidates.find((record) => recordParentDisplayId(record) === parentDisplayId)
        || candidates.find((record) => !recordParentDisplayId(record))
        || (candidates.length === 1 ? candidates[0] : null);
      if (match) {
        claimedRecords.add(match);
        continue;
      }
      await client.createCustomObjectRecord(subskillObject.id, {
        name,
        [TP_SUBSKILL_PARENT_FIELD]: parentDisplayId,
      });
      createdSubskills.push({ name, parent });
    }

    if (createdSubskills.length > 0) {
      subskillRecords = await client.listCustomObjectRecords(subskillObject.id);
    }

    const parentDrift = buildSubskillParentDrift(published, skillRecords, subskillRecords);
    const updatedSubskillParents = [];
    for (const item of [...parentDrift.missingParent, ...parentDrift.wrongParent]) {
      await client.updateCustomObjectRecord(subskillObject.id, item.subskillDisplayId, {
        name: item.subskill,
        [TP_SUBSKILL_PARENT_FIELD]: item.expectedParentDisplayId,
      });
      updatedSubskillParents.push({
        name: item.subskill,
        parent: item.expectedParent,
        previousParent: item.actualParent || item.actualParentDisplayId || null,
      });
    }

    return {
      skillObject,
      subskillObject,
      expected: { skills: skillNames.length, subskills: subskillTargets.length },
      before: beforeCounts,
      created: { skills: createdSkills, subskills: createdSubskills },
      updated: { subskillParents: updatedSubskillParents },
      parentDrift: {
        unresolved: parentDrift.unresolved,
        fixedMissingParent: parentDrift.missingParent.length,
        fixedWrongParent: parentDrift.wrongParent.length,
      },
      deleteExtra: Boolean(options.deleteExtra),
      note: 'Sync creates missing custom object records and fixes subskill parent lookups; extra records are reported by drift and not deleted automatically.',
    };
  }
}

export default new SkillHierarchyService();
