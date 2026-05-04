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
      include: {
        competencyCategory: { select: { id: true, name: true, parentId: true } },
      },
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

  if (!currentLevel && requestedLevel && !category.parentId) {
    throw new ValidationError('New skill requests must use an existing subcategory');
  }

  const requestType = requestTypeFor(currentLevel, requestedLevel);
  const note = String(body.note || '').trim().slice(0, 2000) || null;
  const requestedByEmail = normalizeEmail(email);

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
      orderBy: { createdAt: 'desc' },
    });

    const data = {
      workspaceId: technician.workspaceId,
      technicianId: technician.id,
      competencyCategoryId,
      requestType,
      currentLevel,
      requestedLevel,
      note,
      status: 'pending',
      requestedByEmail,
    };

    if (existingPending) {
      await tx.competencyChangeRequest.update({ where: { id: existingPending.id }, data });
    } else {
      await tx.competencyChangeRequest.create({ data });
    }
  });

  return { changed: true, autoApplied: false, data: await getMyCompetencyMatrix(email, technician.workspaceId) };
}

export async function listCompetencyRequests(workspaceId, { status = 'pending', limit = 100 } = {}) {
  const where = { workspaceId };
  if (status && status !== 'all') where.status = status;
  return prisma.competencyChangeRequest.findMany({
    where,
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
    });
  });

  return listCompetencyRequests(workspaceId, { status: 'pending' });
}

export default {
  getAgentProfiles,
  getMyCompetencyMatrix,
  submitMyCompetencyChange,
  listCompetencyRequests,
  getPendingRequestCount,
  decideCompetencyRequest,
};
