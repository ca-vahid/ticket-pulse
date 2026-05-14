import { randomUUID } from 'node:crypto';
import prisma from './prisma.js';
import competencyRepository from './competencyRepository.js';
import { AuthenticationError, NotFoundError, ValidationError } from '../utils/errors.js';

export const SELF_SERVICE_LEVELS = ['basic', 'intermediate', 'advanced', 'expert'];
export const SELF_SERVICE_LEVEL_ORDER = {
  '': 0,
  basic: 1,
  intermediate: 2,
  advanced: 3,
  expert: 4,
};
const MAX_BULK_COMPETENCY_REQUESTS = 50;
let competencyRequestGroupsSupportedPromise = null;

const COMPETENCY_REQUEST_SELECT = {
  id: true,
  workspaceId: true,
  technicianId: true,
  competencyCategoryId: true,
  requestType: true,
  currentLevel: true,
  requestedLevel: true,
  note: true,
  status: true,
  requestedByEmail: true,
  reviewedByEmail: true,
  reviewedAt: true,
  decisionNote: true,
  appliedAt: true,
  createdAt: true,
  updatedAt: true,
};

function competencyRequestSelect({ supportsRequestGroups, include = {} } = {}) {
  return {
    ...COMPETENCY_REQUEST_SELECT,
    ...(supportsRequestGroups ? { requestGroupId: true } : {}),
    ...include,
  };
}

async function supportsCompetencyRequestGroups() {
  if (!competencyRequestGroupsSupportedPromise) {
    competencyRequestGroupsSupportedPromise = prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'competency_change_requests'
          AND column_name = 'request_group_id'
      ) AS "exists"
    `.then((rows) => Boolean(rows?.[0]?.exists)).catch(() => false);
  }
  return competencyRequestGroupsSupportedPromise;
}

function maybeWithRequestGroupId(data, requestGroupId, supportsRequestGroups) {
  return supportsRequestGroups ? { ...data, requestGroupId } : data;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeLevel(level, { allowEmpty = true } = {}) {
  const value = String(level || '').trim().toLowerCase();
  if (!value && allowEmpty) return null;
  if (SELF_SERVICE_LEVELS.includes(value)) return value;
  throw new ValidationError('Invalid competency level');
}

function requestTypeFor(currentLevel, requestedLevel) {
  const currentRank = SELF_SERVICE_LEVEL_ORDER[currentLevel || ''] || 0;
  const requestedRank = SELF_SERVICE_LEVEL_ORDER[requestedLevel || ''] || 0;
  if (currentRank === 0 && requestedRank > 0) return 'add';
  if (requestedRank === 0) return 'remove';
  if (requestedRank > currentRank) return 'increase';
  return 'decrease';
}

function normalizeNote(note) {
  return String(note || '').trim().slice(0, 2000) || null;
}

function normalizeBulkChangeItems(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('requests must include at least one skill');
  }
  if (items.length > MAX_BULK_COMPETENCY_REQUESTS) {
    throw new ValidationError(`Submit ${MAX_BULK_COMPETENCY_REQUESTS} or fewer skills at a time`);
  }

  const byCategory = new Map();
  for (const item of items) {
    const competencyCategoryId = Number(item?.competencyCategoryId);
    if (!Number.isInteger(competencyCategoryId)) {
      throw new ValidationError('Each request must include competencyCategoryId');
    }
    byCategory.set(competencyCategoryId, {
      competencyCategoryId,
      requestedLevel: normalizeLevel(item?.requestedLevel, { allowEmpty: false }),
    });
  }

  return Array.from(byCategory.values());
}

async function getAgentTechnicians(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  return prisma.technician.findMany({
    where: {
      email: { equals: normalized, mode: 'insensitive' },
      isActive: true,
      workspace: { isActive: true },
    },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true, defaultTimezone: true },
      },
    },
    orderBy: [{ workspaceId: 'asc' }, { name: 'asc' }],
  });
}

async function resolveAgentTechnician(email, workspaceId = null) {
  const matches = await getAgentTechnicians(email);
  if (!matches.length) {
    throw new AuthenticationError('No active technician profile is linked to this SSO account');
  }

  if (workspaceId) {
    const match = matches.find((tech) => tech.workspaceId === Number(workspaceId));
    if (!match) {
      throw new AuthenticationError('This SSO account is not linked to a technician in the selected workspace');
    }
    return { technician: match, matches };
  }

  return { technician: matches[0], matches };
}

function serializeTechnician(tech) {
  return {
    id: tech.id,
    name: tech.name,
    email: tech.email,
    photoUrl: tech.photoUrl,
    location: tech.location,
    workspaceId: tech.workspaceId,
    workspace: tech.workspace ? {
      id: tech.workspace.id,
      name: tech.workspace.name,
      slug: tech.workspace.slug,
      defaultTimezone: tech.workspace.defaultTimezone,
    } : undefined,
  };
}

export async function getAgentProfiles(email) {
  const matches = await getAgentTechnicians(email);
  return matches.map(serializeTechnician);
}

export async function getMyCompetencyMatrix(email, workspaceId = null) {
  const { technician, matches } = await resolveAgentTechnician(email, workspaceId);
  const supportsRequestGroups = await supportsCompetencyRequestGroups();
  const [categories, mappings, technicians, requests] = await Promise.all([
    competencyRepository.getActiveCategories(technician.workspaceId),
    competencyRepository.getAllCompetenciesForWorkspace(technician.workspaceId),
    prisma.technician.findMany({
      where: { workspaceId: technician.workspaceId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, photoUrl: true, location: true, isActive: true },
    }),
    prisma.competencyChangeRequest.findMany({
      where: { technicianId: technician.id },
      select: competencyRequestSelect({
        supportsRequestGroups,
        include: {
          competencyCategory: { select: { id: true, name: true, parentId: true } },
        },
      }),
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  return {
    technician: serializeTechnician(technician),
    profiles: matches.map(serializeTechnician),
    categories,
    categoryTree: competencyRepository.buildCategoryTree(categories),
    technicians,
    mappings,
    requests,
    levels: SELF_SERVICE_LEVELS,
  };
}

async function applyCompetency(tx, technicianId, workspaceId, competencyCategoryId, requestedLevel, note = null) {
  if (!requestedLevel) {
    await tx.technicianCompetency.deleteMany({
      where: { technicianId, workspaceId, competencyCategoryId },
    });
    return null;
  }

  return tx.technicianCompetency.upsert({
    where: {
      technicianId_competencyCategoryId: { technicianId, competencyCategoryId },
    },
    create: {
      technicianId,
      workspaceId,
      competencyCategoryId,
      proficiencyLevel: requestedLevel,
      notes: note || null,
    },
    update: {
      proficiencyLevel: requestedLevel,
      ...(note ? { notes: note } : {}),
    },
  });
}

export async function submitMyCompetencyChange(email, body = {}) {
  const requestedLevel = normalizeLevel(body.requestedLevel);
  const competencyCategoryId = Number(body.competencyCategoryId);
  if (!Number.isInteger(competencyCategoryId)) throw new ValidationError('competencyCategoryId is required');

  const { technician } = await resolveAgentTechnician(email, body.workspaceId);
  const category = await prisma.competencyCategory.findUnique({ where: { id: competencyCategoryId } });
  if (!category || category.workspaceId !== technician.workspaceId || !category.isActive) {
    throw new ValidationError('Select an active competency from your workspace');
  }

  const current = await prisma.technicianCompetency.findUnique({
    where: { technicianId_competencyCategoryId: { technicianId: technician.id, competencyCategoryId } },
  });
  const currentLevel = current?.proficiencyLevel || null;
  const currentRank = SELF_SERVICE_LEVEL_ORDER[currentLevel || ''] || 0;
  const requestedRank = SELF_SERVICE_LEVEL_ORDER[requestedLevel || ''] || 0;
  if (currentRank === requestedRank) {
    return { changed: false, data: await getMyCompetencyMatrix(email, technician.workspaceId) };
  }
  if (currentRank > 0 && requestedRank === 0) {
    throw new ValidationError('You can downgrade a skill to Basic, but you cannot remove it completely');
  }

  if (!currentLevel && requestedLevel && !category.parentId) {
    const childCount = await prisma.competencyCategory.count({
      where: {
        workspaceId: technician.workspaceId,
        parentId: category.id,
        isActive: true,
      },
    });
    if (childCount > 0) {
      throw new ValidationError('Choose a subcategory under this category');
    }
  }

  const requestType = requestTypeFor(currentLevel, requestedLevel);
  const note = normalizeNote(body.note);
  const requestedByEmail = normalizeEmail(email);
  const supportsRequestGroups = await supportsCompetencyRequestGroups();

  if (requestedRank < currentRank) {
    await prisma.$transaction(async (tx) => {
      await tx.competencyChangeRequest.create({
        data: {
          workspaceId: technician.workspaceId,
          technicianId: technician.id,
          competencyCategoryId,
          requestType,
          currentLevel,
          requestedLevel,
          note,
          status: 'auto_applied',
          requestedByEmail,
          reviewedByEmail: requestedByEmail,
          reviewedAt: new Date(),
          appliedAt: new Date(),
        },
        select: { id: true },
      });
      await applyCompetency(tx, technician.id, technician.workspaceId, competencyCategoryId, requestedLevel, note);
    });
    return { changed: true, autoApplied: true, data: await getMyCompetencyMatrix(email, technician.workspaceId) };
  }

  await prisma.$transaction(async (tx) => {
    const existingPending = await tx.competencyChangeRequest.findFirst({
      where: {
        technicianId: technician.id,
        competencyCategoryId,
        status: 'pending',
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });

    const data = maybeWithRequestGroupId({
      workspaceId: technician.workspaceId,
      technicianId: technician.id,
      competencyCategoryId,
      requestType,
      currentLevel,
      requestedLevel,
      note,
      status: 'pending',
      requestedByEmail,
    }, null, supportsRequestGroups);

    if (existingPending) {
      await tx.competencyChangeRequest.update({ where: { id: existingPending.id }, data, select: { id: true } });
    } else {
      await tx.competencyChangeRequest.create({ data, select: { id: true } });
    }
  });

  return { changed: true, autoApplied: false, data: await getMyCompetencyMatrix(email, technician.workspaceId) };
}

export async function submitMyCompetencyChanges(email, body = {}) {
  const requestedByEmail = normalizeEmail(email);
  const note = normalizeNote(body.note);
  const requestedItems = normalizeBulkChangeItems(body.requests);
  const { technician } = await resolveAgentTechnician(email, body.workspaceId);
  const requestedCategoryIds = requestedItems.map((item) => item.competencyCategoryId);

  const [categories, currentRows] = await Promise.all([
    prisma.competencyCategory.findMany({ where: { id: { in: requestedCategoryIds } } }),
    prisma.technicianCompetency.findMany({
      where: {
        technicianId: technician.id,
        competencyCategoryId: { in: requestedCategoryIds },
      },
    }),
  ]);

  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const currentByCategory = new Map(currentRows.map((row) => [row.competencyCategoryId, row]));
  const topLevelIds = categories.filter((category) => !category.parentId).map((category) => category.id);
  const childRows = topLevelIds.length
    ? await prisma.competencyCategory.findMany({
      where: {
        workspaceId: technician.workspaceId,
        parentId: { in: topLevelIds },
        isActive: true,
      },
      select: { parentId: true },
    })
    : [];
  const parentIdsWithChildren = new Set(childRows.map((row) => row.parentId));

  const pendingChanges = [];
  const autoAppliedChanges = [];
  const skippedChanges = [];

  for (const item of requestedItems) {
    const category = categoriesById.get(item.competencyCategoryId);
    if (!category || category.workspaceId !== technician.workspaceId || !category.isActive) {
      throw new ValidationError('Select active skills from your workspace');
    }
    if (!category.parentId && parentIdsWithChildren.has(category.id)) {
      throw new ValidationError(`Choose subcategories under ${category.name}`);
    }

    const current = currentByCategory.get(category.id);
    const currentLevel = current?.proficiencyLevel || null;
    const currentRank = SELF_SERVICE_LEVEL_ORDER[currentLevel || ''] || 0;
    const requestedRank = SELF_SERVICE_LEVEL_ORDER[item.requestedLevel || ''] || 0;
    if (currentRank === requestedRank) {
      skippedChanges.push({ competencyCategoryId: category.id, reason: 'same_level' });
      continue;
    }
    if (currentRank > 0 && requestedRank === 0) {
      throw new ValidationError('You can downgrade a skill to Basic, but you cannot remove it completely');
    }

    const change = {
      competencyCategoryId: category.id,
      requestType: requestTypeFor(currentLevel, item.requestedLevel),
      currentLevel,
      requestedLevel: item.requestedLevel,
    };
    if (requestedRank < currentRank) autoAppliedChanges.push(change);
    else pendingChanges.push(change);
  }

  if (!pendingChanges.length && !autoAppliedChanges.length) {
    return {
      changed: false,
      submittedCount: 0,
      autoAppliedCount: 0,
      skippedCount: skippedChanges.length,
      data: await getMyCompetencyMatrix(email, technician.workspaceId),
    };
  }

  const supportsRequestGroups = await supportsCompetencyRequestGroups();
  const requestGroupId = supportsRequestGroups && pendingChanges.length > 1 ? randomUUID() : null;

  await prisma.$transaction(async (tx) => {
    for (const change of autoAppliedChanges) {
      await tx.competencyChangeRequest.create({
        data: maybeWithRequestGroupId({
          workspaceId: technician.workspaceId,
          technicianId: technician.id,
          competencyCategoryId: change.competencyCategoryId,
          requestType: change.requestType,
          currentLevel: change.currentLevel,
          requestedLevel: change.requestedLevel,
          note,
          status: 'auto_applied',
          requestedByEmail,
          reviewedByEmail: requestedByEmail,
          reviewedAt: new Date(),
          appliedAt: new Date(),
        }, requestGroupId, supportsRequestGroups),
        select: { id: true },
      });
      await applyCompetency(tx, technician.id, technician.workspaceId, change.competencyCategoryId, change.requestedLevel, note);
    }

    for (const change of pendingChanges) {
      const existingPending = await tx.competencyChangeRequest.findFirst({
        where: {
          technicianId: technician.id,
          competencyCategoryId: change.competencyCategoryId,
          status: 'pending',
        },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });

      const data = maybeWithRequestGroupId({
        workspaceId: technician.workspaceId,
        technicianId: technician.id,
        competencyCategoryId: change.competencyCategoryId,
        requestType: change.requestType,
        currentLevel: change.currentLevel,
        requestedLevel: change.requestedLevel,
        note,
        status: 'pending',
        requestedByEmail,
      }, requestGroupId, supportsRequestGroups);

      if (existingPending) {
        await tx.competencyChangeRequest.update({ where: { id: existingPending.id }, data, select: { id: true } });
      } else {
        await tx.competencyChangeRequest.create({ data, select: { id: true } });
      }
    }
  });

  return {
    changed: true,
    autoApplied: pendingChanges.length === 0,
    requestGroupId,
    submittedCount: pendingChanges.length,
    autoAppliedCount: autoAppliedChanges.length,
    skippedCount: skippedChanges.length,
    data: await getMyCompetencyMatrix(email, technician.workspaceId),
  };
}

export async function cancelMyCompetencyChange(email, requestId) {
  const normalizedEmail = normalizeEmail(email);
  const id = Number(requestId);
  if (!Number.isInteger(id)) throw new ValidationError('requestId is required');

  const matches = await getAgentTechnicians(normalizedEmail);
  if (!matches.length) {
    throw new AuthenticationError('No active technician profile is linked to this SSO account');
  }
  const technicianIds = new Set(matches.map((technician) => technician.id));
  const request = await prisma.competencyChangeRequest.findUnique({
    where: { id },
    select: { id: true, technicianId: true, status: true, workspaceId: true },
  });
  if (!request || !technicianIds.has(request.technicianId)) {
    throw new NotFoundError('Competency request not found');
  }
  if (request.status !== 'pending') {
    throw new ValidationError('Only pending requests can be cancelled');
  }

  await prisma.competencyChangeRequest.update({
    where: { id },
    data: {
      status: 'cancelled',
      reviewedByEmail: normalizedEmail,
      reviewedAt: new Date(),
      decisionNote: 'Cancelled by requester',
    },
    select: { id: true },
  });

  return { changed: true, data: await getMyCompetencyMatrix(normalizedEmail, request.workspaceId) };
}

export async function listCompetencyRequests(workspaceId, { status = 'pending', limit = 100 } = {}) {
  const where = { workspaceId };
  if (status && status !== 'all') where.status = status;
  const supportsRequestGroups = await supportsCompetencyRequestGroups();
  return prisma.competencyChangeRequest.findMany({
    where,
    select: competencyRequestSelect({
      supportsRequestGroups,
      include: {
        technician: { select: { id: true, name: true, email: true, photoUrl: true, location: true } },
        competencyCategory: {
          select: {
            id: true,
            name: true,
            parentId: true,
            parent: { select: { id: true, name: true } },
          },
        },
      },
    }),
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(Number(limit) || 100, 1), 500),
  });
}

export async function getPendingRequestCount(workspaceId) {
  return prisma.competencyChangeRequest.count({ where: { workspaceId, status: 'pending' } });
}

export async function decideCompetencyRequest(workspaceId, requestId, decision, reviewerEmail, decisionNote = null) {
  const normalizedDecision = String(decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(normalizedDecision)) {
    throw new ValidationError('decision must be approved or rejected');
  }

  const request = await prisma.competencyChangeRequest.findUnique({
    where: { id: Number(requestId) },
    select: competencyRequestSelect(),
  });
  if (!request || request.workspaceId !== workspaceId) throw new NotFoundError('Competency request not found');
  if (request.status !== 'pending') throw new ValidationError('Only pending requests can be reviewed');

  const reviewedByEmail = normalizeEmail(reviewerEmail);
  const reviewedAt = new Date();
  await prisma.$transaction(async (tx) => {
    if (normalizedDecision === 'approved') {
      await applyCompetency(
        tx,
        request.technicianId,
        request.workspaceId,
        request.competencyCategoryId,
        request.requestedLevel,
        request.note,
      );
    }

    await tx.competencyChangeRequest.update({
      where: { id: request.id },
      data: {
        status: normalizedDecision,
        reviewedByEmail,
        reviewedAt,
        decisionNote: String(decisionNote || '').trim().slice(0, 2000) || null,
        appliedAt: normalizedDecision === 'approved' ? reviewedAt : null,
      },
      select: { id: true },
    });
  });

  return listCompetencyRequests(workspaceId, { status: 'pending' });
}

export async function decideCompetencyRequestGroup(workspaceId, requestGroupId, decision, reviewerEmail, decisionNote = null) {
  const groupId = String(requestGroupId || '').trim();
  if (!groupId) throw new ValidationError('requestGroupId is required');
  const supportsRequestGroups = await supportsCompetencyRequestGroups();
  if (!supportsRequestGroups) throw new NotFoundError('Competency request group not found');

  const normalizedDecision = String(decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(normalizedDecision)) {
    throw new ValidationError('decision must be approved or rejected');
  }

  const requests = await prisma.competencyChangeRequest.findMany({
    where: {
      workspaceId,
      requestGroupId: groupId,
      status: 'pending',
    },
    select: competencyRequestSelect({ supportsRequestGroups }),
    orderBy: { createdAt: 'asc' },
  });
  if (!requests.length) throw new NotFoundError('Competency request group not found');

  const reviewedByEmail = normalizeEmail(reviewerEmail);
  const reviewedAt = new Date();
  await prisma.$transaction(async (tx) => {
    if (normalizedDecision === 'approved') {
      for (const request of requests) {
        await applyCompetency(
          tx,
          request.technicianId,
          request.workspaceId,
          request.competencyCategoryId,
          request.requestedLevel,
          request.note,
        );
      }
    }

    await tx.competencyChangeRequest.updateMany({
      where: { id: { in: requests.map((request) => request.id) } },
      data: {
        status: normalizedDecision,
        reviewedByEmail,
        reviewedAt,
        decisionNote: normalizeNote(decisionNote),
        appliedAt: normalizedDecision === 'approved' ? reviewedAt : null,
      },
    });
  });

  return listCompetencyRequests(workspaceId, { status: 'pending' });
}

export default {
  getAgentProfiles,
  getMyCompetencyMatrix,
  submitMyCompetencyChange,
  submitMyCompetencyChanges,
  cancelMyCompetencyChange,
  listCompetencyRequests,
  getPendingRequestCount,
  decideCompetencyRequest,
  decideCompetencyRequestGroup,
};
