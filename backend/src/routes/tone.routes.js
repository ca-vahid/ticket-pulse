import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin, requireAdminOrObserver } from '../middleware/auth.js';
import prisma from '../services/prisma.js';
import toneService, { DEFAULT_SERIOUS_TONE_TEXT, normalizeEmail } from '../services/toneService.js';
import logger from '../utils/logger.js';

/**
 * Tone of voice (QA 09-25 item 5): the workspace default voice, the
 * Straight-Talk List and the professional-tone text for Mail Workflows' AI
 * e-mails. Settings reads for any workspace member; the Straight-Talk List
 * itself (names of people) for admins and read-only observers only (review
 * N7); writes are admin-only.
 */
const router = express.Router();
router.use(requireAuth);

const actorEmail = (req) => req.user?.email || req.session?.user?.email || null;
const bad = (res, message) => res.status(400).json({ success: false, message });

// Canned illustration for the "Check a person" box — no LLM call.
const SAMPLE = Object.freeze({
  friendly: 'Hi Sam! Thanks for flagging the VPN hiccup - we are on it and will have you back online in no time. :)',
  professional: 'Hi Sam, thank you for reporting the VPN issue. We are looking into it and will update you as soon as we know more.',
});

router.get('/settings', asyncHandler(async (req, res) => {
  const settings = await toneService.getSettings(req.workspaceId);
  res.json({ success: true, data: { ...settings, defaultSeriousToneText: DEFAULT_SERIOUS_TONE_TEXT } });
}));

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};
    const settings = await toneService.updateSettings(req.workspaceId, {
      defaultVoice: body.defaultVoice,
      seriousToneText: body.seriousToneText,
      seriousWhenFrustrated: body.seriousWhenFrustrated,
    }, actorEmail(req));
    logger.info(`Tone settings updated (ws ${req.workspaceId})`);
    res.json({ success: true, data: { ...settings, defaultSeriousToneText: DEFAULT_SERIOUS_TONE_TEXT } });
  } catch (err) { return bad(res, err.message); }
}));

router.get('/contacts', requireAdminOrObserver, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await toneService.listContacts(req.workspaceId) });
}));

router.post('/contacts', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const { email, name, note } = req.body || {};
    const contact = await toneService.addContact(req.workspaceId, { email, name, note }, actorEmail(req));
    logger.info(`Straight-Talk List: added contact ${contact.id} (ws ${req.workspaceId})`);
    res.status(201).json({ success: true, data: contact });
  } catch (err) { return bad(res, err.message); }
}));

router.delete('/contacts/:id', requireAdmin, asyncHandler(async (req, res) => {
  try {
    res.json({ success: true, data: await toneService.removeContact(req.workspaceId, req.params.id) });
  } catch (err) { return res.status(404).json({ success: false, message: err.message }); }
}));

/**
 * POST /tone/preview {email, sampleTicketId?} — which voice an AI e-mail to
 * this person would use right now, and why. The sample ticket (optional)
 * supplies the stored requester sentiment.
 */
router.post('/preview', requireAdminOrObserver, asyncHandler(async (req, res) => {
  const { email, sampleTicketId } = req.body || {};
  const normalized = normalizeEmail(email);
  if (!normalized) return bad(res, 'A valid e-mail address is required');
  let sentiment = null;
  let ticket = null;
  if (sampleTicketId) {
    ticket = await Promise.resolve()
      .then(() => prisma.ticket.findFirst({
        where: { id: Number(sampleTicketId), workspaceId: req.workspaceId },
        select: { id: true, subject: true, sentiment: true },
      }))
      .catch(() => null);
    sentiment = ticket?.sentiment || null;
  }
  const tone = await toneService.resolveToneForTicket({ workspaceId: req.workspaceId, requesterEmail: normalized, sentiment });
  const professional = Boolean(tone.override) || tone.voice === 'professional';
  res.json({
    success: true,
    data: {
      email: normalized,
      voice: professional ? 'professional' : 'workflow',
      workspaceVoice: tone.voice,
      onStraightTalkList: tone.onStraightTalkList,
      override: tone.override ? { reason: tone.override.reason, text: tone.override.text } : null,
      sentiment,
      ticket: ticket ? { id: ticket.id, subject: ticket.subject } : null,
      illustration: { before: SAMPLE.friendly, after: professional ? SAMPLE.professional : SAMPLE.friendly },
    },
  });
}));

export default router;
