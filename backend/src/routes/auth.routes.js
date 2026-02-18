import express from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError, AuthenticationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();

const TENANT_ID = process.env.AZURE_AD_TENANT_ID;
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

const jwksClient = jwksRsa({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxAge: 86400000,
  rateLimit: true,
});

function getSigningKey(header, callback) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyIdToken(idToken) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      getSigningKey,
      {
        audience: CLIENT_ID,
        issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      },
    );
  });
}

/**
 * POST /api/auth/sso
 * Validate Azure AD ID token and create session
 */
router.post(
  '/sso',
  asyncHandler(async (req, res) => {
    const { idToken } = req.body;

    if (!idToken) {
      throw new ValidationError('ID token is required');
    }

    if (!TENANT_ID || !CLIENT_ID) {
      logger.error('Azure AD not configured: AZURE_AD_TENANT_ID or AZURE_AD_CLIENT_ID missing');
      throw new AuthenticationError('SSO is not configured on this server');
    }

    let claims;
    try {
      claims = await verifyIdToken(idToken);
    } catch (err) {
      logger.warn('Invalid ID token', { error: err.message });
      throw new AuthenticationError('Invalid or expired token');
    }

    const email = (claims.preferred_username || claims.email || '').toLowerCase();
    const name = claims.name || email;
    const oid = claims.oid;

    if (!email) {
      throw new AuthenticationError('No email claim found in token');
    }

    const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'viewer';

    req.session.user = {
      email,
      name,
      username: name,
      role,
      oid,
      loginTime: new Date().toISOString(),
      authMethod: 'sso',
    };

    logger.info(`SSO login: ${name} (${email}) as ${role}`);

    res.json({
      success: true,
      message: 'SSO login successful',
      user: { email, name, username: name, role },
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
    const name = req.session?.user?.name || req.session?.user?.username;

    req.session.destroy(err => {
      if (err) {
        logger.error('Error destroying session:', err);
        return res.status(500).json({
          success: false,
          message: 'Failed to logout',
        });
      }

      logger.info(`User ${name} logged out`);

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
          email: req.session.user.email,
          name: req.session.user.name,
          username: req.session.user.username || req.session.user.name,
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
