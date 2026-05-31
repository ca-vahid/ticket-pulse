import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  getPublicTicketStatusByToken,
} from '../services/publicTicketStatusService.js';
import urgentEscalationService from '../services/afterHoursUrgentEscalationService.js';

export const publicTicketStatusPublicRouter = express.Router();

publicTicketStatusPublicRouter.get(
  '/:token/escalation',
  asyncHandler(async (req, res) => {
    const data = await urgentEscalationService.getPublicSelfEscalation(req.params.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data });
  }),
);

publicTicketStatusPublicRouter.post(
  '/:token/escalation',
  asyncHandler(async (req, res) => {
    const data = await urgentEscalationService.submitPublicSelfEscalation(req.params.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data });
  }),
);

publicTicketStatusPublicRouter.get(
  '/:token/urgency',
  asyncHandler(async (req, res) => {
    const data = await urgentEscalationService.getPublicBusinessUrgency(req.params.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data });
  }),
);

publicTicketStatusPublicRouter.post(
  '/:token/urgency',
  asyncHandler(async (req, res) => {
    const data = await urgentEscalationService.submitPublicBusinessUrgency(req.params.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data });
  }),
);

publicTicketStatusPublicRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const data = await getPublicTicketStatusByToken(req.params.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data });
  }),
);

export default publicTicketStatusPublicRouter;
