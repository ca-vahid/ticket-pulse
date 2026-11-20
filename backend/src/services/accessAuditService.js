import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { reportRecipients } from './reportRecipients.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';

/**
 * Access history + new-credential alerts (20 Nov 2026).
 *
 * Why: an IT member was made admin for 1 h 40 min, created an API key with
 * broad scopes and no IP lock, and was put back to reviewer. The only trace
 * was a server log line that rotates away in days. Every access change now
 * lands in access_audit_events (kept), and a new or rotated credential mails
 * the workspace's admins and the super admins at once.
 *
 * Never throws: auditing must not break the change it records.
 */

export const ACTIONS = Object.freeze({
  ROLE_GRANTED: 'role_granted',
  ROLE_CHANGED: 'role_changed',
  ACCESS_REVOKED: 'access_revoked',
  DASHBOARD_VIEW_CHANGED: 'dashboard_view_changed',
  ADMIN_LIST_CHANGED: 'admin_list_changed',
  API_KEY_CREATED: 'api_key_created',
  API_KEY_UPDATED: 'api_key_updated',
  API_KEY_ENABLED: 'api_key_enabled',
  API_KEY_ROTATED: 'api_key_rotated',
  API_KEY_REVOKED: 'api_key_revoked',
  API_KEY_DELETED: 'api_key_deleted',
  OAUTH_CLIENT_CREATED: 'oauth_client_created',
  OAUTH_CLIENT_UPDATED: 'oauth_client_updated',
  OAUTH_CLIENT_ENABLED: 'oauth_client_enabled',
  OAUTH_CLIENT_ROTATED: 'oauth_client_rotated',
  OAUTH_CLIENT_REVOKED: 'oauth_client_revoked',
  OAUTH_CLIENT_DELETED: 'oauth_client_deleted',
});

// The changes that hand out a working secret, or switch one back on: these alert.
const ALERT_ACTIONS = new Set([
  ACTIONS.API_KEY_CREATED, ACTIONS.API_KEY_ROTATED, ACTIONS.API_KEY_ENABLED,
  ACTIONS.OAUTH_CLIENT_CREATED, ACTIONS.OAUTH_CLIENT_ROTATED, ACTIONS.OAUTH_CLIENT_ENABLED,
]);

const clip = (v, n = 255) => (v === null || v === undefined ? null : String(v).slice(0, n));

/** Record one change. Returns the row, or null when it could not be stored. */
export async function recordAccessEvent({
  workspaceId = null, actorEmail = null, action, targetEmail = null, targetLabel = null,
  oldValue = null, newValue = null, details = null,
}) {
  try {
    const row = await prisma.accessAuditEvent.create({
      data: {
        workspaceId: workspaceId === null || workspaceId === undefined ? null : Number(workspaceId),
        actorEmail: clip(actorEmail ? String(actorEmail).toLowerCase() : null),
        action: clip(action, 40),
        targetEmail: clip(targetEmail ? String(targetEmail).toLowerCase() : null),
        targetLabel: clip(targetLabel),
        oldValue: clip(oldValue),
        newValue: clip(newValue),
        details: details || undefined,
      },
    });
    return row;
  } catch (err) {
    logger.warn(`Access audit: could not record ${action} (${err.message})`);
    return null;
  }
}

/**
 * A credential change: record it, and mail the admins when it hands out a
 * working secret. `credential` is the API key / OAuth client as the service
 * returned it (never the secret itself).
 */
export async function recordCredentialEvent({ workspaceId, actorEmail, action, credential = {}, extra = {} }) {
  const kind = action.startsWith('oauth_') ? 'oauth' : 'api_key';
  const details = {
    kind,
    id: credential.id ?? null,
    prefix: credential.keyPrefix || credential.clientId || null,
    scopes: Array.isArray(credential.scopes) ? credential.scopes : undefined,
    ipAllowlist: Array.isArray(credential.ipAllowlist) ? credential.ipAllowlist : undefined,
    expiresAt: credential.expiresAt || null,
    trustedIntake: credential.trustedIntake === true ? true : undefined,
    mode: credential.mode || undefined,
    ...extra,
  };
  const row = await recordAccessEvent({ workspaceId, actorEmail, action, targetLabel: credential.name || null, details });
  if (ALERT_ACTIONS.has(action)) {
    await alertNewCredential({ workspaceId, actorEmail, action, credential, details }).catch((err) => {
      logger.warn(`Access audit: new-credential alert failed (${err.message})`);
    });
  }
  return row;
}

/** Access history for a workspace (newest first); super admins also see app-wide events. */
export async function listAccessEvents(workspaceId, { includeGlobal = false, limit = 100, before = null, person = null } = {}) {
  const take = Math.max(1, Math.min(Number(limit) || 100, 300));
  const scope = includeGlobal ? { OR: [{ workspaceId: Number(workspaceId) }, { workspaceId: null }] } : { workspaceId: Number(workspaceId) };
  const where = { AND: [scope] };
  if (before) where.AND.push({ id: { lt: Number(before) } });
  const p = String(person || '').trim().toLowerCase();
  if (p) where.AND.push({ OR: [{ actorEmail: { contains: p } }, { targetEmail: { contains: p } }, { targetLabel: { contains: p, mode: 'insensitive' } }] });
  const rows = await prisma.accessAuditEvent.findMany({ where, orderBy: { id: 'desc' }, take });
  return { items: rows, nextBefore: rows.length === take ? rows[rows.length - 1].id : null };
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function whenPacific(d = new Date()) {
  return new Date(d).toLocaleString('en-US', { timeZone: 'America/Vancouver', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';
}

/** The alert e-mail: who, what, how much access, and where to look. Exported for tests. */
export function renderCredentialAlert({ workspaceName, actorEmail, action, credential, details, at = new Date(), settingsUrl }) {
  const isOauth = action.startsWith('oauth_');
  const rotated = action.endsWith('_rotated');
  const enabled = action.endsWith('_enabled');
  const kindLabel = isOauth ? 'OAuth client' : 'API key';
  const verb = rotated ? 'got a new secret' : enabled ? 'was switched back on' : 'was created';
  const name = credential.name || '(no name)';
  const scopes = Array.isArray(details.scopes) && details.scopes.length ? details.scopes.join(', ') : 'none listed';
  const ip = Array.isArray(details.ipAllowlist) && details.ipAllowlist.length ? details.ipAllowlist.join(', ') : 'none: it works from any address';
  const expires = details.expiresAt ? new Date(details.expiresAt).toISOString().slice(0, 10) : 'never';
  const subject = `${enabled ? 'Switched back on' : 'New'} ${kindLabel} in ${workspaceName}: "${name}"${rotated ? ' (new secret)' : ''}`;
  const rows = [
    ['Who', actorEmail || 'unknown'],
    ['When', whenPacific(at)],
    ['Access', scopes],
    ['IP lock', ip],
    ['Expires', expires],
    ...(details.trustedIntake ? [['Trusted intake', 'yes: its category and priority are final']] : []),
    ...(details.prefix ? [[isOauth ? 'Client id' : 'Key prefix', details.prefix]] : []),
  ];
  const text = [
    `The ${kindLabel} "${name}" ${verb} in ${workspaceName}.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `If you didn't expect this, switch it off in Settings > API: ${settingsUrl}`,
    'You get this because you are an admin of this workspace or a super admin of Ticket Pulse.',
  ].join('\n');
  const cell = 'font-family:Calibri,Segoe UI,Arial,sans-serif;font-size:14px;line-height:20px;color:#1f2937;padding:4px 12px 4px 0;vertical-align:top;';
  const html = `<div style="font-family:Calibri,Segoe UI,Arial,sans-serif;font-size:15px;line-height:22px;color:#1f2937;">
<p style="margin:0 0 12px;">The ${esc(kindLabel)} <b>${esc(name)}</b> ${esc(verb)} in <b>${esc(workspaceName)}</b>.</p>
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 14px;">
${rows.map(([k, v]) => `<tr><td style="${cell}color:#6b7280;">${esc(k)}</td><td style="${cell}">${esc(v)}</td></tr>`).join('\n')}
</table>
<p style="margin:0 0 12px;">If you didn't expect this, switch it off in <a href="${esc(settingsUrl)}" style="color:#1d4ed8;">Settings &gt; API</a>.</p>
<p style="margin:0;font-size:12px;line-height:18px;color:#6b7280;">You get this because you are an admin of this workspace or a super admin of Ticket Pulse.</p>
</div>`;
  return { subject, text, html };
}

async function alertNewCredential({ workspaceId, actorEmail, action, credential, details }) {
  const to = await reportRecipients(workspaceId);
  if (!to.length) return;
  const ws = await Promise.resolve().then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { name: true } })).catch(() => null);
  const base = resolvePublicBaseUrl() || '';
  const settingsUrl = `${base}/settings#api-keys`;
  const { subject, text, html } = renderCredentialAlert({ workspaceName: ws?.name || `workspace ${workspaceId}`, actorEmail, action, credential, details, settingsUrl });
  const { deliverTransactionalEmail } = await import('./transactionalEmailService.js');
  await deliverTransactionalEmail({ workspaceId, to, subject, html, text, label: 'credential alert' });
  logger.info(`Access audit: ${action} alert sent to ${to.length} admin(s)`);
}

export default { recordAccessEvent, recordCredentialEvent, listAccessEvents, renderCredentialAlert, ACTIONS };
