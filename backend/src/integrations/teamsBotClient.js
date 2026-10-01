/**
 * Microsoft Teams bot plumbing (plans/TEAMS_NOTIFICATIONS_PLAN.md).
 *
 * Talks the Bot Framework REST protocol directly — no SDK (the Bot Framework
 * SDK lost support at the end of 2025; the protocol is stable):
 *  - inbound: JWTs from the Bot Framework channel are checked against the
 *    Bot Framework OpenID keys (issuer + audience = our app id);
 *  - outbound: client-credentials token for https://api.botframework.com and
 *    POST/PUT to the conversation's serviceUrl.
 * Graph (same app registration, application permissions): resolve people by
 * e-mail, install the Ticket Pulse app for a user, bell notifications.
 *
 * Config: TEAMS_BOT_APP_ID, TEAMS_BOT_APP_PASSWORD, TEAMS_BOT_TENANT_ID.
 */
import axios from 'axios';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

const BOT_OPENID = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const BOT_ISSUER = 'https://api.botframework.com';
export const DEFAULT_SERVICE_URL = 'https://smba.trafficmanager.net/teams/';

export function teamsConfig() {
  return {
    appId: process.env.TEAMS_BOT_APP_ID || null,
    password: process.env.TEAMS_BOT_APP_PASSWORD || null,
    tenantId: process.env.TEAMS_BOT_TENANT_ID || null,
  };
}

export function isTeamsConfigured() {
  const c = teamsConfig();
  return Boolean(c.appId && c.password && c.tenantId);
}

// ---------------------------------------------------------------- tokens

const tokenCache = new Map(); // scope -> { token, exp }

async function clientToken(scope) {
  const hit = tokenCache.get(scope);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const { appId, password, tenantId } = teamsConfig();
  if (!appId || !password || !tenantId) throw new Error('Teams bot is not configured (TEAMS_BOT_APP_ID / _PASSWORD / _TENANT_ID)');
  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({ client_id: appId, client_secret: password, grant_type: 'client_credentials', scope }),
    { timeout: 15_000 },
  );
  const token = res.data.access_token;
  tokenCache.set(scope, { token, exp: Date.now() + (Number(res.data.expires_in) || 3600) * 1000 });
  return token;
}

const botToken = () => clientToken('https://api.botframework.com/.default');
const graphToken = () => clientToken('https://graph.microsoft.com/.default');

// ---------------------------------------------------------------- inbound auth

let jwksClient = null;
let jwksUri = null;

async function signingKey(kid) {
  if (!jwksClient) {
    const cfg = await axios.get(BOT_OPENID, { timeout: 10_000 });
    jwksUri = cfg.data.jwks_uri;
    jwksClient = jwksRsa({ jwksUri, cache: true, cacheMaxAge: 24 * 3600 * 1000, rateLimit: true });
  }
  const key = await jwksClient.getSigningKey(kid);
  return key.getPublicKey();
}

/**
 * Verify the Authorization header of an inbound Bot Framework request.
 * Returns the decoded claims or throws. The activity's serviceUrl must match
 * the token's serviceurl claim when present (Bot Framework rule).
 */
export async function verifyInbound(authHeader, activity) {
  const { appId } = teamsConfig();
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('missing bearer token');
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid) throw new Error('token has no key id');
  const key = await signingKey(decoded.header.kid);
  const claims = jwt.verify(token, key, { issuer: BOT_ISSUER, audience: appId, algorithms: ['RS256'], clockTolerance: 300 });
  if (claims.serviceurl && activity?.serviceUrl && String(claims.serviceurl).replace(/\/$/, '') !== String(activity.serviceUrl).replace(/\/$/, '')) {
    throw new Error('serviceUrl mismatch');
  }
  return claims;
}

// ---------------------------------------------------------------- outbound (Bot Connector)

const base = (serviceUrl) => String(serviceUrl || DEFAULT_SERVICE_URL).replace(/\/?$/, '/');

async function connector(method, url, data) {
  const token = await botToken();
  const res = await axios({ method, url, data, timeout: 15_000, headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

/** Open (or reuse) the 1:1 chat between the bot and a user; Teams returns the existing one. */
export async function createPersonalConversation({ aadObjectId, serviceUrl = DEFAULT_SERVICE_URL }) {
  const { appId, tenantId } = teamsConfig();
  const body = {
    bot: { id: `28:${appId}` },
    members: [{ id: aadObjectId }],
    tenantId,
    isGroup: false,
    channelData: { tenant: { id: tenantId } },
  };
  const data = await connector('post', `${base(serviceUrl)}v3/conversations`, body);
  return { conversationId: data.id, serviceUrl: base(serviceUrl) };
}

export function cardActivity(card, { summary = null, text = null } = {}) {
  return {
    type: 'message',
    ...(summary ? { summary } : {}),
    ...(text ? { text } : {}),
    attachments: card ? [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] : [],
  };
}

export async function sendToConversation({ serviceUrl, conversationId }, activity) {
  const data = await connector('post', `${base(serviceUrl)}v3/conversations/${encodeURIComponent(conversationId)}/activities`, activity);
  return data?.id || null;
}

export async function updateActivity({ serviceUrl, conversationId, activityId }, activity) {
  await connector('put', `${base(serviceUrl)}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`, { ...activity, id: activityId });
}

export async function replyToActivity(incoming, activity) {
  const url = `${base(incoming.serviceUrl)}v3/conversations/${encodeURIComponent(incoming.conversation.id)}/activities/${encodeURIComponent(incoming.id)}`;
  return connector('post', url, { ...activity, replyToId: incoming.id });
}

// ---------------------------------------------------------------- Graph

async function graph(method, path, data, { headers = {} } = {}) {
  const token = await graphToken();
  const res = await axios({ method, url: `https://graph.microsoft.com/v1.0${path}`, data, timeout: 15_000, headers: { Authorization: `Bearer ${token}`, ...headers } });
  return res.data;
}

/** { id, mail, userPrincipalName, displayName } or null. Accepts an e-mail or UPN. */
export async function findUser(emailOrId) {
  const key = String(emailOrId || '').trim();
  if (!key) return null;
  try {
    return await graph('get', `/users/${encodeURIComponent(key)}?$select=id,mail,userPrincipalName,displayName`);
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }
  // Aliases: fall back to a mail / proxyAddresses match.
  const q = key.replace(/'/g, "''");
  const res = await graph('get', `/users?$select=id,mail,userPrincipalName,displayName&$filter=mail eq '${q}' or proxyAddresses/any(p:p eq 'smtp:${q}')&$count=true`, null, { headers: { ConsistencyLevel: 'eventual' } });
  return res.value?.[0] || null;
}

let catalogAppIdCache = null;

/** The org-catalog id of the Ticket Pulse Teams app (externalId = bot app id), or null if not uploaded yet. */
export async function catalogAppId({ refresh = false } = {}) {
  if (catalogAppIdCache && !refresh) return catalogAppIdCache;
  const { appId } = teamsConfig();
  const res = await graph('get', `/appCatalogs/teamsApps?$filter=externalId eq '${appId}'`);
  catalogAppIdCache = res.value?.[0]?.id || null;
  return catalogAppIdCache;
}

/**
 * Install the Ticket Pulse app for a user (idempotent). Teams then sends the
 * bot a conversationUpdate for the new personal chat.
 * Returns 'installed' | 'already' | 'no_catalog_app'.
 */
export async function installForUser(aadObjectId) {
  const teamsAppId = await catalogAppId();
  if (!teamsAppId) return 'no_catalog_app';
  try {
    await graph('post', `/users/${encodeURIComponent(aadObjectId)}/teamwork/installedApps`, {
      'teamsApp@odata.bind': `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${teamsAppId}`,
    });
    return 'installed';
  } catch (err) {
    if (err.response?.status === 409) return 'already';
    throw err;
  }
}

/** A line in the user's Teams bell list; the app must be installed for them. */
const installationCache = new Map(); // aadObjectId -> installedApps id

/** The id of the Ticket Pulse app installation for a user (null when not installed). */
async function userInstallationId(aadObjectId) {
  if (installationCache.has(aadObjectId)) return installationCache.get(aadObjectId);
  const { appId } = teamsConfig();
  const res = await graph('get', `/users/${encodeURIComponent(aadObjectId)}/teamwork/installedApps?$expand=teamsApp&$filter=teamsApp/externalId eq '${appId}'`);
  const id = res.value?.[0]?.id || null;
  if (id) installationCache.set(aadObjectId, id);
  return id;
}

/**
 * A line in the user's Teams bell list; the app must be installed for them.
 * The topic is the app installation (source 'entityUrl') — clicking the bell
 * opens the Ticket Pulse chat, where the card with the ticket link sits.
 * A 'text' topic would need a teams.microsoft.com deep link as webUrl; Graph
 * refuses our own site ("Weburl must start with a valid Microsoft Teams
 * domain", every bell failed on prod 1 Oct 2026).
 */
export async function sendActivityFeed(aadObjectId, { title, preview }) {
  const installationId = await userInstallationId(aadObjectId);
  if (!installationId) throw new Error('Ticket Pulse app is not installed for this user');
  await graph('post', `/users/${encodeURIComponent(aadObjectId)}/teamwork/sendActivityNotification`, {
    topic: { source: 'entityUrl', value: `https://graph.microsoft.com/v1.0/users/${aadObjectId}/teamwork/installedApps/${installationId}` },
    activityType: 'ticketAlert',
    previewText: { content: String(preview || title || '').slice(0, 150) },
    templateParameters: [{ name: 'title', value: String(title || '').slice(0, 150) }],
  });
}

/** Post a card to a team channel through a Power Automate "Workflows" webhook URL. */
export async function postToWorkflowWebhook(url, card) {
  await axios.post(url, cardActivity(card), { timeout: 15_000 });
}

/** Health check for the admin panel: can we get both tokens? */
export async function probe() {
  const out = { configured: isTeamsConfigured(), botToken: false, graphToken: false, catalogAppId: null, error: null };
  if (!out.configured) return out;
  try { await botToken(); out.botToken = true; } catch (err) { out.error = `Bot token: ${err.response?.data?.error_description || err.message}`; }
  try { await graphToken(); out.graphToken = true; out.catalogAppId = await catalogAppId({ refresh: true }); } catch (err) { out.error = out.error || `Graph: ${err.response?.data?.error?.message || err.message}`; }
  return out;
}

export function describeError(err) {
  const d = err?.response?.data;
  return String(d?.error?.message || d?.message || d?.error_description || err?.message || err).slice(0, 400);
}

export default {
  teamsConfig, isTeamsConfigured, verifyInbound, createPersonalConversation, cardActivity,
  sendToConversation, updateActivity, replyToActivity, findUser, catalogAppId, installForUser,
  sendActivityFeed, postToWorkflowWebhook, probe, describeError, DEFAULT_SERVICE_URL,
};

