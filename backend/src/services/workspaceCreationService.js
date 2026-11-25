import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ConflictError, ValidationError } from '../utils/errors.js';
import { RESERVED_WORKSPACE_SLUGS } from './ticketShortLinkService.js';
import { recordAccessEvent, ACTIONS } from './accessAuditService.js';

/**
 * "New workspace" (QA 11-24, item 4): a super admin creates a workspace that
 * lives in Ticket Pulse only — native ticketing on, no FreshService link.
 *
 * Until now every workspace came from FreshService (Settings → Workspaces →
 * Discover → Activate), and the integration sandboxes were made by scripts
 * (scripts/simorgh-provision.mjs and friends) as INACTIVE rows with
 * freshservice_workspace_id 0. This makes the same kind of row, but ACTIVE, so
 * it shows in the picker; utils/workspaceFsBinding.js keeps every FreshService
 * job (sync, fast lane, mirror, sync health) away from it.
 *
 * Seeds what a native workspace needs to take its first ticket:
 *   - the four system statuses (Open, Pending, Resolved, Closed) — the same
 *     rows the status-registry migration gave every workspace;
 *   - one internal group, "General", set as the default group for new tickets;
 *   - the ticket types, copied from the IT workspace (workspace 1) without
 *     their FreshService ids — what the sandbox scripts do;
 *   - an admin grant for the person who created it.
 * The route then runs the usual initialiser (business hours, LLM config, noise
 * rules — which stay empty outside IT) and loads the holidays.
 * Left for the admin: categories, SLA policies, mailboxes, members, workflows,
 * Teams and AI assignment (all off/empty until set up).
 */

export const SOURCE_WORKSPACE_ID = 1; // IT: internal domains + ticket types are copied from here
export const DEFAULT_GROUP_NAME = 'General';
const SLUG_MAX = 30;
const SYSTEM_STATUSES = [
  { name: 'Open', color: 'blue' },
  { name: 'Pending', color: 'amber' },
  { name: 'Resolved', color: 'emerald' },
  { name: 'Closed', color: 'slate' },
];

/** "Health & Safety (West)" → "health-and-safety-west". Never empty. */
export function slugifyWorkspaceName(name) {
  let slug = String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  if (!slug) slug = 'team';
  // A slug is the first part of the short ticket links (/it/TP-10000): it may
  // not be a page name or look like a ticket number.
  if (RESERVED_WORKSPACE_SLUGS.includes(slug) || /^(tp-?)?\d+$/.test(slug)) slug = `${slug}-ws`.slice(0, SLUG_MAX);
  return slug;
}

/** The first of base, base-2, base-3 … that no workspace slug or link name uses. */
export function uniqueSlug(base, taken = new Set()) {
  const used = new Set([...taken].map((s) => String(s || '').toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ConflictError('Could not find a free short name for this workspace');
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Same normalisation as workspaceRepository.update: bare lowercase domains, deduped. */
export function cleanDomains(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map((d) => String(d || '').trim().toLowerCase().replace(/^.*@/, ''))
    .filter((d) => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d)))];
}

async function takenSlugs() {
  const rows = await prisma.workspace.findMany({ select: { id: true, slug: true } });
  const taken = new Set(rows.map((r) => String(r.slug || '').toLowerCase()));
  // Link names live in app_settings (workspace_link_name_ws<id>).
  const links = await Promise.resolve()
    .then(() => prisma.appSettings.findMany({ where: { key: { startsWith: 'workspace_link_name_ws' } }, select: { value: true } }))
    .catch(() => []);
  for (const l of links || []) if (l?.value) taken.add(String(l.value).trim().toLowerCase());
  return taken;
}

/**
 * Create the workspace and its seed in one transaction.
 * Returns { workspace, seeded: { statuses, group, ticketTypes }, creatorGranted }.
 */
export async function createNativeWorkspace({ name, defaultTimezone, internalDomains, actorEmail } = {}) {
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim();
  if (!cleanName) throw new ValidationError('Give the workspace a name');
  if (cleanName.length > 100) throw new ValidationError('The name can be up to 100 characters');
  const tz = String(defaultTimezone || 'America/Vancouver').trim();
  if (!isValidTimeZone(tz)) throw new ValidationError(`"${tz}" is not a time zone (use a name like America/Vancouver)`);

  const sameName = await prisma.workspace.findFirst({
    where: { name: { equals: cleanName, mode: 'insensitive' } },
    select: { id: true, isActive: true },
  });
  if (sameName) {
    throw new ConflictError(sameName.isActive
      ? `A workspace called "${cleanName}" already exists`
      : `An inactive workspace called "${cleanName}" already exists; re-activate it instead`);
  }

  const source = await prisma.workspace.findUnique({
    where: { id: SOURCE_WORKSPACE_ID },
    select: { internalDomains: true },
  }).catch(() => null);
  const domains = internalDomains === undefined || internalDomains === null
    ? cleanDomains(source?.internalDomains || [])
    : cleanDomains(internalDomains);

  const slug = uniqueSlug(slugifyWorkspaceName(cleanName), await takenSlugs());
  const creator = actorEmail ? String(actorEmail).trim().toLowerCase() : null;

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: cleanName,
          slug,
          // 0 = no FreshService link (utils/workspaceFsBinding.js).
          freshserviceWorkspaceId: BigInt(0),
          defaultTimezone: tz,
          nativeTicketingEnabled: true,
          internalDomains: domains,
          isActive: true,
        },
      });

      await tx.ticketStatusDefinition.createMany({
        data: SYSTEM_STATUSES.map((s, i) => ({
          workspaceId: workspace.id, name: s.name, baseStatus: s.name, color: s.color, sortOrder: i, isSystem: true, isActive: true,
        })),
        skipDuplicates: true,
      });

      const group = await tx.group.create({
        data: { workspaceId: workspace.id, name: DEFAULT_GROUP_NAME, origin: 'local', freshserviceId: null, isActive: true },
      });
      const withDefault = await tx.workspace.update({
        where: { id: workspace.id },
        data: { defaultInternalGroupId: group.id },
      });

      const types = await tx.ticketTypeDefinition.findMany({
        where: { workspaceId: SOURCE_WORKSPACE_ID, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      if (types.length) {
        await tx.ticketTypeDefinition.createMany({
          data: types.map((t) => ({
            workspaceId: workspace.id,
            name: t.name,
            description: t.description ?? null,
            aliases: t.aliases || [],
            fsTypeValue: null,
            fsChoiceId: null,
            fsDetectedAt: null,
            aiAssignable: t.aiAssignable !== false,
            isDefault: t.isDefault === true,
            color: t.color || 'slate',
            abbreviation: t.abbreviation ?? null,
            sortOrder: t.sortOrder ?? 0,
            isActive: true,
            source: 'manual',
          })),
        });
      }

      if (creator) {
        await tx.workspaceAccess.upsert({
          where: { email_workspaceId: { email: creator, workspaceId: workspace.id } },
          update: { role: 'admin' },
          create: { email: creator, workspaceId: workspace.id, role: 'admin' },
        });
      }

      return {
        workspace: withDefault,
        seeded: {
          statuses: SYSTEM_STATUSES.map((s) => s.name),
          group: { id: group.id, name: group.name },
          ticketTypes: types.map((t) => t.name),
        },
        creatorGranted: Boolean(creator),
      };
    });
  } catch (err) {
    if (err?.code === 'P2002') throw new ConflictError('Another workspace took that short name a moment ago; try again');
    throw err;
  }

  logger.info(`Workspace created in Ticket Pulse: "${result.workspace.name}" (id=${result.workspace.id}, slug=${result.workspace.slug}) by ${creator || 'unknown'}`);

  await recordAccessEvent({
    workspaceId: result.workspace.id,
    actorEmail: creator,
    action: ACTIONS.WORKSPACE_CREATED,
    targetLabel: result.workspace.name,
    newValue: result.workspace.slug,
    details: {
      timezone: tz,
      internalDomains: domains,
      freshserviceLinked: false,
      seeded: result.seeded,
    },
  });
  if (creator) {
    await recordAccessEvent({
      workspaceId: result.workspace.id, actorEmail: creator, action: ACTIONS.ROLE_GRANTED,
      targetEmail: creator, oldValue: null, newValue: 'admin',
    });
  }
  return result;
}

export default { createNativeWorkspace, slugifyWorkspaceName, uniqueSlug, isValidTimeZone, cleanDomains };
