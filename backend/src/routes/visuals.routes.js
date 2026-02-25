import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import technicianRepository from '../services/technicianRepository.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Protect all visuals routes with authentication
router.use(requireAuth);

/**
 * GET /api/visuals/agents
 * Get all active agents with minimal data for map visualization
 */
router.get(
  '/agents',
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const technicians = includeInactive
      ? await technicianRepository.getAll()
      : await technicianRepository.getAllActive();

    const agents = technicians.map(tech => ({
      id: tech.id,
      name: tech.name,
      email: tech.email,
      photoUrl: tech.photoUrl,
      location: tech.location,
      timezone: tech.timezone,
      showOnMap: tech.showOnMap,
      isMapManager: tech.isMapManager,
      workStartTime: tech.workStartTime,
      workEndTime: tech.workEndTime,
      isActive: tech.isActive,
    }));

    res.json({
      success: true,
      data: {
        agents,
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

/**
 * PATCH /api/visuals/agents/:id/location
 * Update an agent's location
 */
router.patch(
  '/agents/:id/location',
  asyncHandler(async (req, res) => {
    const agentId = parseInt(req.params.id, 10);
    const { location } = req.body;

    if (isNaN(agentId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid agent ID',
      });
    }

    if (typeof location !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Location must be a string',
      });
    }

    // Update the technician's location
    const updatedTech = await technicianRepository.update(agentId, {
      location: location || null,
    });

    res.json({
      success: true,
      data: {
        id: updatedTech.id,
        name: updatedTech.name,
        location: updatedTech.location,
      },
      message: 'Location updated successfully',
    });
  }),
);

/**
 * PATCH /api/visuals/agents/:id/visibility
 * Update an agent's map visibility and manager status
 */
router.patch(
  '/agents/:id/visibility',
  asyncHandler(async (req, res) => {
    const agentId = parseInt(req.params.id, 10);
    const { showOnMap, isMapManager } = req.body;

    if (isNaN(agentId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid agent ID',
      });
    }

    const updateData = {};
    if (showOnMap !== undefined) updateData.showOnMap = showOnMap;
    if (isMapManager !== undefined) updateData.isMapManager = isMapManager;

    // Update the technician's visibility settings
    const updatedTech = await technicianRepository.update(agentId, updateData);

    res.json({
      success: true,
      data: {
        id: updatedTech.id,
        name: updatedTech.name,
        showOnMap: updatedTech.showOnMap,
        isMapManager: updatedTech.isMapManager,
      },
      message: 'Visibility updated successfully',
    });
  }),
);

/**
 * PATCH /api/visuals/agents/:id/schedule
 * Update an agent's work schedule and optionally their timezone
 */
router.patch(
  '/agents/:id/schedule',
  asyncHandler(async (req, res) => {
    const agentId = parseInt(req.params.id, 10);
    const { workStartTime, workEndTime, timezone } = req.body;

    if (isNaN(agentId)) {
      return res.status(400).json({ success: false, message: 'Invalid agent ID' });
    }

    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (workStartTime !== null && workStartTime !== undefined && !timeRegex.test(workStartTime)) {
      return res.status(400).json({ success: false, message: 'workStartTime must be HH:MM format or null' });
    }
    if (workEndTime !== null && workEndTime !== undefined && !timeRegex.test(workEndTime)) {
      return res.status(400).json({ success: false, message: 'workEndTime must be HH:MM format or null' });
    }

    const updatePayload = {
      workStartTime: workStartTime ?? null,
      workEndTime: workEndTime ?? null,
    };
    if (timezone) updatePayload.timezone = timezone;

    const updatedTech = await technicianRepository.update(agentId, updatePayload);

    res.json({
      success: true,
      data: {
        id: updatedTech.id,
        name: updatedTech.name,
        timezone: updatedTech.timezone,
        workStartTime: updatedTech.workStartTime,
        workEndTime: updatedTech.workEndTime,
      },
      message: 'Schedule updated successfully',
    });
  }),
);

/**
 * POST /api/visuals/agents/batch-visibility
 * Batch update agent visibility
 */
router.post(
  '/agents/batch-visibility',
  asyncHandler(async (req, res) => {
    const { selectedIds, managerId } = req.body;

    logger.info('Batch visibility update:', { selectedIds, managerId });

    if (!Array.isArray(selectedIds)) {
      return res.status(400).json({
        success: false,
        message: 'selectedIds must be an array',
      });
    }

    // Get all active technicians
    const technicians = await technicianRepository.getAllActive();

    // Update all technicians
    const updates = technicians.map(async (tech) => {
      const isSelected = selectedIds.includes(tech.id);
      const isManager = tech.id === managerId;

      // Only update if changed
      if (tech.showOnMap !== isSelected || tech.isMapManager !== isManager) {
        logger.info(`Updating tech ${tech.id} (${tech.name}): showOnMap=${isSelected}, isMapManager=${isManager}`);
        return technicianRepository.update(tech.id, {
          showOnMap: isSelected,
          isMapManager: isManager,
        });
      }
      return null;
    });

    await Promise.all(updates);

    logger.info(`Batch update complete: ${selectedIds.length} agents selected`);

    res.json({
      success: true,
      message: `Updated ${selectedIds.length} agents`,
    });
  }),
);

export default router;

