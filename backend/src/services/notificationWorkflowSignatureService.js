import sanitizeHtml from 'sanitize-html';
import prisma from './prisma.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const MAX_SIGNATURE_HTML_BYTES = 512 * 1024;
const MAX_BLOCK_NAME_LENGTH = 160;
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
const EMAIL_BLOCK_TYPE_RANK = { header: 0, footer: 1 };

export const EMAIL_BLOCK_TYPES = Object.freeze({
  HEADER: 'header',
  FOOTER: 'footer',
});

export const EMAIL_BLOCK_LABELS = Object.freeze({
  [EMAIL_BLOCK_TYPES.HEADER]: 'Header',
  [EMAIL_BLOCK_TYPES.FOOTER]: 'Footer / sign-off',
});

const DEFAULT_BLOCK_NAMES = Object.freeze({
  [EMAIL_BLOCK_TYPES.HEADER]: 'Default header',
  [EMAIL_BLOCK_TYPES.FOOTER]: 'Default footer',
});

const EMAIL_BLOCK_TYPE_VALUES = new Set(Object.values(EMAIL_BLOCK_TYPES));

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

export function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function removeInvalidDataImageSources(html) {
  return String(html || '').replace(/(<img\b[^>]*\bsrc=["'])(data:[^"']+)(["'][^>]*>)/gi, (match, prefix, src, suffix) => {
    if (DATA_IMAGE_PATTERN.test(src) && byteLength(src) <= MAX_SIGNATURE_HTML_BYTES) {
      return `${prefix}${src}${suffix}`;
    }
    return match.replace(/\s+src=["'][^"']+["']/i, '');
  });
}

/**
 * Shared email-HTML sanitizer config (QA 08-06 #3). This is the permissive
 * allowlist the signature editor always used; the engine's body sanitizer
 * (sanitizeEmailHtml) now reuses it so template styling — h2 colors, divs,
 * table layouts, class/align attributes — survives rendering instead of the
 * two configs silently diverging.
 */
export const EMAIL_SANITIZE_OPTIONS = Object.freeze({
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'div',
    'span',
    'img',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'td',
    'th',
    'h1',
    'h2',
    'h3',
  ],
  allowedAttributes: {
    '*': ['style', 'class', 'align'],
    a: ['href', 'name', 'target', 'rel', 'style', 'class'],
    img: ['src', 'alt', 'width', 'height', 'style', 'class'],
    table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'style', 'class'],
    td: ['width', 'height', 'colspan', 'rowspan', 'style', 'class', 'align', 'valign'],
    th: ['width', 'height', 'colspan', 'rowspan', 'style', 'class', 'align', 'valign'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
  },
  allowProtocolRelative: false,
});

export function sanitizeSignatureHtml(html) {
  const raw = String(html || '').trim();
  if (!raw) return '';
  if (byteLength(raw) > MAX_SIGNATURE_HTML_BYTES) {
    throw new Error(`Signature HTML exceeds the ${Math.round(MAX_SIGNATURE_HTML_BYTES / 1024)} KB limit`);
  }

  const sanitized = sanitizeHtml(raw, EMAIL_SANITIZE_OPTIONS);
  const cleaned = removeInvalidDataImageSources(sanitized);
  if (byteLength(cleaned) > MAX_SIGNATURE_HTML_BYTES) {
    throw new Error(`Signature HTML exceeds the ${Math.round(MAX_SIGNATURE_HTML_BYTES / 1024)} KB limit after sanitization`);
  }
  return cleaned;
}

function actorEmail(actor = null) {
  return String(actor?.email || actor || '').trim() || null;
}

function blockClient(client = prisma) {
  return client?.notificationEmailBlock || null;
}

function legacySignatureClient(client = prisma) {
  return client?.notificationEmailSignature || null;
}

async function runTransaction(callback) {
  if (typeof prisma.$transaction === 'function') {
    return prisma.$transaction(callback);
  }
  return callback(prisma);
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizePositiveId(value, label = 'id') {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const id = Number.parseInt(value, 10);
  if (!Number.isFinite(id) || id <= 0) throw new ValidationError(`Invalid ${label}`);
  return id;
}

function coerceOptionalSelectionId(value, type) {
  try {
    return { id: normalizePositiveId(value, `${type} block id`), warning: null };
  } catch {
    return {
      id: null,
      warning: `Selected ${EMAIL_BLOCK_LABELS[type].toLowerCase()} block id is invalid; workspace default was used if available.`,
    };
  }
}

export function normalizeEmailBlockType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  if (!EMAIL_BLOCK_TYPE_VALUES.has(normalized)) {
    throw new ValidationError('Email block type must be header or footer');
  }
  return normalized;
}

function normalizeBlockName(value, type) {
  const fallback = DEFAULT_BLOCK_NAMES[type] || 'Email block';
  const name = String(value || fallback).trim().replace(/\s+/g, ' ');
  if (!name) throw new ValidationError('Email block name is required');
  if (name.length > MAX_BLOCK_NAME_LENGTH) {
    throw new ValidationError(`Email block name must be ${MAX_BLOCK_NAME_LENGTH} characters or fewer`);
  }
  return name;
}

function normalizeBlockText(value, html, fallback = '') {
  if (value !== undefined) return String(value || '').trim();
  if (html) return stripHtml(html);
  return String(fallback || '').trim();
}

function normalizeBlockPayload(input = {}, existing = null) {
  const type = input.type !== undefined
    ? normalizeEmailBlockType(input.type)
    : normalizeEmailBlockType(existing?.type || EMAIL_BLOCK_TYPES.FOOTER);
  const html = input.html !== undefined
    ? sanitizeSignatureHtml(input.html || '')
    : String(existing?.html || '');
  const text = normalizeBlockText(input.text, html, existing?.text || '');
  return {
    type,
    name: normalizeBlockName(input.name !== undefined ? input.name : existing?.name, type),
    enabled: normalizeBoolean(input.enabled, existing?.enabled !== false),
    isDefault: normalizeBoolean(input.isDefault, existing?.isDefault === true),
    html,
    text,
  };
}

function blockHasContent(block = null) {
  if (!block) return false;
  return Boolean(String(block.html || block.text || stripHtml(block.html)).trim());
}

export function serializeEmailBlock(block = null) {
  if (!block) return null;
  return {
    id: block.id,
    workspaceId: block.workspaceId,
    type: block.type,
    name: block.name || DEFAULT_BLOCK_NAMES[block.type] || 'Email block',
    enabled: block.enabled === true,
    isDefault: block.isDefault === true,
    html: block.html || '',
    text: block.text || '',
    updatedBy: block.updatedBy || null,
    createdAt: block.createdAt || null,
    updatedAt: block.updatedAt || null,
    maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
  };
}

function sortEmailBlocks(items = []) {
  return [...items].sort((a, b) => {
    const rankDiff = (EMAIL_BLOCK_TYPE_RANK[a.type] ?? 99) - (EMAIL_BLOCK_TYPE_RANK[b.type] ?? 99);
    if (rankDiff !== 0) return rankDiff;
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || '')) || a.id - b.id;
  });
}

function groupEmailBlocks(items = []) {
  const sorted = sortEmailBlocks(items);
  return {
    items: sorted,
    headers: sorted.filter((block) => block.type === EMAIL_BLOCK_TYPES.HEADER),
    footers: sorted.filter((block) => block.type === EMAIL_BLOCK_TYPES.FOOTER),
    maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
  };
}

async function findWorkspaceEmailBlock(workspaceId, id, type = null, client = prisma) {
  const emailBlockClient = blockClient(client);
  if (!emailBlockClient?.findFirst) throw new NotFoundError('Email branding blocks are not available');
  return emailBlockClient.findFirst({
    where: {
      id,
      workspaceId,
      ...(type ? { type } : {}),
    },
  });
}

async function findDefaultEmailBlock(workspaceId, type, client = prisma) {
  const emailBlockClient = blockClient(client);
  if (!emailBlockClient?.findFirst) return null;
  return emailBlockClient.findFirst({
    where: {
      workspaceId,
      type,
      isDefault: true,
    },
    orderBy: [
      { enabled: 'desc' },
      { updatedAt: 'desc' },
      { id: 'asc' },
    ],
  });
}

async function findLegacySignature(workspaceId, client = prisma) {
  const signatureClient = legacySignatureClient(client);
  if (!signatureClient?.findUnique) return null;
  return signatureClient.findUnique({ where: { workspaceId } });
}

function signatureResponseFromBlock(block = null) {
  if (!block) {
    return {
      enabled: false,
      html: '',
      text: '',
      updatedAt: null,
      updatedBy: null,
      maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
      blockId: null,
      blockName: null,
    };
  }
  return {
    enabled: block.enabled === true,
    html: block.html || '',
    text: block.text || '',
    updatedAt: block.updatedAt || null,
    updatedBy: block.updatedBy || null,
    maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
    blockId: block.id || null,
    blockName: block.name || DEFAULT_BLOCK_NAMES[EMAIL_BLOCK_TYPES.FOOTER],
  };
}

function signatureResponseFromLegacy(signature = null) {
  if (!signature) return signatureResponseFromBlock(null);
  return {
    enabled: signature.enabled === true,
    html: signature.html || '',
    text: signature.text || '',
    updatedAt: signature.updatedAt || null,
    updatedBy: signature.updatedBy || null,
    maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
    blockId: null,
    blockName: 'Legacy workspace signature',
  };
}

export async function getWorkspaceSignature(workspaceId) {
  const footer = await findDefaultEmailBlock(workspaceId, EMAIL_BLOCK_TYPES.FOOTER);
  if (footer) return signatureResponseFromBlock(footer);
  return signatureResponseFromLegacy(await findLegacySignature(workspaceId));
}

export async function upsertWorkspaceSignature(workspaceId, input = {}, actor = null) {
  const html = sanitizeSignatureHtml(input.html || '');
  const text = String(input.text || stripHtml(html)).trim();
  const enabled = input.enabled !== false && Boolean(html || text);
  const updatedBy = actorEmail(actor);

  return runTransaction(async (tx) => {
    const signatureClient = legacySignatureClient(tx);
    const emailBlockClient = blockClient(tx);
    let legacySignature = null;
    let footer = null;

    if (signatureClient?.upsert) {
      legacySignature = await signatureClient.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          enabled,
          html,
          text,
          updatedBy,
        },
        update: {
          enabled,
          html,
          text,
          updatedBy,
        },
      });
    }

    if (emailBlockClient?.findFirst && emailBlockClient?.create && emailBlockClient?.update && emailBlockClient?.updateMany) {
      const existing = await emailBlockClient.findFirst({
        where: {
          workspaceId,
          type: EMAIL_BLOCK_TYPES.FOOTER,
          isDefault: true,
        },
      });
      await emailBlockClient.updateMany({
        where: {
          workspaceId,
          type: EMAIL_BLOCK_TYPES.FOOTER,
          isDefault: true,
          ...(existing ? { id: { not: existing.id } } : {}),
        },
        data: { isDefault: false },
      });
      footer = existing
        ? await emailBlockClient.update({
          where: { id: existing.id },
          data: {
            name: existing.name || DEFAULT_BLOCK_NAMES[EMAIL_BLOCK_TYPES.FOOTER],
            enabled,
            isDefault: true,
            html,
            text,
            updatedBy,
          },
        })
        : await emailBlockClient.create({
          data: {
            workspaceId,
            type: EMAIL_BLOCK_TYPES.FOOTER,
            name: DEFAULT_BLOCK_NAMES[EMAIL_BLOCK_TYPES.FOOTER],
            enabled,
            isDefault: true,
            html,
            text,
            updatedBy,
          },
        });
    }

    return footer || legacySignature;
  });
}

export async function listWorkspaceEmailBlocks(workspaceId) {
  const emailBlockClient = blockClient();
  if (!emailBlockClient?.findMany) {
    return groupEmailBlocks([]);
  }
  const rows = await emailBlockClient.findMany({
    where: { workspaceId },
    orderBy: [
      { type: 'asc' },
      { isDefault: 'desc' },
      { name: 'asc' },
      { id: 'asc' },
    ],
  });
  return groupEmailBlocks(rows.map(serializeEmailBlock));
}

export async function getWorkspaceEmailBlock(workspaceId, id, type = null) {
  const normalizedType = type ? normalizeEmailBlockType(type) : null;
  const block = await findWorkspaceEmailBlock(workspaceId, normalizePositiveId(id), normalizedType);
  if (!block) throw new NotFoundError('Email branding block not found');
  return serializeEmailBlock(block);
}

export async function createWorkspaceEmailBlock(workspaceId, input = {}, actor = null) {
  const normalized = normalizeBlockPayload(input, null);
  const updatedBy = actorEmail(actor);
  return runTransaction(async (tx) => {
    const emailBlockClient = blockClient(tx);
    if (!emailBlockClient?.create) throw new NotFoundError('Email branding blocks are not available');
    const existingDefault = await emailBlockClient.findFirst({
      where: {
        workspaceId,
        type: normalized.type,
        isDefault: true,
      },
    });
    const shouldBeDefault = normalized.isDefault === true || !existingDefault;
    if (shouldBeDefault) {
      await emailBlockClient.updateMany({
        where: {
          workspaceId,
          type: normalized.type,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }
    const block = await emailBlockClient.create({
      data: {
        workspaceId,
        type: normalized.type,
        name: normalized.name,
        enabled: normalized.enabled,
        isDefault: shouldBeDefault,
        html: normalized.html,
        text: normalized.text,
        updatedBy,
      },
    });
    return serializeEmailBlock(block);
  });
}

export async function updateWorkspaceEmailBlock(workspaceId, id, input = {}, actor = null) {
  const normalizedId = normalizePositiveId(id);
  return runTransaction(async (tx) => {
    const emailBlockClient = blockClient(tx);
    if (!emailBlockClient?.update) throw new NotFoundError('Email branding blocks are not available');
    const existing = await findWorkspaceEmailBlock(workspaceId, normalizedId, null, tx);
    if (!existing) throw new NotFoundError('Email branding block not found');
    const normalized = normalizeBlockPayload(input, existing);
    if (normalized.isDefault === true) {
      await emailBlockClient.updateMany({
        where: {
          workspaceId,
          type: normalized.type,
          isDefault: true,
          id: { not: existing.id },
        },
        data: { isDefault: false },
      });
    }
    const block = await emailBlockClient.update({
      where: { id: existing.id },
      data: {
        type: normalized.type,
        name: normalized.name,
        enabled: normalized.enabled,
        isDefault: normalized.isDefault,
        html: normalized.html,
        text: normalized.text,
        updatedBy: actorEmail(actor),
      },
    });
    return serializeEmailBlock(block);
  });
}

export async function setDefaultWorkspaceEmailBlock(workspaceId, id, actor = null) {
  const normalizedId = normalizePositiveId(id);
  return runTransaction(async (tx) => {
    const emailBlockClient = blockClient(tx);
    if (!emailBlockClient?.update) throw new NotFoundError('Email branding blocks are not available');
    const block = await findWorkspaceEmailBlock(workspaceId, normalizedId, null, tx);
    if (!block) throw new NotFoundError('Email branding block not found');
    await emailBlockClient.updateMany({
      where: {
        workspaceId,
        type: block.type,
        isDefault: true,
        id: { not: block.id },
      },
      data: { isDefault: false },
    });
    const updated = await emailBlockClient.update({
      where: { id: block.id },
      data: {
        isDefault: true,
        enabled: true,
        updatedBy: actorEmail(actor),
      },
    });
    return serializeEmailBlock(updated);
  });
}

export async function deleteWorkspaceEmailBlock(workspaceId, id) {
  const normalizedId = normalizePositiveId(id);
  return runTransaction(async (tx) => {
    const emailBlockClient = blockClient(tx);
    if (!emailBlockClient?.delete) throw new NotFoundError('Email branding blocks are not available');
    const existing = await findWorkspaceEmailBlock(workspaceId, normalizedId, null, tx);
    if (!existing) throw new NotFoundError('Email branding block not found');
    const deleted = await emailBlockClient.delete({ where: { id: existing.id } });
    if (existing.isDefault) {
      const replacement = await emailBlockClient.findFirst({
        where: {
          workspaceId,
          type: existing.type,
          enabled: true,
        },
        orderBy: [
          { updatedAt: 'desc' },
          { id: 'asc' },
        ],
      });
      if (replacement) {
        await emailBlockClient.update({
          where: { id: replacement.id },
          data: { isDefault: true },
        });
      }
    }
    return serializeEmailBlock(deleted);
  });
}

function makeLegacyFooterBlock(signature = null) {
  if (!signature?.enabled || !blockHasContent(signature)) return null;
  return {
    id: null,
    workspaceId: signature.workspaceId || null,
    type: EMAIL_BLOCK_TYPES.FOOTER,
    name: 'Legacy workspace signature',
    enabled: signature.enabled === true,
    isDefault: true,
    html: signature.html || '',
    text: signature.text || '',
    updatedAt: signature.updatedAt || null,
    updatedBy: signature.updatedBy || null,
    legacy: true,
  };
}

function emptyBrandingStatus(type, requested, reason = null, selectedBlockId = null, warning = null) {
  return {
    type,
    label: EMAIL_BLOCK_LABELS[type],
    requested: requested === true,
    applied: false,
    skipped: true,
    reason,
    warning,
    selectedBlockId,
    selectedBlockName: null,
    blockId: null,
    blockName: null,
    isDefault: false,
    fallback: false,
    legacy: false,
  };
}

function appliedBrandingStatus(type, block, selectedBlockId = null, fallback = false, warning = null) {
  return {
    type,
    label: EMAIL_BLOCK_LABELS[type],
    requested: true,
    applied: true,
    skipped: false,
    reason: null,
    warning,
    selectedBlockId,
    selectedBlockName: null,
    blockId: block.id || null,
    blockName: block.name || DEFAULT_BLOCK_NAMES[type],
    isDefault: block.isDefault === true,
    fallback: fallback === true,
    legacy: block.legacy === true,
  };
}

async function resolveEmailBlockForSend(workspaceId, type, selectedBlockId = null, client = prisma) {
  const emailBlockClient = blockClient(client);
  const selectedSelection = coerceOptionalSelectionId(selectedBlockId, type);
  const selectedId = selectedSelection.id;
  let selectedBlockName = null;
  let warning = selectedSelection.warning;

  if (emailBlockClient?.findFirst && selectedId) {
    const selected = await emailBlockClient.findFirst({
      where: {
        id: selectedId,
        workspaceId,
        type,
      },
    });
    selectedBlockName = selected?.name || null;
    if (!selected) {
      warning = `Selected ${EMAIL_BLOCK_LABELS[type].toLowerCase()} block #${selectedId} was not found; workspace default was used if available.`;
    } else if (selected.enabled !== true) {
      warning = `Selected ${EMAIL_BLOCK_LABELS[type].toLowerCase()} block "${selected.name}" is disabled; workspace default was used if available.`;
    } else if (!blockHasContent(selected)) {
      warning = `Selected ${EMAIL_BLOCK_LABELS[type].toLowerCase()} block "${selected.name}" is empty; workspace default was used if available.`;
    } else {
      return {
        block: selected,
        status: {
          ...appliedBrandingStatus(type, selected, selectedId, false),
          selectedBlockName,
        },
      };
    }
  }

  const defaultBlock = await findDefaultEmailBlock(workspaceId, type, client);
  if (defaultBlock?.enabled && blockHasContent(defaultBlock)) {
    return {
      block: defaultBlock,
      status: {
        ...appliedBrandingStatus(type, defaultBlock, selectedId, Boolean(selectedId), warning),
        selectedBlockName,
      },
    };
  }

  if (type === EMAIL_BLOCK_TYPES.FOOTER) {
    const legacyBlock = makeLegacyFooterBlock(await findLegacySignature(workspaceId, client));
    if (legacyBlock) {
      return {
        block: legacyBlock,
        status: {
          ...appliedBrandingStatus(type, legacyBlock, selectedId, Boolean(selectedId), warning),
          selectedBlockName,
        },
      };
    }
  }

  if (defaultBlock?.enabled && !blockHasContent(defaultBlock) && !warning) {
    warning = `Default ${EMAIL_BLOCK_LABELS[type].toLowerCase()} block "${defaultBlock.name}" is empty and was skipped.`;
  }

  const reason = selectedId
    ? `Selected ${EMAIL_BLOCK_LABELS[type].toLowerCase()} block could not be applied and no usable default was available`
    : `No usable default ${EMAIL_BLOCK_LABELS[type].toLowerCase()} block is configured`;
  return {
    block: null,
    status: {
      ...emptyBrandingStatus(type, true, reason, selectedId, warning),
      selectedBlockName,
    },
  };
}

function applyEmailBlockToEmail(email = {}, block = null, type = EMAIL_BLOCK_TYPES.FOOTER) {
  if (!blockHasContent(block)) return email;
  const blockHtml = String(block.html || '').trim();
  const blockText = String(block.text || stripHtml(blockHtml)).trim();
  const baseText = String(email.text || stripHtml(email.html)).trim();
  const htmlParts = type === EMAIL_BLOCK_TYPES.HEADER
    ? [blockHtml, email.html]
    : [email.html, blockHtml];
  const textParts = type === EMAIL_BLOCK_TYPES.HEADER
    ? [blockText, baseText]
    : [baseText, blockText];
  return {
    ...email,
    html: htmlParts.filter(Boolean).join('\n') || null,
    text: textParts.filter(Boolean).join('\n\n') || null,
  };
}

function applyBrandingStatusToEmail(email = {}, branding = {}) {
  const header = branding.header || emptyBrandingStatus(EMAIL_BLOCK_TYPES.HEADER, false, 'Header not requested');
  const footer = branding.footer || emptyBrandingStatus(EMAIL_BLOCK_TYPES.FOOTER, false, 'Footer not requested');
  const warnings = [header.warning, footer.warning].filter(Boolean);
  return {
    ...email,
    branding: {
      header,
      footer,
      warnings,
    },
    brandingWarnings: warnings,
    headerApplied: header.applied === true,
    headerBlockId: header.blockId || null,
    headerBlockName: header.blockName || null,
    footerApplied: footer.applied === true,
    footerBlockId: footer.blockId || null,
    footerBlockName: footer.blockName || null,
    signatureApplied: email.signatureApplied === true || footer.applied === true,
  };
}

export async function applyWorkspaceEmailBranding({
  workspaceId,
  email = {},
  nodeData = {},
  allowFailure = false,
} = {}) {
  if (!workspaceId) return email;
  const includeHeader = nodeData?.includeHeader === true;
  const includeFooter = nodeData?.includeFooter !== false;
  let next = email || {};
  const branding = {
    header: emptyBrandingStatus(EMAIL_BLOCK_TYPES.HEADER, includeHeader, includeHeader ? null : 'Header not requested'),
    footer: emptyBrandingStatus(EMAIL_BLOCK_TYPES.FOOTER, includeFooter, includeFooter ? null : 'Footer not requested'),
  };

  try {
    if (includeHeader) {
      const resolvedHeader = await resolveEmailBlockForSend(
        workspaceId,
        EMAIL_BLOCK_TYPES.HEADER,
        nodeData?.headerBlockId,
      );
      branding.header = resolvedHeader.status;
      next = applyEmailBlockToEmail(next, resolvedHeader.block, EMAIL_BLOCK_TYPES.HEADER);
    }

    if (includeFooter && !next.footerApplied) {
      const resolvedFooter = await resolveEmailBlockForSend(
        workspaceId,
        EMAIL_BLOCK_TYPES.FOOTER,
        nodeData?.footerBlockId,
      );
      branding.footer = resolvedFooter.status;
      next = applyEmailBlockToEmail(next, resolvedFooter.block, EMAIL_BLOCK_TYPES.FOOTER);
    }
  } catch (error) {
    if (!allowFailure) throw error;
    const warning = `Email branding could not be loaded: ${error.message}`;
    if (includeHeader) branding.header.warning = warning;
    if (includeFooter) branding.footer.warning = warning;
  }

  return applyBrandingStatusToEmail(next, branding);
}

export function appendSignatureToEmail(email = {}, signature = null) {
  if (!signature?.enabled || email.signatureApplied) return email;
  const signatureHtml = String(signature.html || '').trim();
  const signatureText = String(signature.text || stripHtml(signatureHtml)).trim();
  if (!signatureHtml && !signatureText) return email;

  const html = [email.html, signatureHtml].filter(Boolean).join('\n');
  const text = [email.text || stripHtml(email.html), signatureText].filter(Boolean).join('\n\n');
  return {
    ...email,
    html: html || null,
    text: text || null,
    signatureApplied: true,
  };
}

export { MAX_SIGNATURE_HTML_BYTES };
