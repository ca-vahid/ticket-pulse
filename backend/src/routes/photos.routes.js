import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import azureAdService from '../services/azureAdService.js';
import { clearReadCache } from '../services/dashboardReadCache.js';
import logger from '../utils/logger.js';
import prisma from '../services/prisma.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const router = express.Router();

router.use(requireAuth);

// ---------------------------------------------------------------------------
// In-app photos (QA 09-22 #7): a person uploads their own picture from the
// profile page; a workspace admin can set one for anyone on the roster. The
// browser resizes to a small JPEG first; the server keeps the data URL like
// the Entra photos already stored, stamps photoSource='custom', and the
// directory sync leaves custom photos alone.
// ---------------------------------------------------------------------------
const PHOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const MAX_PHOTO_BYTES = 300 * 1024;
const PHOTO_SELECT = { id: true, name: true, email: true, photoUrl: true, photoSource: true, photoSyncedAt: true, workspaceId: true };

function photoInput(body) {
  const dataUrl = String(body?.dataUrl || '').trim();
  const m = PHOTO_DATA_URL.exec(dataUrl);
  if (!m) throw new ValidationError('Send the photo as a JPEG, PNG or WebP image.');
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > MAX_PHOTO_BYTES) throw new ValidationError('That photo is too large — it should be under 300 KB after resizing.');
  return dataUrl;
}

function requestEmail(req) {
  return String(req.user?.email || req.session?.user?.email || '').trim().toLowerCase();
}

async function ownTechnician(req) {
  const email = requestEmail(req);
  const technician = email
    ? await prisma.technician.findFirst({
      where: { workspaceId: req.workspaceId, isActive: true, email: { equals: email, mode: 'insensitive' } },
      select: PHOTO_SELECT,
    })
    : null;
  if (!technician) throw new NotFoundError('No technician profile for this account in the current workspace');
  return technician;
}

async function technicianInWorkspace(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError('Invalid technician id');
  const technician = await prisma.technician.findFirst({ where: { id, workspaceId: req.workspaceId }, select: PHOTO_SELECT });
  if (!technician) throw new NotFoundError('Technician not found in this workspace');
  return technician;
}

async function setCustomPhoto(technician, dataUrl, who) {
  const updated = await prisma.technician.update({
    where: { id: technician.id },
    data: { photoUrl: dataUrl, photoSource: 'custom', photoSyncedAt: new Date() },
    select: PHOTO_SELECT,
  });
  try { clearReadCache(); } catch { /* cache is best effort */ }
  logger.info(`Profile photo uploaded for ${technician.email || technician.id} by ${who}`);
  return updated;
}

async function revertToDirectoryPhoto(technician, who) {
  let photoUrl = null;
  if (technician.email && azureAdService.isConfigured()) {
    photoUrl = await azureAdService.getUserPhoto(technician.email).catch(() => null);
  }
  const updated = await prisma.technician.update({
    where: { id: technician.id },
    data: { photoUrl, photoSource: photoUrl ? 'entra' : null, photoSyncedAt: new Date() },
    select: PHOTO_SELECT,
  });
  try { clearReadCache(); } catch { /* cache is best effort */ }
  logger.info(`Profile photo reverted to the directory for ${technician.email || technician.id} by ${who}`);
  return updated;
}

router.get('/me', asyncHandler(async (req, res) => {
  const technician = await ownTechnician(req);
  res.json({ success: true, data: technician });
}));

router.put('/me', asyncHandler(async (req, res) => {
  const technician = await ownTechnician(req);
  const updated = await setCustomPhoto(technician, photoInput(req.body), requestEmail(req));
  res.json({ success: true, data: updated });
}));

router.delete('/me', asyncHandler(async (req, res) => {
  const technician = await ownTechnician(req);
  const updated = await revertToDirectoryPhoto(technician, requestEmail(req));
  res.json({ success: true, data: updated });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const technician = await technicianInWorkspace(req);
  const updated = await setCustomPhoto(technician, photoInput(req.body), requestEmail(req));
  res.json({ success: true, data: updated });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const technician = await technicianInWorkspace(req);
  const updated = await revertToDirectoryPhoto(technician, requestEmail(req));
  res.json({ success: true, data: updated });
}));

/**
 * POST /api/photos/sync
 * Sync profile photos AND locations from Azure AD for all active technicians.
 * Photos: fetched from /users/{email}/photo/$value
 * Locations: fetched from /users/{email} (officeLocation, city fields)
 *            Only updates location if the current DB value is null (does not overwrite manual edits)
 */
router.post(
  '/sync',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!azureAdService.isConfigured()) {
      return res.status(400).json({
        success: false,
        message: 'Azure AD is not configured. Please add Azure AD credentials to .env file.',
      });
    }

    const forceLocations = req.body?.forceLocations === true;
    logger.info(`Starting photo + location sync from Azure AD (forceLocations=${forceLocations})`);

    const technicians = await prisma.technician.findMany({
      where: {
        isActive: true,
        workspaceId: req.workspaceId,
        email: { not: null },
        // A photo uploaded in the app is never overwritten by the directory.
        OR: [{ photoSource: null }, { photoSource: { not: 'custom' } }],
      },
      select: {
        id: true,
        email: true,
        name: true,
        location: true,
      },
    });

    if (technicians.length === 0) {
      return res.json({
        success: true,
        message: 'No technicians with emails found',
        photos: { synced: 0, failed: 0 },
        locations: { synced: 0, skipped: 0, failed: 0 },
        total: 0,
        details: [],
      });
    }

    logger.info(`Syncing photos + locations for ${technicians.length} technicians`);

    const [photoResults, profileResults] = await Promise.all([
      azureAdService.getUserPhotos(technicians, 3),
      azureAdService.getUserProfiles(technicians, 3),
    ]);

    const profileMap = new Map(profileResults.map(p => [p.id, p]));

    let photosSynced = 0;
    let photosFailed = 0;
    let locationsSynced = 0;
    let locationsSkipped = 0;
    let locationsFailed = 0;
    const details = [];

    for (const result of photoResults) {
      try {
        const updateData = {
          photoUrl: result.photoUrl,
          photoSource: result.photoUrl ? 'entra' : null,
          photoSyncedAt: new Date(),
        };

        const tech = technicians.find(t => t.id === result.id);
        const profile = profileMap.get(result.id);
        const adLocation = profile?.officeLocation || profile?.city || null;
        const hadManualLocation = !!(tech?.location && tech.location.trim());

        let locationAction = 'none';

        if (adLocation && (!hadManualLocation || forceLocations)) {
          updateData.location = adLocation;
          locationsSynced++;
          locationAction = hadManualLocation ? 'overwritten' : 'set';
        } else if (adLocation && hadManualLocation) {
          locationsSkipped++;
          locationAction = 'kept';
        } else if (!adLocation) {
          locationsFailed++;
          locationAction = 'no_ad_data';
        }

        await prisma.technician.update({
          where: { id: result.id },
          data: updateData,
        });

        if (result.photoUrl) {
          photosSynced++;
        } else {
          photosFailed++;
        }

        details.push({
          name: tech?.name || result.email,
          email: result.email,
          photo: !!result.photoUrl,
          locationBefore: tech?.location || null,
          locationAD: adLocation,
          locationAfter: updateData.location || tech?.location || null,
          locationAction,
          adJobTitle: profile?.jobTitle || null,
          adDepartment: profile?.department || null,
        });
      } catch (error) {
        photosFailed++;
        locationsFailed++;
        logger.error(`Failed to update photo/location for ${result.email}`, { error: error.message });
        details.push({
          name: result.email,
          email: result.email,
          photo: false,
          locationAction: 'error',
          error: error.message,
        });
      }
    }

    logger.info(`Sync completed: photos ${photosSynced}/${technicians.length}, locations ${locationsSynced} new/updated, ${locationsSkipped} kept`);
    clearReadCache();

    res.json({
      success: true,
      message: 'Azure AD sync completed',
      total: technicians.length,
      photos: { synced: photosSynced, failed: photosFailed },
      locations: { synced: locationsSynced, skipped: locationsSkipped, failed: locationsFailed },
      details,
    });
  }),
);

/**
 * POST /api/photos/sync/:id
 * Sync profile photo from Azure AD for a specific technician
 */
router.post(
  '/sync/:id',
  asyncHandler(async (req, res) => {
    const techId = parseInt(req.params.id, 10);

    if (isNaN(techId)) {
      return res.status(400).json({ success: false, message: 'Invalid technician ID' });
    }

    if (!azureAdService.isConfigured()) {
      return res.status(400).json({ success: false, message: 'Azure AD is not configured' });
    }

    const technician = await prisma.technician.findUnique({
      where: { id: techId },
      select: { id: true, email: true, name: true, location: true, photoSource: true, photoUrl: true },
    });

    if (!technician) {
      return res.status(404).json({ success: false, message: 'Technician not found' });
    }

    if (technician.photoSource === 'custom') {
      return res.json({ success: true, message: 'This person uploaded their own photo — the directory photo is not applied over it', photoUrl: technician.photoUrl, location: technician.location || null });
    }

    if (!technician.email) {
      return res.status(400).json({ success: false, message: 'Technician has no email address' });
    }

    logger.info(`Fetching photo + profile for ${technician.email}`);

    const [photoUrl, profile] = await Promise.all([
      azureAdService.getUserPhoto(technician.email),
      azureAdService.getUserProfile(technician.email),
    ]);

    const updateData = { photoUrl, photoSource: photoUrl ? 'entra' : null, photoSyncedAt: new Date() };
    const adLocation = profile?.officeLocation || profile?.city || null;
    if (adLocation && (!technician.location || technician.location.trim() === '')) {
      updateData.location = adLocation;
    }

    await prisma.technician.update({
      where: { id: techId },
      data: updateData,
    });

    res.json({
      success: true,
      message: photoUrl ? 'Photo synced successfully' : 'No photo found in Azure AD',
      photoUrl,
      location: updateData.location || technician.location || null,
    });
  }),
);

/**
 * GET /api/photos/status
 * Get sync status for all technicians (photos + locations)
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const technicians = await prisma.technician.findMany({
      where: {
        isActive: true,
        workspaceId: req.workspaceId,
      },
      select: {
        id: true,
        name: true,
        email: true,
        photoUrl: true,
        photoSyncedAt: true,
        location: true,
      },
      orderBy: { name: 'asc' },
    });

    const withPhotos = technicians.filter(t => t.photoUrl).length;
    const withoutPhotos = technicians.filter(t => !t.photoUrl).length;
    const withLocation = technicians.filter(t => t.location && t.location.trim()).length;
    const withoutLocation = technicians.filter(t => !t.location || !t.location.trim()).length;

    res.json({
      success: true,
      data: {
        total: technicians.length,
        withPhotos,
        withoutPhotos,
        withLocation,
        withoutLocation,
        technicians: technicians.map(t => ({
          id: t.id,
          name: t.name,
          email: t.email,
          hasPhoto: !!t.photoUrl,
          location: t.location || null,
          lastSynced: t.photoSyncedAt,
        })),
      },
    });
  }),
);

export default router;
