import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { BlobServiceClient } from '@azure/storage-blob';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/**
 * App-level backup snapshots + granular restore (BACKUP_RESTORE_PLAN Phases 2/3).
 *
 * Snapshot format: gzipped JSON — { manifest, modules } where
 *   manifest = { formatVersion, appVersion, scope, tier, workspaceId,
 *                workspaceName, createdAt, counts: { <moduleKey>: n }, modules: [meta] }
 *   modules  = { <moduleKey>: [rows...] }
 * Site-scope bundles key modules as `ws<id>:<module>`.
 *
 * Storage mirrors attachmentService: one Azure storage account, private
 * `backups-prod` / `backups-dev` containers (BACKUP_CONTAINER override). When
 * AZURE_STORAGE_CONNECTION_STRING is absent (dev), bundles land in
 * backend/backups/local/ and blobName is recorded as `local:<filename>`.
 *
 * Config modules are restorable (dry-run diff + merge/replace apply, incl.
 * cross-workspace). Tier 'config_data' modules are EXPORT-ONLY — TP-native
 * ticket restore stays a Layer-1 (PITR) operation.
 */

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL_DIR = path.join(BACKEND_DIR, 'backups', 'local');
const SCHEDULE_INTERVAL_MS = 10 * 60 * 1000;
const EXPORT_ONLY_REASON = 'This module is export-only: TP-native ticket data is backed up for download/review, never restored in place (use platform PITR for that).';

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** JSON round-trip so Dates → ISO strings and BigInt → strings on both the
 *  export path and the compare path (snapshot rows arrive JSON-parsed). */
function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

function sameRow(a, b) {
  return JSON.stringify(canonicalize(normalizeValue(a))) === JSON.stringify(canonicalize(normalizeValue(b)));
}

/** Diff incoming (snapshot) rows against existing (target-workspace) rows by
 *  natural key. Entries: {key, row} for create/update, {key} for skip,
 *  {key, reason} for conflicts. */
function computeDiff(existingRows, incomingRows, keyOf) {
  // `remove` = existing rows absent from the snapshot — what REPLACE mode
  // would delete. Surfaced in dry-run so destructive restores are previewed.
  const result = { create: [], update: [], skip: [], conflicts: [], remove: [] };
  const existingByKey = new Map();
  for (const row of existingRows) existingByKey.set(keyOf(row), row);
  const seen = new Set();
  for (const raw of incomingRows || []) {
    const row = normalizeValue(raw);
    const key = keyOf(row);
    if (seen.has(key)) {
      result.conflicts.push({ key, reason: 'Duplicate natural key inside the snapshot' });
      continue;
    }
    seen.add(key);
    const existing = existingByKey.get(key);
    if (!existing) result.create.push({ key, row });
    else if (sameRow(existing, row)) result.skip.push({ key });
    else result.update.push({ key, row });
  }
  for (const key of existingByKey.keys()) {
    if (!seen.has(key)) result.remove.push({ key });
  }
  return result;
}

function isNil(value) {
  return value === null || value === undefined;
}

function normalizeDomains(list) {
  return [...new Set((list || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))].sort();
}

// ---------------------------------------------------------------------------
// Module factories
// ---------------------------------------------------------------------------

/**
 * Standard per-workspace config module: export/diff/apply matched by a natural
 * key, deep-equal compare on exported fields, merge = upsert-only,
 * replace = delete-absent-then-upsert. `toData(row)` may return null to flag
 * an unimportable row (counted as a conflict).
 */
function configModule({ delegate, where = {}, shape, keyOf, toData }) {
  const exportRows = async (workspaceId, db = prisma) => {
    const records = await db[delegate].findMany({
      where: { workspaceId, ...where },
      orderBy: { id: 'asc' },
    });
    return records.map((record) => normalizeValue(shape(record)));
  };

  return {
    tier: 'config',
    restorable: true,
    export: exportRows,

    diff: async (workspaceId, rows, db = prisma) => computeDiff(await exportRows(workspaceId, db), rows, keyOf),

    apply: async (workspaceId, rows, mode, db = prisma) => {
      const counts = { created: 0, updated: 0, skipped: 0, deleted: 0, conflicts: 0 };
      const records = await db[delegate].findMany({
        where: { workspaceId, ...where },
        orderBy: { id: 'asc' },
      });
      const byKey = new Map(records.map((record) => [keyOf(normalizeValue(shape(record))), record]));
      const incoming = (rows || []).map(normalizeValue);
      const incomingKeys = new Set(incoming.map(keyOf));

      if (mode === 'replace') {
        for (const [key, record] of byKey) {
          if (incomingKeys.has(key)) continue;
          try {
            await db[delegate].delete({ where: { id: record.id } });
            counts.deleted += 1;
            byKey.delete(key);
          } catch (err) {
            counts.conflicts += 1;
            logger.warn(`[backup] replace delete failed for ${delegate} "${key}": ${err.message}`);
          }
        }
      }

      for (const row of incoming) {
        const key = keyOf(row);
        const data = toData(row);
        if (data === null) {
          counts.conflicts += 1;
          continue;
        }
        const record = byKey.get(key);
        if (!record) {
          await db[delegate].create({ data: { workspaceId, ...data } });
          counts.created += 1;
        } else if (sameRow(normalizeValue(shape(record)), row)) {
          counts.skipped += 1;
        } else {
          await db[delegate].update({ where: { id: record.id }, data });
          counts.updated += 1;
        }
      }
      return counts;
    },
  };
}

/** Tier config_data module: export-only. diff reports not-restorable; apply refuses. */
function dataModule(exportRows) {
  return {
    tier: 'config_data',
    restorable: false,
    export: exportRows,
    diff: async () => ({ restorable: false, reason: EXPORT_ONLY_REASON, create: [], update: [], skip: [], conflicts: [] }),
    apply: async () => {
      throw new ValidationError(EXPORT_ONLY_REASON);
    },
  };
}

// ---------------------------------------------------------------------------
// Config modules
// ---------------------------------------------------------------------------

const shapeSlaPolicy = (record) => ({
  priority: record.priority,
  ticketTypeName: record.ticketType?.name ?? null,
  firstResponseMinutes: record.firstResponseMinutes ?? null,
  resolveMinutes: record.resolveMinutes ?? null,
  isActive: record.isActive !== false,
});
const slaPolicyKey = (row) => `p${row.priority}:${row.ticketTypeName ?? '*'}`;

/** SlaPolicy: natural key (priority, ticketTypeName); ticketTypeId is resolved
 *  by TicketTypeDefinition.name in the target workspace on import. */
const slaPoliciesModule = {
  tier: 'config',
  restorable: true,

  export: async (workspaceId, db = prisma) => {
    const records = await db.slaPolicy.findMany({
      where: { workspaceId },
      orderBy: { id: 'asc' },
      include: { ticketType: { select: { name: true } } },
    });
    return records.map((record) => normalizeValue(shapeSlaPolicy(record)));
  },

  diff: async (workspaceId, rows, db = prisma) => {
    const diff = computeDiff(await slaPoliciesModule.export(workspaceId, db), rows, slaPolicyKey);
    const types = await db.ticketTypeDefinition.findMany({ where: { workspaceId }, select: { name: true } });
    const typeNames = new Set(types.map((t) => t.name));
    for (const bucket of ['create', 'update']) {
      diff[bucket] = diff[bucket].filter((entry) => {
        const typeName = entry.row?.ticketTypeName;
        if (isNil(typeName) || typeNames.has(typeName)) return true;
        diff.conflicts.push({ key: entry.key, reason: `Ticket type "${typeName}" does not exist in the target workspace (restore ticketTypes first)` });
        return false;
      });
    }
    return diff;
  },

  apply: async (workspaceId, rows, mode, db = prisma) => {
    const counts = { created: 0, updated: 0, skipped: 0, deleted: 0, conflicts: 0 };
    const records = await db.slaPolicy.findMany({
      where: { workspaceId },
      orderBy: { id: 'asc' },
      include: { ticketType: { select: { name: true } } },
    });
    const types = await db.ticketTypeDefinition.findMany({ where: { workspaceId }, select: { id: true, name: true } });
    const typeIdByName = new Map(types.map((t) => [t.name, t.id]));
    const byKey = new Map(records.map((record) => [slaPolicyKey(shapeSlaPolicy(record)), record]));
    const incoming = (rows || []).map(normalizeValue);
    const incomingKeys = new Set(incoming.map(slaPolicyKey));

    if (mode === 'replace') {
      for (const [key, record] of byKey) {
        if (incomingKeys.has(key)) continue;
        try {
          await db.slaPolicy.delete({ where: { id: record.id } });
          counts.deleted += 1;
          byKey.delete(key);
        } catch (err) {
          counts.conflicts += 1;
          logger.warn(`[backup] replace delete failed for slaPolicy "${key}": ${err.message}`);
        }
      }
    }

    for (const row of incoming) {
      if (!isNil(row.ticketTypeName) && !typeIdByName.has(row.ticketTypeName)) {
        counts.conflicts += 1;
        continue;
      }
      const key = slaPolicyKey(row);
      const record = byKey.get(key);
      const data = {
        priority: Number(row.priority),
        ticketTypeId: !isNil(row.ticketTypeName) ? typeIdByName.get(row.ticketTypeName) : null,
        firstResponseMinutes: row.firstResponseMinutes ?? null,
        resolveMinutes: row.resolveMinutes ?? null,
        isActive: row.isActive !== false,
      };
      if (!record) {
        await db.slaPolicy.create({ data: { workspaceId, ...data } });
        counts.created += 1;
      } else if (sameRow(shapeSlaPolicy(record), row)) {
        counts.skipped += 1;
      } else {
        await db.slaPolicy.update({ where: { id: record.id }, data });
        counts.updated += 1;
      }
    }
    return counts;
  },
};

const shapeTaxonomy = (record) => ({
  name: record.name,
  parentName: record.parent?.name ?? null,
  description: record.description ?? null,
  isActive: record.isActive !== false,
  isSystemSuggested: record.isSystemSuggested === true,
  source: record.source ?? 'manual',
  sortOrder: record.sortOrder ?? 0,
});

/** CompetencyCategory tree exported flat as {name, parentName}. Name is unique
 *  per workspace, so `name` is the match key; parents apply before children. */
const taxonomyModule = {
  tier: 'config',
  restorable: true,

  export: async (workspaceId, db = prisma) => {
    const records = await db.competencyCategory.findMany({
      where: { workspaceId },
      orderBy: { id: 'asc' },
      include: { parent: { select: { name: true } } },
    });
    const shaped = records.map((record) => normalizeValue(shapeTaxonomy(record)));
    // Parents first so a restore can stream the array in order.
    return [...shaped.filter((row) => !row.parentName), ...shaped.filter((row) => row.parentName)];
  },

  diff: async (workspaceId, rows, db = prisma) => computeDiff(await taxonomyModule.export(workspaceId, db), rows, (row) => String(row.name)),

  apply: async (workspaceId, rows, mode, db = prisma) => {
    const counts = { created: 0, updated: 0, skipped: 0, deleted: 0, conflicts: 0 };
    const records = await db.competencyCategory.findMany({
      where: { workspaceId },
      orderBy: { id: 'asc' },
      include: { parent: { select: { name: true } } },
    });
    const byName = new Map(records.map((record) => [record.name, record]));
    const idByName = new Map(records.map((record) => [record.name, record.id]));
    const incoming = (rows || []).map(normalizeValue);
    const incomingNames = new Set(incoming.map((row) => String(row.name)));

    if (mode === 'replace') {
      // Children before parents so FK order holds; failures (e.g. categories
      // still referenced by competencies) downgrade to conflicts.
      const doomed = records
        .filter((record) => !incomingNames.has(record.name))
        .sort((a, b) => (b.parentId ? 1 : 0) - (a.parentId ? 1 : 0));
      for (const record of doomed) {
        try {
          await db.competencyCategory.delete({ where: { id: record.id } });
          counts.deleted += 1;
          byName.delete(record.name);
          idByName.delete(record.name);
        } catch (err) {
          counts.conflicts += 1;
          logger.warn(`[backup] replace delete failed for category "${record.name}": ${err.message}`);
        }
      }
    }

    const ordered = [...incoming.filter((row) => !row.parentName), ...incoming.filter((row) => row.parentName)];
    for (const row of ordered) {
      const parentId = row.parentName ? idByName.get(row.parentName) ?? null : null;
      if (row.parentName && parentId === null) {
        counts.conflicts += 1;
        continue;
      }
      const data = {
        name: row.name,
        parentId,
        description: row.description ?? null,
        isActive: row.isActive !== false,
        isSystemSuggested: row.isSystemSuggested === true,
        source: row.source ?? 'manual',
        sortOrder: row.sortOrder ?? 0,
      };
      const record = byName.get(row.name);
      if (!record) {
        const created = await db.competencyCategory.create({ data: { workspaceId, ...data } });
        idByName.set(row.name, created.id);
        counts.created += 1;
      } else if (sameRow(shapeTaxonomy(record), row)) {
        counts.skipped += 1;
      } else {
        await db.competencyCategory.update({ where: { id: record.id }, data });
        counts.updated += 1;
      }
    }
    return counts;
  },
};

/** Workspace.internalDomains as a single {domains: []} row; diff/apply compare
 *  as case-insensitive sets. Merge and replace behave identically (one row). */
const trustedDomainsModule = {
  tier: 'config',
  restorable: true,

  export: async (workspaceId, db = prisma) => {
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { internalDomains: true },
    });
    if (!workspace) return [];
    return [{ key: 'internalDomains', domains: normalizeDomains(workspace.internalDomains) }];
  },

  diff: async (workspaceId, rows, db = prisma) => {
    const result = { create: [], update: [], skip: [], conflicts: [] };
    const incoming = (rows || [])[0];
    if (!incoming) return result;
    const existing = await trustedDomainsModule.export(workspaceId, db);
    if (!existing.length) {
      result.conflicts.push({ key: 'internalDomains', reason: 'Target workspace not found' });
      return result;
    }
    const wanted = normalizeDomains(incoming.domains);
    if (wanted.join('\n') === existing[0].domains.join('\n')) {
      result.skip.push({ key: 'internalDomains' });
    } else {
      result.update.push({ key: 'internalDomains', row: { key: 'internalDomains', domains: wanted } });
    }
    return result;
  },

  apply: async (workspaceId, rows, _mode, db = prisma) => {
    const counts = { created: 0, updated: 0, skipped: 0, deleted: 0, conflicts: 0 };
    const incoming = (rows || [])[0];
    if (!incoming) return counts;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { internalDomains: true },
    });
    if (!workspace) {
      counts.conflicts += 1;
      return counts;
    }
    const wanted = normalizeDomains(incoming.domains);
    if (wanted.join('\n') === normalizeDomains(workspace.internalDomains).join('\n')) {
      counts.skipped += 1;
      return counts;
    }
    await db.workspace.update({ where: { id: workspaceId }, data: { internalDomains: wanted } });
    counts.updated += 1;
    return counts;
  },
};

/**
 * Module registry. Config modules restore by natural key; config_data modules
 * (TP-native ticket data) are export-only. No module exports secrets — every
 * exported field list below is explicit (no API keys/tokens/connection strings).
 */
export const MODULES = {
  noiseRules: configModule({
    delegate: 'noiseRule',
    shape: (r) => ({
      name: r.name,
      pattern: r.pattern,
      description: r.description ?? null,
      category: r.category,
      isEnabled: r.isEnabled !== false,
      dedupWindowDays: r.dedupWindowDays ?? null,
    }),
    keyOf: (row) => String(row.name),
    toData: (row) => ({
      name: row.name,
      pattern: row.pattern,
      description: row.description ?? null,
      category: row.category ?? 'General',
      isEnabled: row.isEnabled !== false,
      dedupWindowDays: row.dedupWindowDays ?? null,
    }),
  }),

  slaPolicies: slaPoliciesModule,

  macros: configModule({
    delegate: 'ticketMacro',
    shape: (r) => ({
      name: r.name,
      description: r.description ?? null,
      actions: r.actions ?? {},
      isActive: r.isActive !== false,
      sortOrder: r.sortOrder ?? 0,
    }),
    keyOf: (row) => String(row.name),
    toData: (row) => ({
      name: row.name,
      description: row.description ?? null,
      actions: row.actions ?? {},
      isActive: row.isActive !== false,
      sortOrder: row.sortOrder ?? 0,
    }),
  }),

  customFields: configModule({
    delegate: 'customFieldDefinition',
    shape: (r) => ({
      key: r.key,
      label: r.label,
      type: r.type ?? 'text',
      options: r.options ?? [],
      isActive: r.isActive !== false,
      sortOrder: r.sortOrder ?? 0,
    }),
    keyOf: (row) => String(row.key),
    toData: (row) => ({
      key: row.key,
      label: row.label,
      type: row.type ?? 'text',
      options: row.options ?? [],
      isActive: row.isActive !== false,
      sortOrder: row.sortOrder ?? 0,
    }),
  }),

  ticketTypes: configModule({
    delegate: 'ticketTypeDefinition',
    shape: (r) => ({
      name: r.name,
      description: r.description ?? null,
      aliases: r.aliases ?? [],
      fsTypeValue: r.fsTypeValue ?? null,
      fsChoiceId: r.fsChoiceId ?? null, // BigInt → string via normalizeValue
      fsDetectedAt: r.fsDetectedAt ?? null,
      aiAssignable: r.aiAssignable !== false,
      isDefault: r.isDefault === true,
      color: r.color ?? 'slate',
      abbreviation: r.abbreviation ?? null,
      sortOrder: r.sortOrder ?? 0,
      isActive: r.isActive !== false,
      source: r.source ?? 'fs_sync',
    }),
    keyOf: (row) => String(row.name),
    toData: (row) => ({
      name: row.name,
      description: row.description ?? null,
      aliases: row.aliases ?? [],
      fsTypeValue: row.fsTypeValue ?? null,
      fsChoiceId: !isNil(row.fsChoiceId) ? BigInt(row.fsChoiceId) : null,
      fsDetectedAt: row.fsDetectedAt ? new Date(row.fsDetectedAt) : null,
      aiAssignable: row.aiAssignable !== false,
      isDefault: row.isDefault === true,
      color: row.color ?? 'slate',
      abbreviation: row.abbreviation ?? null,
      sortOrder: row.sortOrder ?? 0,
      isActive: row.isActive !== false,
      source: row.source ?? 'fs_sync',
    }),
  }),

  taxonomy: taxonomyModule,

  businessHours: configModule({
    delegate: 'businessHour',
    shape: (r) => ({
      dayOfWeek: r.dayOfWeek,
      startTime: r.startTime,
      endTime: r.endTime,
      isEnabled: r.isEnabled !== false,
      timezone: r.timezone ?? 'America/Los_Angeles',
    }),
    keyOf: (row) => `day-${row.dayOfWeek}`,
    toData: (row) => ({
      dayOfWeek: Number(row.dayOfWeek),
      startTime: row.startTime,
      endTime: row.endTime,
      isEnabled: row.isEnabled !== false,
      timezone: row.timezone ?? 'America/Los_Angeles',
    }),
  }),

  trustedDomains: trustedDomainsModule,

  // NotificationWorkflow definitions are stored whole as JSON columns
  // (draft/published definition graphs), so a faithful export is one row per
  // workflow. Match key is the workflow `key` (unique per workspace — the
  // name-derived identifier notificationWorkflowRepository generates); the
  // human name travels alongside. Archived workflows are excluded. Version
  // history / runs are deliberately not exported (operational history).
  workflows: configModule({
    delegate: 'notificationWorkflow',
    where: { archivedAt: null },
    shape: (r) => ({
      key: r.key,
      name: r.name,
      description: r.description ?? null,
      triggerType: r.triggerType,
      routingMode: r.routingMode ?? 'exclusive',
      routingPriority: r.routingPriority ?? 100,
      routingRule: r.routingRule ?? null,
      isDefaultVariant: r.isDefaultVariant === true,
      isEnabled: r.isEnabled === true,
      mockModeEnabled: r.mockModeEnabled === true,
      draftDefinition: r.draftDefinition ?? null,
      publishedDefinition: r.publishedDefinition ?? null,
      publishedVersion: r.publishedVersion ?? 0,
    }),
    keyOf: (row) => String(row.key),
    toData: (row) => {
      // A workflow row without a definition graph cannot execute — refuse it.
      if (!row.key || !row.triggerType || typeof row.draftDefinition !== 'object' || row.draftDefinition === null) {
        return null;
      }
      return {
        key: row.key,
        name: row.name || row.key,
        description: row.description ?? null,
        triggerType: row.triggerType,
        routingMode: row.routingMode ?? 'exclusive',
        routingPriority: row.routingPriority ?? 100,
        isDefaultVariant: row.isDefaultVariant === true,
        isEnabled: row.isEnabled === true,
        mockModeEnabled: row.mockModeEnabled === true,
        draftDefinition: row.draftDefinition,
        publishedVersion: row.publishedVersion ?? 0,
        // Nullable Json columns reject a literal null in Prisma writes — only
        // include them when there is a value to write.
        ...(!isNil(row.routingRule) ? { routingRule: row.routingRule } : {}),
        ...(!isNil(row.publishedDefinition) ? { publishedDefinition: row.publishedDefinition } : {}),
      };
    },
  }),

  // ---- Tier 'config_data': TP-native ticket data (EXPORT-ONLY) -------------

  nativeTickets: dataModule(async (workspaceId, db = prisma) => {
    const tickets = await db.ticket.findMany({
      where: { workspaceId, origin: 'ticketpulse' },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        nativeNumber: true,
        subject: true,
        description: true,
        descriptionText: true,
        status: true,
        priority: true,
        impact: true,
        urgency: true,
        ticketType: true,
        category: true,
        subCategory: true,
        source: true,
        toEmails: true,
        ccEmails: true,
        customFields: true,
        createdAt: true,
        assignedAt: true,
        resolvedAt: true,
        closedAt: true,
        dueBy: true,
        frDueBy: true,
        assignedTech: { select: { name: true } },
        requester: { select: { name: true, email: true } },
      },
    });
    return tickets.map((t) => normalizeValue({
      ticketId: t.id,
      nativeNumber: t.nativeNumber,
      subject: t.subject,
      description: t.description,
      descriptionText: t.descriptionText,
      status: t.status,
      priority: t.priority,
      impact: t.impact,
      urgency: t.urgency,
      ticketType: t.ticketType,
      category: t.category,
      subCategory: t.subCategory,
      source: t.source,
      toEmails: t.toEmails,
      ccEmails: t.ccEmails,
      customFields: t.customFields,
      createdAt: t.createdAt,
      assignedAt: t.assignedAt,
      resolvedAt: t.resolvedAt,
      closedAt: t.closedAt,
      dueBy: t.dueBy,
      frDueBy: t.frDueBy,
      assignedTechName: t.assignedTech?.name ?? null,
      requesterName: t.requester?.name ?? null,
      requesterEmail: t.requester?.email ?? null,
    }));
  }),

  nativeThreads: dataModule(async (workspaceId, db = prisma) => {
    const tickets = await db.ticket.findMany({
      where: { workspaceId, origin: 'ticketpulse' },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);
    if (!ids.length) return [];
    const entries = await db.ticketThreadEntry.findMany({
      where: { ticketId: { in: ids } },
      orderBy: { id: 'asc' },
      select: {
        ticketId: true,
        source: true,
        eventType: true,
        actorName: true,
        actorEmail: true,
        authorType: true,
        incoming: true,
        isPrivate: true,
        visibility: true,
        title: true,
        content: true,
        bodyHtml: true,
        bodyText: true,
        occurredAt: true,
      },
    });
    return entries.map((entry) => normalizeValue(entry));
  }),

  ticketTags: dataModule(async (workspaceId, db = prisma) => {
    const tags = await db.ticketTag.findMany({
      where: { workspaceId },
      orderBy: { id: 'asc' },
      select: { name: true, color: true, isActive: true },
    });
    return tags.map((tag) => normalizeValue(tag));
  }),

  ticketTagLinks: dataModule(async (workspaceId, db = prisma) => {
    const links = await db.ticketTagLink.findMany({
      where: { tag: { workspaceId } },
      orderBy: { id: 'asc' },
      select: { ticketId: true, tag: { select: { name: true } } },
    });
    return links.map((link) => ({ ticketId: link.ticketId, tagName: link.tag?.name ?? null }));
  }),

  ticketLinks: dataModule(async (workspaceId, db = prisma) => {
    const links = await db.ticketLink.findMany({
      where: { workspaceId },
      orderBy: { id: 'asc' },
      select: { ticketId: true, relatedTicketId: true, kind: true },
    });
    return links.map((link) => normalizeValue(link));
  }),
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class BackupService {
  constructor() {
    this._containerPromise = null;
    this._timer = null;
  }

  isConfigured() {
    return Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING);
  }

  /** Dev/prod isolation mirrors attachmentService: same account, separate
   *  private containers, env override. */
  containerName() {
    return process.env.BACKUP_CONTAINER
      || (process.env.NODE_ENV === 'production' ? 'backups-prod' : 'backups-dev');
  }

  async _container() {
    if (!this._containerPromise) {
      if (!this.isConfigured()) {
        throw new ValidationError('Backup storage is not configured (AZURE_STORAGE_CONNECTION_STRING)');
      }
      const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
      const client = service.getContainerClient(this.containerName());
      this._containerPromise = client.createIfNotExists().then(() => client).catch((err) => {
        this._containerPromise = null;
        throw err;
      });
    }
    return this._containerPromise;
  }

  _scopeSegment(row) {
    return row.scope === 'workspace' ? `ws-${row.workspaceId}` : 'site';
  }

  async _storeBundle(row, buffer) {
    const dateStr = (row.createdAt instanceof Date ? row.createdAt : new Date()).toISOString().slice(0, 10);
    const segment = this._scopeSegment(row);
    if (this.isConfigured()) {
      const blobName = `snap/${segment}/${dateStr}-${row.id}.json.gz`;
      const container = await this._container();
      await container.getBlockBlobClient(blobName).uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: 'application/gzip' },
      });
      return blobName;
    }
    const fileName = `${segment}-${dateStr}-${row.id}.json.gz`;
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_DIR, fileName), buffer);
    return `local:${fileName}`;
  }

  async _loadBundleBuffer(blobName) {
    if (blobName.startsWith('local:')) {
      const fileName = path.basename(blobName.slice('local:'.length));
      return fs.readFileSync(path.join(LOCAL_DIR, fileName));
    }
    const container = await this._container();
    return container.getBlockBlobClient(blobName).downloadToBuffer();
  }

  async _deleteBundle(blobName) {
    if (!blobName) return;
    try {
      if (blobName.startsWith('local:')) {
        const fileName = path.basename(blobName.slice('local:'.length));
        fs.unlinkSync(path.join(LOCAL_DIR, fileName));
      } else {
        const container = await this._container();
        await container.getBlockBlobClient(blobName).deleteIfExists();
      }
    } catch (err) {
      logger.warn(`[backup] bundle delete failed for ${blobName}: ${err.message}`);
    }
  }

  // ---- Snapshots ---------------------------------------------------------

  /**
   * Create a snapshot. scope 'workspace' exports one workspace's modules under
   * plain keys; scope 'site' exports every active workspace under
   * `ws<id>:<module>` keys. Errors mark the row failed (returned, not thrown).
   */
  async createSnapshot({ scope = 'workspace', workspaceId = null, tier = 'config', trigger = 'manual', actorEmail = null } = {}) {
    if (!['site', 'workspace'].includes(scope)) throw new ValidationError(`Invalid snapshot scope "${scope}"`);
    if (!['config', 'config_data'].includes(tier)) throw new ValidationError(`Invalid snapshot tier "${tier}"`);
    if (scope === 'workspace' && !workspaceId) throw new ValidationError('workspaceId is required for workspace-scope snapshots');

    const row = await prisma.backupSnapshot.create({
      data: {
        scope,
        workspaceId: scope === 'workspace' ? Number(workspaceId) : null,
        tier,
        trigger,
        status: 'running',
        createdByEmail: actorEmail,
      },
    });

    try {
      let targets;
      if (scope === 'site') {
        targets = await prisma.workspace.findMany({
          where: { isActive: true },
          orderBy: { id: 'asc' },
          select: { id: true, name: true },
        });
      } else {
        const workspace = await prisma.workspace.findUnique({
          where: { id: Number(workspaceId) },
          select: { id: true, name: true },
        });
        if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} not found`);
        targets = [workspace];
      }

      const modules = {};
      const counts = {};
      const moduleMeta = [];
      for (const workspace of targets) {
        for (const [name, mod] of Object.entries(MODULES)) {
          if (mod.tier === 'config_data' && tier !== 'config_data') continue;
          const rows = await mod.export(workspace.id);
          const key = scope === 'site' ? `ws${workspace.id}:${name}` : name;
          modules[key] = rows;
          counts[key] = rows.length;
          moduleMeta.push({ key, count: rows.length, restorable: mod.restorable !== false });
        }
      }

      const manifest = {
        formatVersion: 1,
        appVersion: pkg.version,
        scope,
        tier,
        workspaceId: scope === 'workspace' ? targets[0].id : null,
        workspaceName: scope === 'workspace' ? targets[0].name : null,
        workspaces: targets.map((w) => ({ id: w.id, name: w.name })),
        createdAt: row.createdAt.toISOString(),
        counts,
        modules: moduleMeta,
      };

      const buffer = zlib.gzipSync(Buffer.from(JSON.stringify({ manifest, modules }, jsonReplacer), 'utf8'));
      const blobName = await this._storeBundle(row, buffer);
      const updated = await prisma.backupSnapshot.update({
        where: { id: row.id },
        data: {
          status: 'completed',
          blobName,
          sizeBytes: buffer.length,
          manifest,
          completedAt: new Date(),
        },
      });
      logger.info(`[backup] snapshot ${row.id} completed (${scope}/${tier}, ${buffer.length} bytes → ${blobName}) by ${actorEmail || trigger}`);
      return updated;
    } catch (err) {
      logger.error(`[backup] snapshot ${row.id} failed: ${err.message}`);
      return prisma.backupSnapshot.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          error: String(err.message || err).slice(0, 4000),
          completedAt: new Date(),
        },
      });
    }
  }

  /** Workspace admins see their workspace's snapshots; site snapshots are global-admin only. */
  async listSnapshots({ workspaceId, isGlobalAdmin = false } = {}) {
    const where = isGlobalAdmin ? {} : { scope: 'workspace', workspaceId: Number(workspaceId) };
    return prisma.backupSnapshot.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async getSnapshot(id) {
    const row = await prisma.backupSnapshot.findUnique({ where: { id: Number(id) } });
    if (!row) throw new NotFoundError(`Snapshot ${id} not found`);
    return row;
  }

  /** Download + gunzip + parse the bundle ({manifest, modules}). */
  async getSnapshotBundle(id) {
    const snapshot = await this.getSnapshot(id);
    if (snapshot.status !== 'completed' || !snapshot.blobName) {
      throw new ValidationError(`Snapshot ${id} is not completed (status: ${snapshot.status})`);
    }
    const buffer = await this._loadBundleBuffer(snapshot.blobName);
    const bundle = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
    return { snapshot, ...bundle };
  }

  /** Raw .json.gz stream for the download endpoint. */
  async downloadStream(id) {
    const snapshot = await this.getSnapshot(id);
    if (snapshot.status !== 'completed' || !snapshot.blobName) {
      throw new ValidationError(`Snapshot ${id} is not completed (status: ${snapshot.status})`);
    }
    const fileName = `ticket-pulse-backup-${snapshot.id}-${this._scopeSegment(snapshot)}-${snapshot.tier}.json.gz`;
    if (snapshot.blobName.startsWith('local:')) {
      const localName = path.basename(snapshot.blobName.slice('local:'.length));
      return { snapshot, fileName, stream: fs.createReadStream(path.join(LOCAL_DIR, localName)) };
    }
    const container = await this._container();
    const response = await container.getBlockBlobClient(snapshot.blobName).download();
    return { snapshot, fileName, stream: response.readableStreamBody };
  }

  async deleteSnapshot(id) {
    const snapshot = await this.getSnapshot(id);
    await this._deleteBundle(snapshot.blobName);
    await prisma.backupSnapshot.delete({ where: { id: snapshot.id } });
    return { deleted: true };
  }

  // ---- Restore -----------------------------------------------------------

  _resolveModuleRows(bundle, moduleName, sourceWorkspaceId) {
    const scope = bundle.manifest?.scope || bundle.snapshot?.scope;
    if (scope === 'site') {
      if (!sourceWorkspaceId) {
        throw new ValidationError('sourceWorkspaceId is required when restoring from a site-scope snapshot');
      }
      return bundle.modules?.[`ws${Number(sourceWorkspaceId)}:${moduleName}`];
    }
    return bundle.modules?.[moduleName];
  }

  _selectModules(bundle, modules, sourceWorkspaceId) {
    if (Array.isArray(modules) && modules.length) {
      for (const name of modules) {
        if (!MODULES[name]) throw new ValidationError(`Unknown backup module "${name}"`);
      }
      return modules;
    }
    // Default: every restorable config module the bundle actually carries.
    return Object.keys(MODULES).filter((name) => MODULES[name].restorable !== false
      && this._resolveModuleRows(bundle, name, sourceWorkspaceId) !== undefined);
  }

  /**
   * Read-only restore preview: per-module create/update/skip/conflict counts
   * plus item-level {key, action} detail. Cross-workspace targets are allowed.
   */
  async dryRunRestore(id, { targetWorkspaceId, modules, sourceWorkspaceId, mode = 'merge' } = {}) {
    if (!targetWorkspaceId) throw new ValidationError('targetWorkspaceId is required');
    const bundle = await this.getSnapshotBundle(id);
    const selected = this._selectModules(bundle, modules, sourceWorkspaceId);
    const results = [];
    for (const name of selected) {
      const mod = MODULES[name];
      const rows = this._resolveModuleRows(bundle, name, sourceWorkspaceId);
      if (rows === undefined) {
        results.push({ module: name, restorable: false, reason: 'Module not present in this snapshot' });
        continue;
      }
      if (mod.restorable === false) {
        results.push({ module: name, restorable: false, reason: EXPORT_ONLY_REASON, rowCount: rows.length });
        continue;
      }
      const diff = await mod.diff(Number(targetWorkspaceId), rows);
      // Replace mode previews deletions; merge never deletes so they're hidden.
      const removals = mode === 'replace' ? (diff.remove || []) : [];
      results.push({
        module: name,
        restorable: true,
        counts: {
          create: diff.create.length,
          update: diff.update.length,
          skip: diff.skip.length,
          conflicts: diff.conflicts.length,
          delete: removals.length,
        },
        items: [
          ...diff.create.map((entry) => ({ key: entry.key, action: 'create' })),
          ...diff.update.map((entry) => ({ key: entry.key, action: 'update' })),
          ...removals.map((entry) => ({ key: entry.key, action: 'delete' })),
          ...diff.skip.map((entry) => ({ key: entry.key, action: 'skip' })),
          ...diff.conflicts.map((entry) => ({ key: entry.key, action: 'conflict', reason: entry.reason })),
        ],
      });
    }
    return {
      snapshotId: Number(id),
      targetWorkspaceId: Number(targetWorkspaceId),
      sourceWorkspaceId: sourceWorkspaceId ? Number(sourceWorkspaceId) : null,
      mode: 'dry-run',
      modules: results,
    };
  }

  /**
   * Apply a restore. mode 'merge' = upsert only (never deletes); 'replace' =
   * delete rows absent from the snapshot, then upsert. One transaction per
   * module so a failing module rolls back alone. Cross-workspace restore
   * (targetWorkspaceId ≠ manifest workspace) is allowed by design.
   */
  async applyRestore(id, { targetWorkspaceId, modules, mode = 'merge', sourceWorkspaceId, actorEmail = null } = {}) {
    if (!targetWorkspaceId) throw new ValidationError('targetWorkspaceId is required');
    if (!['merge', 'replace'].includes(mode)) throw new ValidationError(`Invalid restore mode "${mode}"`);
    const bundle = await this.getSnapshotBundle(id);
    const selected = this._selectModules(bundle, modules, sourceWorkspaceId);

    for (const name of selected) {
      if (MODULES[name].restorable === false) {
        throw new ValidationError(`Module "${name}" is export-only and cannot be restored`);
      }
      if (this._resolveModuleRows(bundle, name, sourceWorkspaceId) === undefined) {
        throw new ValidationError(`Module "${name}" is not present in snapshot ${id}`);
      }
    }
    const target = await prisma.workspace.findUnique({
      where: { id: Number(targetWorkspaceId) },
      select: { id: true, name: true },
    });
    if (!target) throw new NotFoundError(`Target workspace ${targetWorkspaceId} not found`);

    const results = {};
    for (const name of selected) {
      const rows = this._resolveModuleRows(bundle, name, sourceWorkspaceId);
      results[name] = await prisma.$transaction((tx) => MODULES[name].apply(target.id, rows, mode, tx));
    }

    const summary = Object.entries(results)
      .map(([name, c]) => `${name}: +${c.created} ~${c.updated} =${c.skipped} -${c.deleted} !${c.conflicts}`)
      .join('; ');
    logger.info(`[backup] restore applied: snapshot=${id} target=ws${target.id} (${target.name}) mode=${mode} by=${actorEmail || 'system'} — ${summary}`);
    return {
      snapshotId: Number(id),
      targetWorkspaceId: target.id,
      mode,
      modules: results,
    };
  }

  // ---- Schedules ---------------------------------------------------------

  async listSchedules({ workspaceId, isGlobalAdmin = false } = {}) {
    const where = isGlobalAdmin ? {} : { scope: 'workspace', workspaceId: Number(workspaceId) };
    return prisma.backupSchedule.findMany({ where, orderBy: { id: 'asc' } });
  }

  async getSchedule(id) {
    const row = await prisma.backupSchedule.findUnique({ where: { id: Number(id) } });
    if (!row) throw new NotFoundError(`Backup schedule ${id} not found`);
    return row;
  }

  _validateScheduleData(data, { partial = false } = {}) {
    const out = {};
    if (!partial || data.scope !== undefined) {
      if (!['site', 'workspace'].includes(data.scope)) throw new ValidationError('scope must be "site" or "workspace"');
      out.scope = data.scope;
    }
    if (!partial || data.tier !== undefined) {
      const tier = data.tier ?? 'config';
      if (!['config', 'config_data'].includes(tier)) throw new ValidationError('tier must be "config" or "config_data"');
      out.tier = tier;
    }
    if (!partial || data.frequency !== undefined) {
      const frequency = data.frequency ?? 'daily';
      if (!['daily', 'weekly'].includes(frequency)) throw new ValidationError('frequency must be "daily" or "weekly"');
      out.frequency = frequency;
    }
    if (!partial || data.hourUtc !== undefined) {
      const hourUtc = Number(data.hourUtc ?? 9);
      if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) throw new ValidationError('hourUtc must be 0-23');
      out.hourUtc = hourUtc;
    }
    if (data.weekday !== undefined) {
      if (data.weekday === null) {
        out.weekday = null;
      } else {
        const weekday = Number(data.weekday);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new ValidationError('weekday must be 0-6 (Sunday=0)');
        out.weekday = weekday;
      }
    }
    if (!partial || data.retentionCount !== undefined) {
      const retentionCount = Number(data.retentionCount ?? 14);
      if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
        throw new ValidationError('retentionCount must be between 1 and 365');
      }
      out.retentionCount = retentionCount;
    }
    if (data.enabled !== undefined) out.enabled = Boolean(data.enabled);
    return out;
  }

  async createSchedule(data) {
    const validated = this._validateScheduleData(data);
    if (validated.scope === 'workspace' && !data.workspaceId) {
      throw new ValidationError('workspaceId is required for workspace-scope schedules');
    }
    return prisma.backupSchedule.create({
      data: {
        ...validated,
        workspaceId: validated.scope === 'workspace' ? Number(data.workspaceId) : null,
        enabled: data.enabled !== false,
      },
    });
  }

  async updateSchedule(id, patch) {
    const schedule = await this.getSchedule(id);
    const validated = this._validateScheduleData(patch, { partial: true });
    if (validated.scope === 'workspace' && !(patch.workspaceId || schedule.workspaceId)) {
      throw new ValidationError('workspaceId is required for workspace-scope schedules');
    }
    if (patch.workspaceId !== undefined) {
      validated.workspaceId = patch.workspaceId === null ? null : Number(patch.workspaceId);
    }
    if (validated.scope === 'site') validated.workspaceId = null;
    return prisma.backupSchedule.update({ where: { id: schedule.id }, data: validated });
  }

  async deleteSchedule(id) {
    const schedule = await this.getSchedule(id);
    await prisma.backupSchedule.delete({ where: { id: schedule.id } });
    return { deleted: true };
  }

  _sameUtcDay(a, b) {
    return a && b
      && a.getUTCFullYear() === b.getUTCFullYear()
      && a.getUTCMonth() === b.getUTCMonth()
      && a.getUTCDate() === b.getUTCDate();
  }

  _isDue(schedule, now) {
    if (now.getUTCHours() < schedule.hourUtc) return false;
    const lastRunAt = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
    if (lastRunAt && this._sameUtcDay(lastRunAt, now)) return false;
    if (schedule.frequency === 'weekly' && now.getUTCDay() !== (schedule.weekday ?? 0)) return false;
    return true;
  }

  /** Run every enabled schedule that is due, then sweep retention for it. */
  async runSchedules(now = new Date()) {
    const schedules = await prisma.backupSchedule.findMany({ where: { enabled: true } });
    let ran = 0;
    for (const schedule of schedules) {
      if (!this._isDue(schedule, now)) continue;
      // Stamp lastRunAt first so a slow/failed snapshot can't double-fire today.
      await prisma.backupSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: now } });
      try {
        await this.createSnapshot({
          scope: schedule.scope,
          workspaceId: schedule.workspaceId,
          tier: schedule.tier,
          trigger: 'scheduled',
        });
        await this._sweepRetention(schedule);
        ran += 1;
      } catch (err) {
        logger.warn(`[backup] scheduled snapshot failed for schedule ${schedule.id}: ${err.message}`);
      }
    }
    return { ran };
  }

  /** Keep the newest retentionCount completed scheduled snapshots per
   *  (scope, workspaceId, tier); delete the rest (blob + row). */
  async _sweepRetention(schedule) {
    const keep = Math.max(1, schedule.retentionCount || 14);
    const rows = await prisma.backupSnapshot.findMany({
      where: {
        scope: schedule.scope,
        workspaceId: schedule.workspaceId ?? null,
        tier: schedule.tier,
        trigger: 'scheduled',
        status: 'completed',
      },
      orderBy: { createdAt: 'desc' },
    });
    for (const stale of rows.slice(keep)) {
      try {
        await this.deleteSnapshot(stale.id);
        logger.info(`[backup] retention sweep deleted snapshot ${stale.id}`);
      } catch (err) {
        logger.warn(`[backup] retention sweep failed for snapshot ${stale.id}: ${err.message}`);
      }
    }
  }

  start() {
    if (this._timer) return;
    if (process.env.BACKUP_SCHEDULES_ENABLED === 'false') return;
    this._timer = setInterval(() => {
      this.runSchedules().catch((err) => logger.warn(`[backup] schedule sweep failed (non-fatal): ${err.message}`));
    }, SCHEDULE_INTERVAL_MS);
    this._timer.unref?.();
    logger.info(`[backup] schedule worker started (every ${Math.round(SCHEDULE_INTERVAL_MS / 1000)}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

export default new BackupService();
