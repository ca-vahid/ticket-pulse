import express from 'express';
import bcrypt from 'bcrypt';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError, AuthenticationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Hardcoded admin credentials (can be moved to database later)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || null;

/**
 * POST /api/auth/login
 * Authenticate user and create session
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      throw new ValidationError('Username and password are required');
    }

    // Check username
    if (username !== ADMIN_USERNAME) {
      logger.warn(`Failed login attempt for username: ${username}`);
      throw new AuthenticationError('Invalid credentials');
    }

    // Check password
    let passwordValid = false;
    if (ADMIN_PASSWORD_HASH) {
      passwordValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    } else {
      // Fallback for development (no hash set)
      passwordValid = password === (process.env.ADMIN_PASSWORD || 'admin');
    }

    if (!passwordValid) {
      logger.warn(`Failed login attempt for username: ${username}`);
      throw new AuthenticationError('Invalid credentials');
    }

    // Create session
    req.session.user = {
      username,
      role: 'admin',
      loginTime: new Date().toISOString(),
    };

    logger.info(`User ${username} logged in successfully`);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        username,
        role: 'admin',
      },
    });
  }),
);

/**
 * POST /api/auth/logout
 * Destroy session
 */
router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const username = req.session?.user?.username;

    req.session.destroy(err => {
      if (err) {
        logger.error('Error destroying session:', err);
        return res.status(500).json({
          success: false,
          message: 'Failed to logout',
        });
      }

      logger.info(`User ${username} logged out`);

      res.json({
        success: true,
        message: 'Logout successful',
      });
    });
  }),
);

/**
 * GET /api/auth/session
 * Check if user is authenticated
 */
router.get(
  '/session',
  asyncHandler(async (req, res) => {
    if (req.session?.user) {
      res.json({
        success: true,
        authenticated: true,
        user: {
          username: req.session.user.username,
          role: req.session.user.role,
        },
      });
    } else {
      res.json({
        success: true,
        authenticated: false,
      });
    }
  }),
);

export default router;
