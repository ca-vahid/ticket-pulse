import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import azureAdService from '../services/azureAdService.js';
import logger from '../utils/logger.js';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

// Protect all photo routes with authentication
router.use(requireAuth);

/**
 * POST /api/photos/sync
 * Sync profile photos from Azure AD for all technicians
 */
router.post(
  '/sync',
  asyncHandler(async (req, res) => {
    // Check if Azure AD is configured
    if (!azureAdService.isConfigured()) {
      return res.status(400).json({
        success: false,
        message: 'Azure AD is not configured. Please add Azure AD credentials to .env file.',
      });
    }

    logger.info('Starting photo sync from Azure AD');

    // Get all active technicians with emails
    const technicians = await prisma.technician.findMany({
      where: {
        isActive: true,
        email: {
          not: null,
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    if (technicians.length === 0) {
      return res.json({
        success: true,
        message: 'No technicians with emails found',
        synced: 0,
        failed: 0,
      });
    }

    logger.info(`Fetching photos for ${technicians.length} technicians`);

    // Fetch photos from Azure AD
    const photoResults = await azureAdService.getUserPhotos(technicians, 3);

    // Update technicians with photos
    let synced = 0;
    let failed = 0;

    for (const result of photoResults) {
      try {
        await prisma.technician.update({
          where: { id: result.id },
          data: {
            photoUrl: result.photoUrl,
            photoSyncedAt: new Date(),
          },
        });

        if (result.photoUrl) {
          synced++;
          logger.info(`Photo synced for ${result.email}`);
        } else {
          failed++;
          logger.warn(`No photo found for ${result.email}`);
        }
      } catch (error) {
        failed++;
        logger.error(`Failed to update photo for ${result.email}`, { error: error.message });
      }
    }

    await prisma.$disconnect();

    logger.info(`Photo sync completed: ${synced} synced, ${failed} failed`);

    res.json({
      success: true,
      message: 'Photo sync completed',
      total: technicians.length,
      synced,
      failed,
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
      return res.status(400).json({
        success: false,
        message: 'Invalid technician ID',
      });
    }

    // Check if Azure AD is configured
    if (!azureAdService.isConfigured()) {
      return res.status(400).json({
        success: false,
        message: 'Azure AD is not configured',
      });
    }

    // Get technician
    const technician = await prisma.technician.findUnique({
      where: { id: techId },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    if (!technician) {
      await prisma.$disconnect();
      return res.status(404).json({
        success: false,
        message: 'Technician not found',
      });
    }

    if (!technician.email) {
      await prisma.$disconnect();
      return res.status(400).json({
        success: false,
        message: 'Technician has no email address',
      });
    }

    logger.info(`Fetching photo for ${technician.email}`);

    // Fetch photo from Azure AD
    const photoUrl = await azureAdService.getUserPhoto(technician.email);

    // Update technician
    await prisma.technician.update({
      where: { id: techId },
      data: {
        photoUrl,
        photoSyncedAt: new Date(),
      },
    });

    await prisma.$disconnect();

    res.json({
      success: true,
      message: photoUrl ? 'Photo synced successfully' : 'No photo found in Azure AD',
      photoUrl,
    });
  }),
);

/**
 * GET /api/photos/status
 * Get photo sync status for all technicians
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const technicians = await prisma.technician.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        photoUrl: true,
        photoSyncedAt: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    await prisma.$disconnect();

    const withPhotos = technicians.filter(t => t.photoUrl).length;
    const withoutPhotos = technicians.filter(t => !t.photoUrl).length;

    res.json({
      success: true,
      data: {
        total: technicians.length,
        withPhotos,
        withoutPhotos,
        technicians: technicians.map(t => ({
          id: t.id,
          name: t.name,
          email: t.email,
          hasPhoto: !!t.photoUrl,
          lastSynced: t.photoSyncedAt,
        })),
      },
    });
  }),
);

export default router;
