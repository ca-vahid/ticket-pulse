import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../utils/errors.js';
import {
  hashPublicStatusToken,
  getPublicTicketStatusSettings,
} from './publicTicketStatusService.js';

// First-party satisfaction feedback (custom CSAT replacement). Per-workspace
// branding/config for the public /feedback/:token page plus the public read/submit
// flow. Reuses the existing per-ticket PublicTicketStatusLink token.

const MAX_BRANDING_TEXT_LENGTH = 300;
const MAX_LOGO_DATA_URL_LENGTH = 700_000;
const MAX_COMMENT_LENGTH = 2000;
const ALLOWED_LOGO_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export const DEFAULT_PUBLIC_FEEDBACK_SETTINGS = {
  enabled: true,
  headline: 'How did we do?',
  subtext: 'Your feedback helps our team keep improving. It only takes a moment.',
  thankYouMessage: 'Thanks for letting us know — we really appreciate it.',
  commentEnabled: true,
  commentPrompt: "Anything you'd like to add? (optional)",
  label1: 'Bad',
  label2: 'Meh',
  label3: 'Okay',
  label4: 'Good',
  label5: 'Great',
  image1: null,
  image2: null,
  image3: null,
  image4: null,
  image5: null,
  brandName: null,
  logoDataUrl: null,
  logoAltText: null,
  trademarkText: null,
  accentColor: '#2563eb',
};

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function hashText(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cleanText(value, maxLength = MAX_BRANDING_TEXT_LENGTH, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

function cleanComment(value) {
  if (value === undefined || value === null) return null;
  // Preserve line breaks (comments may be multi-line) but normalise runs of
  // spaces/tabs and collapse excessive blank lines.
  const text = String(value)
    .replace(/\r\n/g, '\n')
    .replace(/[\t\f ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  return text.slice(0, MAX_COMMENT_LENGTH);
}

function cleanAccentColor(value) {
  const text = String(value || '').trim();
  return HEX_COLOR_RE.test(text) ? text : DEFAULT_PUBLIC_FEEDBACK_SETTINGS.accentColor;
}

function cleanLogoDataUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (text.length > MAX_LOGO_DATA_URL_LENGTH) {
    throw new ValidationError('Logo image is too large. Use a PNG, JPG, WEBP, or GIF under 512 KB.');
  }
  if (!ALLOWED_LOGO_DATA_URL.test(text)) {
    throw new ValidationError('Logo must be a PNG, JPG, WEBP, or GIF image data URL.');
  }
  return text.replace(/\s/g, '');
}

function cleanImageDataUrl(value) {
  // Per-score images are optional; reuse the logo validator (same constraints).
  if (value === undefined || value === null || value === '') return null;
  return cleanLogoDataUrl(value);
}

export function normalizePublicFeedbackSettings(row = {}) {
  const d = DEFAULT_PUBLIC_FEEDBACK_SETTINGS;
  return {
    enabled: bool(row.enabled, d.enabled),
    headline: cleanText(row.headline, 160, d.headline),
    subtext: cleanText(row.subtext, 400, d.subtext),
    thankYouMessage: cleanText(row.thankYouMessage, 400, d.thankYouMessage),
    commentEnabled: bool(row.commentEnabled, d.commentEnabled),
    commentPrompt: cleanText(row.commentPrompt, 200, d.commentPrompt),
    label1: cleanText(row.label1, 40, d.label1),
    label2: cleanText(row.label2, 40, d.label2),
    label3: cleanText(row.label3, 40, d.label3),
    label4: cleanText(row.label4, 40, d.label4),
    label5: cleanText(row.label5, 40, d.label5),
    image1: row.image1 || null,
    image2: row.image2 || null,
    image3: row.image3 || null,
    image4: row.image4 || null,
    image5: row.image5 || null,
    brandName: cleanText(row.brandName, 120, null),
    logoDataUrl: row.logoDataUrl || null,
    logoAltText: cleanText(row.logoAltText, 160, null),
    trademarkText: cleanText(row.trademarkText, 300, null),
    accentColor: cleanAccentColor(row.accentColor),
    updatedBy: row.updatedBy || null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

function normalizeSettingsInput(input = {}) {
  const merged = normalizePublicFeedbackSettings({ ...DEFAULT_PUBLIC_FEEDBACK_SETTINGS, ...input });
  return {
    enabled: merged.enabled,
    headline: merged.headline,
    subtext: merged.subtext,
    thankYouMessage: merged.thankYouMessage,
    commentEnabled: merged.commentEnabled,
    commentPrompt: merged.commentPrompt,
    label1: merged.label1,
    label2: merged.label2,
    label3: merged.label3,
    label4: merged.label4,
    label5: merged.label5,
    image1: cleanImageDataUrl(input.image1),
    image2: cleanImageDataUrl(input.image2),
    image3: cleanImageDataUrl(input.image3),
    image4: cleanImageDataUrl(input.image4),
    image5: cleanImageDataUrl(input.image5),
    brandName: cleanText(input.brandName, 120, null),
    logoDataUrl: cleanLogoDataUrl(input.logoDataUrl),
    logoAltText: cleanText(input.logoAltText, 160, null),
    trademarkText: cleanText(input.trademarkText, 300, null),
    accentColor: cleanAccentColor(input.accentColor),
  };
}

export async function getFeedbackSettings(workspaceId) {
  const row = await prisma.publicFeedbackSettings.upsert({
    where: { workspaceId },
    update: {},
    create: { workspaceId, ...DEFAULT_PUBLIC_FEEDBACK_SETTINGS },
  });
  return normalizePublicFeedbackSettings(row);
}

export async function updateFeedbackSettings(workspaceId, input = {}, actor = null) {
  const data = normalizeSettingsInput(input);
  const actorEmail = actor?.email || actor?.username || null;
  const row = await prisma.publicFeedbackSettings.upsert({
    where: { workspaceId },
    update: { ...data, updatedBy: actorEmail },
    create: { workspaceId, ...data, updatedBy: actorEmail },
  });
  return normalizePublicFeedbackSettings(row);
}

// Lightweight token validator — hash lookup + enabled/revoked/expiry checks, with
// the ticket + workspace joined. Mirrors the escalation service's validator but
// stays self-contained to this module.
async function getFeedbackLinkByToken(token) {
  const trimmed = String(token || '').trim();
  if (!trimmed) throw new NotFoundError('Feedback link not found');
  const link = await prisma.publicTicketStatusLink.findUnique({
    where: { tokenHash: hashPublicStatusToken(trimmed) },
    include: {
      ticket: {
        select: {
          id: true,
          workspaceId: true,
          freshserviceTicketId: true,
          subject: true,
          status: true,
        },
      },
      feedback: { select: { score: true, normalizedScore: true, comment: true, submittedAt: true } },
    },
  });
  if (!link) throw new NotFoundError('Feedback link not found');
  if (!link.enabled || link.revokedAt) throw new AuthorizationError('This feedback link is no longer active');
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
    throw new AuthorizationError('This feedback link has expired');
  }
  if (!link.ticket) throw new NotFoundError('Ticket not found');
  return { token: trimmed, link };
}

function resolveBranding(feedbackSettings, statusSettings, workspaceName) {
  // Feedback branding wins; fall back to the public-status branding so admins
  // don't re-enter a logo they already configured, then to the workspace name.
  return {
    brandName: feedbackSettings.brandName || statusSettings?.brandName || workspaceName || 'Ticket Pulse',
    logoDataUrl: feedbackSettings.logoDataUrl || statusSettings?.logoDataUrl || null,
    logoAltText: feedbackSettings.logoAltText
      || statusSettings?.logoAltText
      || feedbackSettings.brandName
      || workspaceName
      || null,
    trademarkText: feedbackSettings.trademarkText || statusSettings?.trademarkText || null,
    accentColor: feedbackSettings.accentColor || statusSettings?.accentColor || DEFAULT_PUBLIC_FEEDBACK_SETTINGS.accentColor,
  };
}

function publicPagePayload(settings, branding, ticket, existing) {
  return {
    ticket: {
      number: ticket.freshserviceTicketId ? String(ticket.freshserviceTicketId) : null,
      subject: ticket.subject || null,
      status: ticket.status || null,
    },
    branding,
    page: {
      headline: settings.headline,
      subtext: settings.subtext,
      thankYouMessage: settings.thankYouMessage,
      commentEnabled: settings.commentEnabled,
      commentPrompt: settings.commentPrompt,
      labels: [settings.label1, settings.label2, settings.label3, settings.label4, settings.label5],
      images: [settings.image1, settings.image2, settings.image3, settings.image4, settings.image5],
    },
    existing: existing
      ? {
        score: existing.score,
        normalizedScore: existing.normalizedScore,
        comment: existing.comment || null,
        submittedAt: existing.submittedAt ? new Date(existing.submittedAt).toISOString() : null,
      }
      : null,
  };
}

export async function getTicketFeedbackByToken(token) {
  const { link } = await getFeedbackLinkByToken(token);
  const workspaceId = link.ticket.workspaceId;
  const settings = await getFeedbackSettings(workspaceId);
  if (!settings.enabled) {
    throw new AuthorizationError('Feedback is not currently being collected for this workspace');
  }
  const statusSettings = await getPublicTicketStatusSettings(workspaceId).catch(() => null);
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });
  const branding = resolveBranding(settings, statusSettings, workspace?.name);
  return publicPagePayload(settings, branding, link.ticket, link.feedback);
}

export async function submitTicketFeedback(token, { score, comment, ip, userAgent } = {}) {
  const { link } = await getFeedbackLinkByToken(token);
  const workspaceId = link.ticket.workspaceId;
  const settings = await getFeedbackSettings(workspaceId);
  if (!settings.enabled) {
    throw new AuthorizationError('Feedback is not currently being collected for this workspace');
  }

  const parsedScore = Number.parseInt(score, 10);
  if (!Number.isFinite(parsedScore) || parsedScore < 1 || parsedScore > 5) {
    throw new ValidationError('Please choose a rating from 1 to 5.');
  }
  const normalizedScore = (parsedScore - 1) * 25;
  const cleanedComment = settings.commentEnabled ? cleanComment(comment) : null;

  const data = {
    workspaceId,
    ticketId: link.ticket.id,
    score: parsedScore,
    normalizedScore,
    comment: cleanedComment,
    ipHash: hashText(ip || ''),
    userAgent: String(userAgent || '').slice(0, 500) || null,
  };

  await prisma.ticketFeedback.upsert({
    where: { linkId: link.id },
    update: {
      score: data.score,
      normalizedScore: data.normalizedScore,
      comment: data.comment,
      ipHash: data.ipHash,
      userAgent: data.userAgent,
      submittedAt: new Date(),
    },
    create: { linkId: link.id, ...data },
  });

  logger.info('Ticket feedback submitted', { workspaceId, ticketId: link.ticket.id, score: parsedScore });

  return {
    status: 'submitted',
    score: parsedScore,
    normalizedScore,
    comment: cleanedComment,
    thankYouMessage: settings.thankYouMessage,
  };
}

export default {
  DEFAULT_PUBLIC_FEEDBACK_SETTINGS,
  normalizePublicFeedbackSettings,
  getFeedbackSettings,
  updateFeedbackSettings,
  getTicketFeedbackByToken,
  submitTicketFeedback,
};
