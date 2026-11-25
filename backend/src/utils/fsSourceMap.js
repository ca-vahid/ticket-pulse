/**
 * Ticket Pulse source → FreshService source for a Ticket Pulse ticket's
 * FreshService copy (QA 11-24 item 10).
 *
 * The copy was made as Email (front-door mail) or Portal (everything else) and
 * never updated after, so a ticket logged as Phone, or moved to Phone later,
 * showed "Email" in FreshService. Now each Ticket Pulse source goes to the
 * closest FreshService source, on create and whenever the source changes.
 *
 * FreshService's standard ids: 1 Email, 2 Portal, 3 Phone, 4 Chat, 5 Feedback
 * widget, 6 Yammer, 7 AWS Cloudwatch, 8 Pagerduty, 9 Walkup, 10 Slack.
 * Only standard ids are sent: the custom choices utils/ticketOrigin.js knows
 * (13–19, 1001, 1002) were read from one FreshService instance and are not
 * guaranteed in every workspace's form, and FreshService rules keyed on them
 * (Alerts, MS Teams) could act on the copy.
 *
 * Email is the one exception to "closest": mail that came in on a side
 * mailbox stays Portal on the copy, as before (mirrorService._isFrontDoorMail),
 * so FreshService's "source is Email" workflows (the 'Received' e-mail) run
 * only for mail that came through the team's front door.
 */
import { TICKET_SOURCE } from './ticketOrigin.js';

export const FS_SOURCE = Object.freeze({
  EMAIL: 1,
  PORTAL: 2,
  PHONE: 3,
  CHAT: 4,
  FEEDBACK_WIDGET: 5,
  YAMMER: 6,
  AWS_CLOUDWATCH: 7,
  PAGERDUTY: 8,
  WALK_UP: 9,
  SLACK: 10,
});

const STANDARD_FS_SOURCES = new Set(Object.values(FS_SOURCE));

/**
 * The table, with why. Email is listed as Email; fsSourceFor applies the
 * front-door rule. FreshService's own ids (1–10) on a Ticket Pulse ticket map
 * to themselves.
 */
export const TP_TO_FS_SOURCE = Object.freeze({
  [TICKET_SOURCE.EMAIL]: FS_SOURCE.EMAIL, // 1 Email → Email (front-door mail) / Portal (side mailbox)
  [TICKET_SOURCE.PORTAL]: FS_SOURCE.PORTAL, // 2 Portal → Portal
  [TICKET_SOURCE.PHONE]: FS_SOURCE.PHONE, // 3 Phone → Phone
  [TICKET_SOURCE.WALK_UP]: FS_SOURCE.WALK_UP, // 9 Walk-up → Walkup
  [TICKET_SOURCE.API]: FS_SOURCE.PORTAL, // 100 API: a system filed a form-like request; Email would wake FS mail rules
  [TICKET_SOURCE.WEBHOOK]: FS_SOURCE.PORTAL, // 101 Webhook: same as API
  [TICKET_SOURCE.MS_TEAMS]: FS_SOURCE.CHAT, // 102 MS Teams: a chat conversation
  [TICKET_SOURCE.AGENT]: FS_SOURCE.PORTAL, // 103 Agent: staff logged it in the app (FS's "created in the web app")
  [TICKET_SOURCE.SECURITY_AGENT]: FS_SOURCE.PORTAL, // 104 Security agent: a system filing (no standard alert source)
  [TICKET_SOURCE.OFFICE_CHECK_IN]: FS_SOURCE.PORTAL, // 105 Office check-in: generated task
  [TICKET_SOURCE.MONITORING_ALERT]: FS_SOURCE.PORTAL, // 106 Monitoring alert: no standard generic alert source (7/8 name one vendor)
});

/**
 * The FreshService source for a Ticket Pulse source.
 * @param {number|string|null} tpSource
 * @param {{ frontDoorMail?: boolean }} [options] mail on the team's front-door mailbox
 * @returns {number} a standard FreshService source id
 */
export function fsSourceFor(tpSource, { frontDoorMail = false } = {}) {
  const n = Number(tpSource);
  if (!Number.isInteger(n)) return FS_SOURCE.PORTAL;
  if (n === TICKET_SOURCE.EMAIL) return frontDoorMail ? FS_SOURCE.EMAIL : FS_SOURCE.PORTAL;
  if (Object.prototype.hasOwnProperty.call(TP_TO_FS_SOURCE, n)) return TP_TO_FS_SOURCE[n];
  if (STANDARD_FS_SOURCES.has(n)) return n;
  return FS_SOURCE.PORTAL;
}

export default { FS_SOURCE, TP_TO_FS_SOURCE, fsSourceFor };
