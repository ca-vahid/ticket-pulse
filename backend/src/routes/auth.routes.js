import express from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import config from '../config/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError, AuthenticationError } from '../utils/errors.js';
import workspaceRepository, { mergeWorkspaceLists } from '../services/workspaceRepository.js';
import settingsRepository from '../services/settingsRepository.js';
import agentCompetencyService from '../services/agentCompetencyService.js';
import rateLimiter from '../services/apiRateLimitService.js';
import { clientIp } from '../middleware/apiKeyAuth.js';
import logger from '../utils/logger.js';
import { recordSignIn } from '../services/usageStatsService.js';
import { VIEW_AS_ROLES, VIEW_AS_ROLE_LABELS, cleanViewAs, currentViewAs } from '../services/viewAsContext.js';

const router = express.Router();

// Per-IP throttle for the credential-validating login endpoints. Uses the same
// durable fixed-window limiter as the public API (fails open on store error, so
// login never hard-breaks). Blunts brute-forcing / token-spraying.
const LOGIN_ATTEMPTS_PER_MIN = Number(process.env.AUTH_LOGIN_RATE_LIMIT_PER_MINUTE || 20);
async function throttleLogin(req, res, next) {
  const ip = clientIp(req);
  if (!ip) return next();
  const r = await rateLimiter.hit(`login:${ip}`, LOGIN_ATTEMPTS_PER_MIN);
  if (!r.allowed) {
    return res.status(429)
      .set('Retry-After', String(Math.max(1, r.reset - Math.floor(Date.now() / 1000))))
      .json({ success: false, message: 'Too many login attempts — please wait a minute and try again.' });
  }
  return next();
}

const TENANT_ID = process.env.AZURE_AD_TENANT_ID;
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const ENV_ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

export async function getAdminEmails() {
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

function buildTokenUser({ email, name, role, selectedWorkspaceId, viewAs = null }) {
  const payload = {
    email,
    name,
    username: name,
    role,
  };
  if (selectedWorkspaceId) {
    payload.selectedWorkspaceId = selectedWorkspaceId;
  }
  const view = cleanViewAs(viewAs);
  if (view) payload.viewAs = view;
  return payload;
}

function buildResponseUser({ email, name, role, selectedWorkspaceId, agentProfiles = [], viewAs = null }) {
  const sanitizedAgentProfiles = sanitizeAgentProfiles(agentProfiles);
  return {
    ...buildTokenUser({ email, name, role, selectedWorkspaceId, viewAs }),
    hasAgentProfile: sanitizedAgentProfiles.length > 0,
    agentProfile: sanitizedAgentProfiles[0] || null,
    agentProfiles: sanitizedAgentProfiles,
  };
}

function issueAuthToken({ email, name, role, selectedWorkspaceId, viewAs = null }) {
  return jwt.sign(
    buildTokenUser({ email, name, role, selectedWorkspaceId, viewAs }),
    config.session.secret,
    {
      algorithm: 'HS256',
      expiresIn: config.session.jwtExpiresIn,
    },
  );
}

function isLocalDevRequest(req) {
  if (config.devAuth.allowRemote) return true;
  const host = String(req.headers.host || req.hostname || '').toLowerCase();
  const remoteCandidates = [
    req.ip,
    req.socket?.remoteAddress,
    req.connection?.remoteAddress,
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  return host.startsWith('localhost:')
    || host.startsWith('127.0.0.1:')
    || host.startsWith('[::1]:')
    || host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || remoteCandidates.some((value) => (
      value === '127.0.0.1'
      || value === '::1'
      || value === '::ffff:127.0.0.1'
      || value.startsWith('::ffff:127.')
    ));
}

/**
 * Resolve a user's effective global role + workspace picker (Phase A1).
 * Shared by /sso, /dev-login, and the /session JWT fallback so all three
 * agree on the merge semantics:
 * - admin → every active workspace.
 * - ≥1 access row → role unchanged; picker = access ∪ technician workspaces,
 *   deduped with the access-row role winning the label — a PARTIAL grant
 *   never shrinks the picker below the user's technician coverage.
 * - 0 access rows + ≥1 technician profile → role 'agent'; picker = technician
 *   workspaces (pure technicians keep the agent-portal UX — decision recorded
 *   in plans/MEGA_2026-08-15_PLAN.md Phase A1).
 */
export async function resolveUserAccess(email, role, viewAs = currentViewAs()) {
  // "View as a role": exactly one workspace, with the role being tried on.
  if (viewAs?.mode === 'role') {
    const agentProfiles = await agentCompetencyService.getAgentProfiles(email);
    if (viewAs.role === 'agent') {
      const technician = (await workspaceRepository.getTechnicianWorkspaces(email)).filter((ws) => Number(ws.id) === Number(viewAs.workspaceId));
      return { role: 'agent', availableWorkspaces: technician, agentProfiles };
    }
    const ws = (await workspaceRepository.getAll()).find((w) => Number(w.id) === Number(viewAs.workspaceId));
    return {
      role: 'viewer',
      availableWorkspaces: ws ? [{ id: ws.id, name: ws.name, slug: ws.slug, role: viewAs.role, nativeTicketingEnabled: ws.nativeTicketingEnabled === true }] : [],
      agentProfiles,
    };
  }
  if (role === 'admin') {
    const availableWorkspaces = (await workspaceRepository.getAll()).map(ws => ({
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      role: 'admin',
      nativeTicketingEnabled: ws.nativeTicketingEnabled === true,
    }));
    const agentProfiles = await agentCompetencyService.getAgentProfiles(email);
    return { role, availableWorkspaces, agentProfiles };
  }

  const [accessible, technician, agentProfiles] = await Promise.all([
    workspaceRepository.getAccessibleWorkspaces(email),
    workspaceRepository.getTechnicianWorkspaces(email),
    agentCompetencyService.getAgentProfiles(email),
  ]);

  if (accessible.length > 0) {
    // ≥1 access row → full-app UX. A stale 'agent' role (JWT minted before an
    // ops grant, or dev-login role override) upgrades to 'viewer' so the
    // grant actually takes effect without a re-login.
    const effectiveRole = role === 'agent' ? 'viewer' : role;
    return { role: effectiveRole, availableWorkspaces: mergeWorkspaceLists(accessible, technician), agentProfiles };
  }
  if (agentProfiles.length > 0) {
    // Agents get their workspaces from technician profiles (native ticketing).
    return { role: 'agent', availableWorkspaces: technician, agentProfiles };
  }
  return { role, availableWorkspaces: [], agentProfiles };
}

async function resolveLoginAccess({ email, role, selectedWorkspaceId }) {
  const resolved = await resolveUserAccess(email, role);
  const resolvedRole = resolved.role;
  const availableWorkspaces = resolved.availableWorkspaces;
  const agentProfiles = resolved.agentProfiles;

  const requestedWorkspaceId = selectedWorkspaceId ? Number(selectedWorkspaceId) : null;
  const selectedWorkspace = requestedWorkspaceId
    ? availableWorkspaces.find(ws => Number(ws.id) === requestedWorkspaceId) || null
    : null;
  const fallbackWorkspace = availableWorkspaces.length === 1 ? availableWorkspaces[0] : null;

  return {
    role: resolvedRole,
    availableWorkspaces,
    agentProfiles,
    selectedWorkspaceId: selectedWorkspace?.id || fallbackWorkspace?.id || null,
    selectedWorkspaceName: selectedWorkspace?.name || fallbackWorkspace?.name || null,
    selectedWorkspaceSlug: selectedWorkspace?.slug || fallbackWorkspace?.slug || null,
  };
}

/**
 * POST /api/auth/sso
 * Validate Azure AD ID token and create session
 */
router.post(
  '/sso',
  throttleLogin,
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

    // Fetch workspaces this user has access to (merged picker — Phase A1)
    let availableWorkspaces = [];
    let agentProfiles = [];
    try {
      const resolved = await resolveUserAccess(email, role);
      role = resolved.role;
      availableWorkspaces = resolved.availableWorkspaces;
      agentProfiles = resolved.agentProfiles;
    } catch (err) {
      logger.warn('Failed to fetch workspaces during login:', err.message);
    }

    // Site stats: this endpoint also serves silent token renewals. Only a call
    // that arrives without a live session for this person is a sign-in.
    recordSignIn({
      email,
      name,
      method: 'sso',
      hadSession: req.session?.user?.email === email,
      hasAccess: role === 'admin' || availableWorkspaces.length > 0,
      userAgent: req.get('user-agent'),
    });

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
      expiresIn: config.session.jwtExpiresIn,
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
 * POST /api/auth/dev-login
 * Development-only SSO bypass for local visual testing.
 */
router.post(
  '/dev-login',
  throttleLogin,
  asyncHandler(async (req, res) => {
    if (config.isProduction || !config.devAuth.enabled || !isLocalDevRequest(req)) {
      throw new AuthenticationError('Development auth bypass is not available');
    }

    const adminEmails = await getAdminEmails();
    const email = String(config.devAuth.email || adminEmails[0] || 'dev-admin@ticketpulse.local').trim().toLowerCase();
    const name = String(config.devAuth.name || 'Dev Admin').trim() || 'Dev Admin';
    const roleFromConfig = String(config.devAuth.role || '').trim().toLowerCase();
    const role = ['admin', 'viewer', 'agent'].includes(roleFromConfig)
      ? roleFromConfig
      : 'admin';
    const requestedWorkspaceId = req.body?.workspaceId || config.devAuth.workspaceId || null;

    let access;
    try {
      access = await resolveLoginAccess({ email, role, selectedWorkspaceId: requestedWorkspaceId });
      if (!access.selectedWorkspaceId && access.availableWorkspaces.length > 0) {
        const firstWorkspace = access.availableWorkspaces[0];
        access.selectedWorkspaceId = firstWorkspace.id;
        access.selectedWorkspaceName = firstWorkspace.name;
        access.selectedWorkspaceSlug = firstWorkspace.slug;
      }
    } catch (err) {
      logger.warn('Failed to resolve workspaces during dev login:', err.message);
      access = {
        role,
        availableWorkspaces: [],
        agentProfiles: [],
        selectedWorkspaceId: null,
        selectedWorkspaceName: null,
        selectedWorkspaceSlug: null,
      };
    }

    const sanitizedAgentProfiles = sanitizeAgentProfiles(access.agentProfiles);
    req.session.user = {
      email,
      name,
      username: name,
      role: access.role,
      oid: 'dev-auth-bypass',
      loginTime: new Date().toISOString(),
      authMethod: 'dev-bypass',
      availableWorkspaces: access.availableWorkspaces,
      agentProfiles: sanitizedAgentProfiles,
      agentProfile: sanitizedAgentProfiles[0] || null,
      selectedWorkspaceId: access.selectedWorkspaceId,
      selectedWorkspaceName: access.selectedWorkspaceName,
      selectedWorkspaceSlug: access.selectedWorkspaceSlug,
    };

    const authToken = issueAuthToken({
      email,
      name,
      role: access.role,
      selectedWorkspaceId: access.selectedWorkspaceId,
    });
    const userPayload = buildResponseUser({
      email,
      name,
      role: access.role,
      selectedWorkspaceId: access.selectedWorkspaceId,
      agentProfiles: access.agentProfiles,
    });

    logger.warn('Development auth bypass login used', {
      email,
      role: access.role,
      selectedWorkspaceId: access.selectedWorkspaceId,
      ip: req.ip,
    });

    res.json({
      success: true,
      message: 'Development login successful',
      user: userPayload,
      authToken,
      availableWorkspaces: access.availableWorkspaces,
      selectedWorkspaceId: access.selectedWorkspaceId,
      selectedWorkspaceName: access.selectedWorkspaceName,
      selectedWorkspaceSlug: access.selectedWorkspaceSlug,
      devBypass: true,
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
      // Live role refresh (Mega 08-23 AC2): re-run resolveUserAccess so a
      // grant/revoke made since login takes effect on the NEXT session check,
      // not at the next re-login. The Bearer branch below always re-resolved;
      // this cookie branch used to re-mint the JWT from the stale session
      // role verbatim — the "stale-role trap". A DB hiccup keeps the session
      // values (refresh is best-effort, never a lockout).
      try {
        const sessionEmail = String(req.session.user.email || '').toLowerCase();
        const view = cleanViewAs(req.session.user.viewAs);
        // The super-admin list is read live for real sign-ins (QA 10-08 #1):
        // removing somebody from it used to leave their open session an admin
        // for up to seven days. Dev-login roles and a role being tried on are
        // left alone.
        let baseRole = req.session.user.role;
        if (req.session.user.authMethod === 'sso' && view?.mode !== 'role') {
          const admins = await getAdminEmails();
          if (admins.includes(sessionEmail)) baseRole = 'admin';
          // An empty list means it could not be read: never demote on that.
          else if (baseRole === 'admin' && admins.length) baseRole = 'viewer';
        }
        const resolved = await resolveUserAccess(sessionEmail, baseRole, view);
        const refreshedProfiles = sanitizeAgentProfiles(resolved.agentProfiles);
        req.session.user.role = resolved.role;
        req.session.user.availableWorkspaces = resolved.availableWorkspaces;
        req.session.user.agentProfiles = refreshedProfiles;
        req.session.user.agentProfile = refreshedProfiles[0] || null;
      } catch (err) {
        logger.warn('Live access refresh failed on /session (keeping session values):', err.message);
      }

      const sessionAgentProfiles = sanitizeAgentProfiles(req.session.user.agentProfiles || []);
      // Mint a fresh JWT alongside the session payload (Phase A1): the JWT
      // lives in tab-scoped sessionStorage, so a brand-new tab arrives here
      // with the httpOnly cookie but NO token — without this, that tab could
      // never authenticate SSE/Bearer paths. Mirrors the /sso response shape.
      const sessionView = cleanViewAs(req.session.user.viewAs);
      const authToken = issueAuthToken({
        email: req.session.user.email,
        name: req.session.user.name,
        role: req.session.user.role,
        selectedWorkspaceId: req.session.user.selectedWorkspaceId || null,
        viewAs: sessionView,
      });
      return res.json({
        success: true,
        authenticated: true,
        user: {
          email: req.session.user.email,
          name: req.session.user.name,
          username: req.session.user.username || req.session.user.name,
          role: req.session.user.role,
          ...(sessionView ? { viewAs: sessionView } : {}),
          hasAgentProfile: sessionAgentProfiles.length > 0,
          agentProfile: sessionAgentProfiles[0] || null,
          agentProfiles: sessionAgentProfiles,
        },
        authToken,
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
          if (email) {
            // Same merged-picker resolution as /sso and /dev-login (Phase A1).
            const resolved = await resolveUserAccess(email, role, cleanViewAs(decoded.viewAs));
            role = resolved.role;
            decoded.role = role;
            availableWorkspaces = resolved.availableWorkspaces;
            agentProfiles = resolved.agentProfiles;
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
              ...(cleanViewAs(decoded.viewAs) ? { viewAs: cleanViewAs(decoded.viewAs) } : {}),
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
          viewAs: decoded.viewAs,
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

// ---------------------------------------------------------------------------
// View as (QA 10-08 #2) — see services/viewAsContext.js
// ---------------------------------------------------------------------------

/** Who is calling, by cookie session or by token (these routes sit before requireAuth). */
function callerIdentity(req) {
  if (req.session?.user?.email) return req.session.user;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      return jwt.verify(header.substring(7), config.session.secret, { algorithms: ['HS256'] });
    } catch { /* not signed in */ }
  }
  return null;
}

function replyWithIdentity(req, res, next, { email, name, resolved, selectedWorkspaceId, viewAs, authMethod }) {
  const ws = resolved.availableWorkspaces.find((w) => Number(w.id) === Number(selectedWorkspaceId)) || (resolved.availableWorkspaces.length === 1 ? resolved.availableWorkspaces[0] : null);
  const profiles = sanitizeAgentProfiles(resolved.agentProfiles);
  const user = {
    email,
    name,
    username: name,
    role: resolved.role,
    loginTime: new Date().toISOString(),
    authMethod,
    availableWorkspaces: resolved.availableWorkspaces,
    agentProfiles: profiles,
    agentProfile: profiles[0] || null,
    selectedWorkspaceId: ws?.id || null,
    selectedWorkspaceName: ws?.name || null,
    selectedWorkspaceSlug: ws?.slug || null,
    ...(viewAs ? { viewAs } : {}),
  };
  const send = () => res.json({
    success: true,
    user: buildResponseUser({ email, name, role: resolved.role, selectedWorkspaceId: user.selectedWorkspaceId, agentProfiles: resolved.agentProfiles, viewAs }),
    authToken: issueAuthToken({ email, name, role: resolved.role, selectedWorkspaceId: user.selectedWorkspaceId, viewAs }),
    availableWorkspaces: resolved.availableWorkspaces,
    selectedWorkspaceId: user.selectedWorkspaceId,
    viewAs: viewAs || null,
  });
  if (!req.session) return send();
  req.session.user = user;
  // The page reloads right after this call: the session must be stored first.
  return req.session.save((err) => (err ? next(err) : send()));
}

/**
 * POST /api/auth/view-as  { mode: 'role', role, workspaceId } | { mode: 'person', email }
 * Super admins only. The response carries a new token; the page reloads on it.
 */
router.post('/view-as', asyncHandler(async (req, res, next) => {
  const me = callerIdentity(req);
  if (!me?.email) throw new AuthenticationError('Authentication required');
  const myEmail = String(me.email).toLowerCase();
  const admins = await getAdminEmails();
  const reallyAdmin = me.role === 'admin' && !me.viewAs && (admins.includes(myEmail) || me.authMethod === 'dev-bypass' || process.env.NODE_ENV !== 'production');
  if (me.viewAs) return res.status(409).json({ success: false, code: 'view_as_active', message: 'Exit the current view first' });
  if (!reallyAdmin) return res.status(403).json({ success: false, code: 'super_admin_required', message: 'Only a super admin can view Ticket Pulse as someone else' });

  const mode = req.body?.mode;
  const base = { by: myEmail, byName: me.name || me.username || myEmail, since: new Date().toISOString() };
  if (mode === 'role') {
    const role = String(req.body?.role || '');
    const workspaceId = Number(req.body?.workspaceId);
    if (!VIEW_AS_ROLES.includes(role)) throw new ValidationError(`role must be one of: ${VIEW_AS_ROLES.join(', ')}`);
    const ws = Number.isInteger(workspaceId) ? (await workspaceRepository.getAll()).find((w) => Number(w.id) === workspaceId) : null;
    if (!ws) throw new ValidationError('Pick a workspace to view');
    const viewAs = cleanViewAs({ ...base, mode: 'role', role, workspaceId, label: `${VIEW_AS_ROLE_LABELS[role]} in ${ws.name}` });
    const resolved = await resolveUserAccess(myEmail, 'viewer', viewAs);
    if (!resolved.availableWorkspaces.length) {
      throw new ValidationError(role === 'agent' ? `You have no technician profile in ${ws.name}, so there is no agent view of it for you — view as one of its agents instead` : 'That workspace is not available');
    }
    logger.info(`View as started: ${myEmail} → ${viewAs.label}`);
    return replyWithIdentity(req, res, next, { email: myEmail, name: me.name || myEmail, resolved, selectedWorkspaceId: workspaceId, viewAs, authMethod: me.authMethod || 'sso' });
  }
  if (mode === 'person') {
    const target = String(req.body?.email || '').trim().toLowerCase();
    if (!target || !target.includes('@')) throw new ValidationError('Give the e-mail of the person to view as');
    if (target === myEmail) throw new ValidationError('That is you — pick a role to try on instead');
    const resolved = await resolveUserAccess(target, admins.includes(target) ? 'admin' : 'viewer', null);
    if (!resolved.availableWorkspaces.length) throw new ValidationError(`${target} has no access to Ticket Pulse, so there is nothing to see as them`);
    const name = resolved.agentProfiles?.[0]?.name || String(req.body?.name || '').trim().slice(0, 120) || target;
    const viewAs = cleanViewAs({ ...base, mode: 'person', label: name });
    logger.info(`View as started: ${myEmail} → ${target} (read-only)`);
    return replyWithIdentity(req, res, next, { email: target, name, resolved, selectedWorkspaceId: me.selectedWorkspaceId, viewAs, authMethod: 'view-as' });
  }
  throw new ValidationError('mode must be "role" or "person"');
}));

/** DELETE /api/auth/view-as — back to yourself. */
router.delete('/view-as', asyncHandler(async (req, res, next) => {
  const me = callerIdentity(req);
  const view = cleanViewAs(me?.viewAs);
  if (!me?.email || !view) return res.status(409).json({ success: false, code: 'view_as_inactive', message: 'You are not viewing as anyone' });
  const admins = await getAdminEmails();
  const still = admins.includes(view.by) || process.env.NODE_ENV !== 'production';
  const resolved = await resolveUserAccess(view.by, still ? 'admin' : 'viewer', null);
  logger.info(`View as ended: ${view.by} ← ${view.label}`);
  return replyWithIdentity(req, res, next, { email: view.by, name: view.byName || view.by, resolved, selectedWorkspaceId: me.selectedWorkspaceId, viewAs: null, authMethod: 'sso' });
}));

export default router;
