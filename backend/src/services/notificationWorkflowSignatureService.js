import sanitizeHtml from 'sanitize-html';
import prisma from './prisma.js';

const MAX_SIGNATURE_HTML_BYTES = 512 * 1024;
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;

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

export function sanitizeSignatureHtml(html) {
  const raw = String(html || '').trim();
  if (!raw) return '';
  if (byteLength(raw) > MAX_SIGNATURE_HTML_BYTES) {
    throw new Error(`Signature HTML exceeds the ${Math.round(MAX_SIGNATURE_HTML_BYTES / 1024)} KB limit`);
  }

  const sanitized = sanitizeHtml(raw, {
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
  const cleaned = removeInvalidDataImageSources(sanitized);
  if (byteLength(cleaned) > MAX_SIGNATURE_HTML_BYTES) {
    throw new Error(`Signature HTML exceeds the ${Math.round(MAX_SIGNATURE_HTML_BYTES / 1024)} KB limit after sanitization`);
  }
  return cleaned;
}

export async function getWorkspaceSignature(workspaceId) {
  const signature = await prisma.notificationEmailSignature.findUnique({
    where: { workspaceId },
  });
  if (!signature) {
    return {
      enabled: false,
      html: '',
      text: '',
      updatedAt: null,
      updatedBy: null,
      maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
    };
  }
  return {
    enabled: signature.enabled,
    html: signature.html || '',
    text: signature.text || '',
    updatedAt: signature.updatedAt,
    updatedBy: signature.updatedBy,
    maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
  };
}

export async function upsertWorkspaceSignature(workspaceId, input = {}, actor = null) {
  const html = sanitizeSignatureHtml(input.html || '');
  const text = String(input.text || stripHtml(html)).trim();
  const enabled = input.enabled !== false && Boolean(html || text);
  const updatedBy = String(actor?.email || actor || '').trim() || null;

  return prisma.notificationEmailSignature.upsert({
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
