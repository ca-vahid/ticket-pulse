import express from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import config from '../config/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError, AuthenticationError } from '../utils/errors.js';
import workspaceRepository from '../services/workspaceRepository.js';
import settingsRepository from '../services/settingsRepository.js';
import agentCompetencyService from '../services/agentCompetencyService.js';
import logger from '../utils/logger.js';

const router = express.Router();

const TENANT_ID = process.env.AZURE_AD_TENANT_ID;
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const ENV_ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

async function getAdminEmails() {
  try {
    const dbVal = await settingsRepository.get('admin_emails');
    if (dbVal && dbVal.trim()) {
      return dbVal.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    }
  } catch { /* fall through */ }
  return ENV_ADMIN_EMAILS;
}

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

function sanitizeWorkspace(workspace) {
  if (!workspace) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    defaultTimezone: workspace.defaultTimezone,
  };
}

function sanitizeAgentProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    location: profile.location || null,
    workspaceId: profile.workspaceId || profile.workspace?.id || null,
    workspace: sanitizeWorkspace(profile.workspace),
  };
}

function sanitizeAgentProfiles(profiles = []) {
  if (!Array.isArray(profiles)) return [];
  return profiles.map(sanitizeAgentProfile).filter(Boolean);
}

function buildTokenUser({ email, name, role, selectedWorkspaceId }) {
  const payload = {
    email,
    name,
    username: name,
    role,
  };
  if (selectedWorkspaceId) {
    payload.selectedWorkspaceId = selectedWorkspaceId;
  }
  return payload;
}

function buildResponseUser({ email, name, role, selectedWorkspaceId, agentProfiles = [] }) {
  const sanitizedAgentProfiles = sanitizeAgentProfiles(agentProfiles);
  return {
    ...buildTokenUser({ email, name, role, selectedWorkspaceId }),
    hasAgentProfile: sanitizedAgentProfiles.length > 0,
    agentProfile: sanitizedAgentProfiles[0] || null,
    agentProfiles: sanitizedAgentProfiles,
  };
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

    const adminEmails = await getAdminEmails();
    let role = adminEmails.includes(email) ? 'admin' : 'viewer';

    // Fetch workspaces this user has access to
    let availableWorkspaces = [];
    let agentProfiles = [];
    try {
      if (role === 'admin') {
        availableWorkspaces = (await workspaceRepository.getAll()).map(ws => ({
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          role: 'admin',
        }));
      } else {
        availableWorkspaces = await workspaceRepository.getAccessibleWorkspaces(email);
      }
      agentProfiles = await agentCompetencyService.getAgentProfiles(email);
      if (role !== 'admin' && availableWorkspaces.length === 0 && agentProfiles.length > 0) {
        role = 'agent';
      }
    } catch (err) {
      logger.warn('Failed to fetch workspaces during login:', err.message);
    }

    // Preserve existing workspace selection if session already has one
    const existingWsId = req.session?.user?.selectedWorkspaceId;
    const existingWsName = req.session?.user?.selectedWorkspaceName;
    const existingWsSlug = req.session?.user?.selectedWorkspaceSlug;

    // Auto-select only if no existing selection and exactly one workspace
    let selectedWorkspaceId = existingWsId || null;
    let selectedWorkspaceName = existingWsName || null;
    let selectedWorkspaceSlug = existingWsSlug || null;

    if (!selectedWorkspaceId && availableWorkspaces.length === 1) {
      selectedWorkspaceId = availableWorkspaces[0].id;
      selectedWorkspaceName = availableWorkspaces[0].name;
      selectedWorkspaceSlug = availableWorkspaces[0].slug;
    }

    const sanitizedAgentProfiles = sanitizeAgentProfiles(agentProfiles);

    req.session.user = {
      email,
      name,
      username: name,
      role,
      oid,
      loginTime: new Date().toISOString(),
      authMethod: 'sso',
      availableWorkspaces,
      agentProfiles: sanitizedAgentProfiles,
      agentProfile: sanitizedAgentProfiles[0] || null,
      selectedWorkspaceId,
      selectedWorkspaceName,
      selectedWorkspaceSlug,
    };

    logger.info(`SSO login: ${name} (${email}) as ${role}, ${availableWorkspaces.length} workspace(s), ${agentProfiles.length} technician profile(s)`);

    const tokenPayload = buildTokenUser({
      email,
      name,
      role,
      selectedWorkspaceId,
    });
    const userPayload = buildResponseUser({
      email,
      name,
      role,
      selectedWorkspaceId,
      agentProfiles,
    });
    const authToken = jwt.sign(tokenPayload, config.session.secret, {
      algorithm: 'HS256',
      expiresIn: '8h',
    });

    res.json({
      success: true,
      message: 'SSO login successful',
      user: userPayload,
      authToken,
      availableWorkspaces,
      selectedWorkspaceId,
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
      const sessionAgentProfiles = sanitizeAgentProfiles(req.session.user.agentProfiles || []);
      return res.json({
        success: true,
        authenticated: true,
        user: {
          email: req.session.user.email,
          name: req.session.user.name,
          username: req.session.user.username || req.session.user.name,
          role: req.session.user.role,
          hasAgentProfile: sessionAgentProfiles.length > 0,
          agentProfile: sessionAgentProfiles[0] || null,
          agentProfiles: sessionAgentProfiles,
        },
        availableWorkspaces: req.session.user.availableWorkspaces || [],
        selectedWorkspaceId: req.session.user.selectedWorkspaceId || null,
        selectedWorkspaceName: req.session.user.selectedWorkspaceName || null,
        selectedWorkspaceSlug: req.session.user.selectedWorkspaceSlug || null,
      });
    }

    // Fallback: check JWT in Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, config.session.secret, { algorithms: ['HS256'] });

        // Resolve workspace access from DB since JWT doesn't carry it
        let availableWorkspaces = [];
        let selectedWorkspaceId = null;
        let selectedWorkspaceName = null;
        let selectedWorkspaceSlug = null;
        let agentProfiles = [];
        try {
          const email = decoded.email?.toLowerCase();
          let role = decoded.role;
          if (role === 'admin') {
            availableWorkspaces = (await workspaceRepository.getAll()).map(ws => ({
              id: ws.id, name: ws.name, slug: ws.slug, role: 'admin',
            }));
          } else if (email) {
            availableWorkspaces = await workspaceRepository.getAccessibleWorkspaces(email);
          }
          agentProfiles = email ? await agentCompetencyService.getAgentProfiles(email) : [];
          if (role !== 'admin' && availableWorkspaces.length === 0 && agentProfiles.length > 0) {
            role = 'agent';
            decoded.role = role;
          }
          if (decoded.selectedWorkspaceId) {
            selectedWorkspaceId = decoded.selectedWorkspaceId;
          } else if (availableWorkspaces.length === 1) {
            selectedWorkspaceId = availableWorkspaces[0].id;
          }
          const selectedWs = selectedWorkspaceId
            ? availableWorkspaces.find(w => w.id === selectedWorkspaceId) || null
            : null;
          selectedWorkspaceName = req.session?.user?.selectedWorkspaceName || selectedWs?.name || null;
          selectedWorkspaceSlug = req.session?.user?.selectedWorkspaceSlug || selectedWs?.slug || null;
          const sanitizedAgentProfiles = sanitizeAgentProfiles(agentProfiles);
          if (req.session) {
            req.session.user = {
              email: decoded.email,
              name: decoded.name,
              username: decoded.username || decoded.name,
              role,
              selectedWorkspaceId: req.session.user?.selectedWorkspaceId || selectedWorkspaceId,
              agentProfiles: sanitizedAgentProfiles,
              agentProfile: sanitizedAgentProfiles[0] || null,
              availableWorkspaces,
              selectedWorkspaceName,
              selectedWorkspaceSlug,
            };
          }
        } catch (wsErr) {
          logger.warn('Failed to resolve workspaces in JWT fallback:', wsErr.message);
        }
        const responseUser = buildResponseUser({
          email: decoded.email,
          name: decoded.name,
          role: decoded.role,
          selectedWorkspaceId: req.session?.user?.selectedWorkspaceId || selectedWorkspaceId,
          agentProfiles: req.session?.user?.agentProfiles || agentProfiles,
        });

        return res.json({
          success: true,
          authenticated: true,
          user: responseUser,
          availableWorkspaces,
          selectedWorkspaceId: req.session?.user?.selectedWorkspaceId || selectedWorkspaceId,
          selectedWorkspaceName,
          selectedWorkspaceSlug,
        });
      } catch {
        // Invalid token — fall through
      }
    }

    res.json({
      success: true,
      authenticated: false,
    });
  }),
);

export default router;
