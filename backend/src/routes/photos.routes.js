import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import azureAdService from '../services/azureAdService.js';
import { clearReadCache } from '../services/dashboardReadCache.js';
import logger from '../utils/logger.js';
import prisma from '../services/prisma.js';

const router = express.Router();

router.use(requireAuth);

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

    logger.info('Starting photo + location sync from Azure AD');

    const technicians = await prisma.technician.findMany({
      where: {
        isActive: true,
        workspaceId: req.workspaceId,
        email: { not: null },
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
      });
    }

    logger.info(`Syncing photos + locations for ${technicians.length} technicians`);

    // Fetch photos and profiles in parallel batches
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

    for (const result of photoResults) {
      try {
        const updateData = {
          photoUrl: result.photoUrl,
          photoSyncedAt: new Date(),
        };

        // Check if we should update location from AD
        const tech = technicians.find(t => t.id === result.id);
        const profile = profileMap.get(result.id);
        const adLocation = profile?.officeLocation || profile?.city || null;

        if (adLocation && (!tech?.location || tech.location.trim() === '')) {
          updateData.location = adLocation;
          locationsSynced++;
        } else if (adLocation && tech?.location) {
          locationsSkipped++;
        } else if (!adLocation) {
          locationsFailed++;
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
      } catch (error) {
        photosFailed++;
        locationsFailed++;
        logger.error(`Failed to update photo/location for ${result.email}`, { error: error.message });
      }
    }

    logger.info(`Sync completed: photos ${photosSynced}/${technicians.length}, locations ${locationsSynced} new, ${locationsSkipped} kept`);
    clearReadCache();

    res.json({
      success: true,
      message: 'Azure AD sync completed',
      total: technicians.length,
      photos: { synced: photosSynced, failed: photosFailed },
      locations: { synced: locationsSynced, skipped: locationsSkipped, failed: locationsFailed },
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
      select: { id: true, email: true, name: true, location: true },
    });

    if (!technician) {
      return res.status(404).json({ success: false, message: 'Technician not found' });
    }

    if (!technician.email) {
      return res.status(400).json({ success: false, message: 'Technician has no email address' });
    }

    logger.info(`Fetching photo + profile for ${technician.email}`);

    const [photoUrl, profile] = await Promise.all([
      azureAdService.getUserPhoto(technician.email),
      azureAdService.getUserProfile(technician.email),
    ]);

    const updateData = { photoUrl, photoSyncedAt: new Date() };
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
