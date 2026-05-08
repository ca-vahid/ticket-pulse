import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const DEFAULT_TP_SKILL_FIELD = 'tp_skill';
const DEFAULT_TP_SUBSKILL_FIELD = 'tp_subskill';
const LEVEL_RANK = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };

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
  const seenNames = new Set();
  const skills = [];

  sourceSkills.forEach((rawSkill, skillIndex) => {
    const name = normalizeName(rawSkill?.name);
    if (!name || isPlaceholderName(name) || rawSkill?.deleted) {
      if (name) warnings.push({ type: 'placeholder_removed', name });
      return;
    }

    const skillKey = keyFor(name);
    if (seenNames.has(skillKey)) {
      warnings.push({ type: 'duplicate_removed', level: 'skill', name });
      return;
    }
    seenNames.add(skillKey);

    const subskills = [];
    for (const [subIndex, rawSubskill] of asArray(rawSkill.subskills || rawSkill.subcategories || rawSkill.children).entries()) {
      const subName = normalizeName(rawSubskill?.name);
      if (!subName || isPlaceholderName(subName) || rawSubskill?.deleted) {
        if (subName) warnings.push({ type: 'placeholder_removed', name: subName, parent: name });
        continue;
      }
      const subKey = keyFor(subName);
      if (seenNames.has(subKey)) {
        warnings.push({ type: 'duplicate_removed', level: 'subskill', name: subName, parent: name });
        continue;
      }
      seenNames.add(subKey);
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

function fieldIdentity(field) {
  return field?.name || field?.field_name || field?.key || field?.label || null;
}

class SkillHierarchyService {
  async getDraft(workspaceId) {
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
      terminology: { top: 'Skill', child: 'Subskill', topPlural: 'Skills', childPlural: 'Subskills' },
    };
  }

  async saveDraft(workspaceId, payload = {}, userEmail = null) {
    const { state, warnings } = normalizeSkillState(payload.state || payload);
    if (state.skills.length === 0) throw new ValidationError('Draft must include at least one skill');

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
    const session = await prisma.summitWorkshopSession.findFirst({
      where: { workspaceId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    if (!session) throw new NotFoundError('No summit workshop session found for this workspace');

    const { state, warnings } = normalizeSkillState(session.state);
    if (state.skills.length === 0) throw new ValidationError('Summit session does not contain publishable skills');

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
    const draft = await prisma.skillHierarchyDraft.findFirst({
      where: { workspaceId, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
    });
    if (!draft) return { mappings: [], draft: null };
    return { mappings: draft.mappings || [], draft };
  }

  async updateMappings(workspaceId, mappings = [], userEmail = null) {
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
    const draft = await prisma.skillHierarchyDraft.findFirst({
      where: { workspaceId, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
    });
    if (!draft) throw new NotFoundError('No editable skill draft found');

    const { state, warnings } = normalizeSkillState(draft.state);
    if (state.skills.length === 0) throw new ValidationError('Draft must include at least one skill');

    const mappings = Array.isArray(draft.mappings) ? draft.mappings : [];
    return prisma.$transaction(async (tx) => {
      const current = await tx.competencyCategory.findMany({
        where: { workspaceId },
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      });
      const currentByName = new Map(current.map((category) => [keyFor(category.name), category]));
      const targetByTempId = new Map();
      const targetIds = new Set();

      for (const [skillIndex, skill] of state.skills.entries()) {
        let skillRow = currentByName.get(keyFor(skill.name));
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
          let subRow = currentByName.get(keyFor(subskill.name));
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
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
      priority: 'normal',
      source: 'skill-field-discovery',
    });
    const fields = await client.listTicketFormFields({ workspace_id: fsConfig.workspaceId });
    const configured = {
      legacyCategoryCustomField: fsConfig.categoryCustomField || 'security',
      tpSkillCustomField: fsConfig.tpSkillCustomField || DEFAULT_TP_SKILL_FIELD,
      tpSubskillCustomField: fsConfig.tpSubskillCustomField || DEFAULT_TP_SUBSKILL_FIELD,
    };
    const byName = new Map(fields.map((field) => [fieldIdentity(field), field]).filter(([name]) => name));
    return {
      configured,
      fields,
      found: {
        legacyCategory: byName.get(configured.legacyCategoryCustomField) || null,
        skill: byName.get(configured.tpSkillCustomField) || null,
        subskill: byName.get(configured.tpSubskillCustomField) || null,
      },
    };
  }

  async getFreshserviceDrift(workspaceId) {
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
    const fsSkillNames = choiceNames(fieldReport.found.skill);
    const fsSubskillNames = choiceNames(fieldReport.found.subskill);
    const compare = (source, mirror) => {
      const sourceSet = new Set(source.map(keyFor));
      const mirrorSet = new Set(mirror.map(keyFor));
      return {
        missing: source.filter((name) => !mirrorSet.has(keyFor(name))),
        extra: mirror.filter((name) => !sourceSet.has(keyFor(name))),
      };
    };
    const skillDrift = compare(skillNames, fsSkillNames);
    const subskillDrift = compare(subskillNames, fsSubskillNames);
    const csv = (names) => ['value', ...names.map((name) => `"${String(name).replace(/"/g, '""')}"`)].join('\n');

    return {
      configured: fieldReport.configured,
      fieldsFound: fieldReport.found,
      published,
      skillDrift,
      subskillDrift,
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
}

export default new SkillHierarchyService();
