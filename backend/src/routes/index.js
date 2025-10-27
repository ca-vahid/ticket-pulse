import express from 'express';
import authRoutes from './auth.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import settingsRoutes from './settings.routes.js';
import syncRoutes from './sync.routes.js';
import sseRoutes from './sse.routes.js';
import photosRoutes from './photos.routes.js';

const router = express.Router();

// Health check endpoint (no auth required)
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is healthy',
    timestamp: new Date().toISOString(),
  });
});

// Mount route modules
router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/settings', settingsRoutes);
router.use('/sync', syncRoutes);
router.use('/sse', sseRoutes);
router.use('/photos', photosRoutes);

export default router;
