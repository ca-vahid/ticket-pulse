/**
 * Who gets a workspace's report e-mails (noise-close digest, urgent-response
 * week, unmatched replies, Auto-help morning summary): the workspace's admins
 * plus every super admin (19 Oct 2026, Vahid: "the super admins should also
 * receive these emails"). Super admins are app-wide: the admin_emails setting,
 * else the ADMIN_EMAILS environment list, the same list sign-in uses.
 */
import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';

const clean = (list) => [...new Set(list.map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@')))];

export async function superAdminEmails() {
  const raw = await Promise.resolve().then(() => settingsRepository.get('admin_emails')).catch(() => null);
  const source = raw && String(raw).trim() ? String(raw) : (process.env.ADMIN_EMAILS || '');
  return clean(source.split(','));
}

export async function workspaceAdminEmails(workspaceId) {
  const rows = await Promise.resolve()
    .then(() => prisma.workspaceAccess.findMany({ where: { workspaceId: Number(workspaceId), role: 'admin' }, select: { email: true }, take: 200 }))
    .catch(() => []);
  return clean((rows || []).map((r) => r.email));
}

export async function reportRecipients(workspaceId) {
  const [admins, supers] = await Promise.all([workspaceAdminEmails(workspaceId), superAdminEmails()]);
  return clean([...admins, ...supers]);
}

export default { reportRecipients, superAdminEmails, workspaceAdminEmails };
