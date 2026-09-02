/**
 * QA 09-02 — Phase AP (public approval page redesign) live query-shape probe.
 * DEV ONLY — refuses any DATABASE_URL that is not localhost.
 *
 * A mocked Prisma cannot catch a wrong field/relation name, so this runs the
 * NEW queries against the real dev database:
 *   - ticketApprovalService.request (fan-out) on a dev TP-born ticket
 *   - getByToken: ticket select (internalCategory/internalSubcategory/requester
 *     Entra fields/workspace slug), sibling findMany, approvalCategory
 *     findUnique, technician/requester name lookups, view-counter update
 *     (viewCount/lastViewedAt from 20260902030000_ticket_approval_views)
 *   - photoSubjectEmail (both `who` values)
 * The created approval row is LEFT IN PLACE so the page can be screenshotted;
 * its token is printed and written next to the payload.
 *
 * Usage: node scripts/qa-0902-approval-probe.mjs   (reads backend/.env)
 *   PROBE_WORKSPACE_ID=1   workspace to use (default 1)
 *   PROBE_TICKET_ID=<id>   pin a TP-born ticket (default: newest TP-born open ticket)
 *   PROBE_API_BASE=http://localhost:3111  also hit the HTTP routes when set
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.TP_SUPPRESS_APPROVAL_EMAIL = '1';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a local dev database');
  process.exit(2);
}

const { default: prisma } = await import('../src/services/prisma.js');
const { default: ticketApprovalService } = await import('../src/services/ticketApprovalService.js');

const WS = Number(process.env.PROBE_WORKSPACE_ID || 1);
const OUT_DIR = path.resolve(process.cwd(), '..', 'qa', 'evidence-0902', 'phaseAP');
fs.mkdirSync(OUT_DIR, { recursive: true });

const steps = [];
function ok(name, detail) { steps.push({ name, ok: true, detail }); console.log(`PASS ${name}${detail ? ` -- ${detail}` : ''}`); }
function fail(name, err) { steps.push({ name, ok: false, err: err.message }); console.log(`FAIL ${name} -- ${err.message}`); }

let token = null;
let approvalId = null;
try {
  // 1. Pick an active category with managers + a TP-born ticket without an open request on it.
  const category = await prisma.approvalCategory.findFirst({
    where: { workspaceId: WS, isActive: true, NOT: { managerEmails: { isEmpty: true } } },
    orderBy: { id: 'asc' },
  });
  if (!category) throw new Error(`No active approval category with managers in workspace ${WS}`);
  ok('approvalCategory.findFirst', `${category.name} → ${category.managerEmails.join(', ')}`);

  let ticket = null;
  if (process.env.PROBE_TICKET_ID) {
    ticket = await prisma.ticket.findFirst({ where: { id: Number(process.env.PROBE_TICKET_ID), workspaceId: WS } });
  } else {
    const candidates = await prisma.ticket.findMany({
      where: { workspaceId: WS, origin: 'ticketpulse', status: { notIn: ['Closed', 'Resolved', 'closed', 'resolved'] } },
      orderBy: { id: 'desc' },
      take: 25,
      select: { id: true, subject: true, approvals: { where: { status: { in: ['pending', 'info_requested'] } }, select: { approvalCategoryId: true } } },
    });
    ticket = candidates.find((t) => !t.approvals.some((a) => a.approvalCategoryId === category.id)) || null;
  }
  if (!ticket) throw new Error('No TP-born dev ticket without an open request on that category');
  ok('ticket.findMany (TP-born, open)', `ticket ${ticket.id} "${ticket.subject}"`);

  // 2. request() — fan-out + the widened requester select (jobTitle/entraJobTitle).
  const req = await ticketApprovalService.request(
    ticket.id, WS,
    {
      approvalCategoryId: category.id,
      note: 'Phase AP probe — two quotes attached below. {{decision.url}}',
      noteHtml: '<p>Phase AP probe — two quotes attached below.</p>'
        + '<table class="tp-data-table" style="border-collapse:collapse"><thead><tr>'
        + '<th style="border:1px solid #cbd5e1;padding:4px 8px">Vendor</th><th style="border:1px solid #cbd5e1;padding:4px 8px">Price</th></tr></thead>'
        + '<tbody><tr><td style="border:1px solid #cbd5e1;padding:4px 8px">Dell</td><td style="border:1px solid #cbd5e1;padding:4px 8px;text-align:right">$1,850</td></tr>'
        + '<tr><td style="border:1px solid #cbd5e1;padding:4px 8px">Lenovo</td><td style="border:1px solid #cbd5e1;padding:4px 8px;text-align:right">$1,720</td></tr></tbody></table>',
      notifyApprover: false,
    },
    { email: 'vhaeri@bgcengineering.ca', name: 'Vahid Haeri' },
  );
  approvalId = req.approvals[0].id;
  ok('ticketApprovalService.request', `group ${req.requestGroupId} · ${req.count} row(s) · first id ${approvalId}`);

  // 3. Re-key the first row to a token we know (request() never returns raw tokens).
  token = crypto.randomBytes(32).toString('base64url');
  await prisma.ticketApproval.update({
    where: { id: approvalId },
    data: { tokenHash: crypto.createHash('sha256').update(token).digest('hex') },
  });
  ok('ticketApproval.update (re-key)', `approval ${approvalId}`);

  // 4. getByToken — every new query shape in one call.
  const payload = await ticketApprovalService.getByToken(token);
  ok('ticketApprovalService.getByToken', `${payload.ticket.displayRef} · ${payload.approvers.length} approver(s) · requestedByName=${payload.approval.requestedByName}`);
  const dump = JSON.stringify(payload, null, 2);
  // The token may appear ONLY inside the two photo URLs (the approver already holds it).
  const scrubbed = JSON.stringify(payload, (k, v) => (k === 'photoUrl' || k === 'requestedByPhotoUrl' ? undefined : v));
  if (scrubbed.includes(token)) throw new Error('payload leaks the raw token outside the photo URLs');
  if (JSON.stringify(payload.approvers).includes('@')) throw new Error('approvers list leaks an email');
  fs.writeFileSync(path.join(OUT_DIR, 'api-payload.json'), dump);
  ok('payload hygiene', `token only in photo URLs (${payload.approval.requestedByPhotoUrl ? 'Entra configured' : 'no photos'}) / no sibling emails in approvers`);

  // 5. View counter landed (fire-and-forget in the service — give it a tick).
  await new Promise((r) => setTimeout(r, 300));
  const viewed = await prisma.ticketApproval.findUnique({ where: { id: approvalId }, select: { viewCount: true, lastViewedAt: true } });
  if (!viewed || viewed.viewCount < 1 || !viewed.lastViewedAt) throw new Error(`view counter not bumped: ${JSON.stringify(viewed)}`);
  ok('viewCount/lastViewedAt', `viewCount=${viewed.viewCount} lastViewedAt=${viewed.lastViewedAt.toISOString()}`);

  // 6. photoSubjectEmail — both subjects resolve from the row.
  const requestedByEmail = await ticketApprovalService.photoSubjectEmail(token, 'requestedBy');
  const requesterEmail = await ticketApprovalService.photoSubjectEmail(token, 'requester');
  ok('photoSubjectEmail', `requestedBy=${requestedByEmail} requester=${requesterEmail}`);

  // 7. Name resolution (technician → requester → null).
  const name = await ticketApprovalService._resolvePersonName(payload.approval.requestedBy);
  ok('_resolvePersonName', `${payload.approval.requestedBy} → ${name}`);

  // 8. Optional HTTP pass against a running dev backend.
  if (process.env.PROBE_API_BASE) {
    const base = process.env.PROBE_API_BASE.replace(/\/+$/, '');
    const r = await fetch(`${base}/api/ticket-approvals/public/${encodeURIComponent(token)}`);
    const body = await r.json();
    if (!r.ok || !body?.data?.approval) throw new Error(`GET ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
    ok('HTTP GET /public/:token', `${r.status} · ratelimit-remaining=${r.headers.get('x-ratelimit-remaining')}`);
    fs.writeFileSync(path.join(OUT_DIR, 'api-payload-http.json'), JSON.stringify(body.data, null, 2));
    const p = await fetch(`${base}/api/ticket-approvals/public/${encodeURIComponent(token)}/photo?who=requestedBy`);
    ok('HTTP GET /public/:token/photo', `${p.status} ${p.headers.get('content-type')} cache=${p.headers.get('cache-control')}`);
    const bad = await fetch(`${base}/api/ticket-approvals/public/${encodeURIComponent(token)}/photo?who=x@y.io`);
    if (bad.status !== 400) throw new Error(`photo with bad who → ${bad.status}, expected 400`);
    ok('HTTP photo rejects bad who', '400');
  }

  const appBase = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const info = {
    approvalId,
    ticketId: ticket.id,
    requestGroupId: req.requestGroupId,
    token,
    apiUrl: `http://localhost:3111/api/ticket-approvals/public/${token}`,
    pageUrl: `${appBase}/approval/${token}`,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'token.json'), JSON.stringify(info, null, 2));
  console.log('\nTOKEN', token);
  console.log('PAGE ', info.pageUrl);
  console.log('API  ', info.apiUrl);
} catch (err) {
  fail('probe', err);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(OUT_DIR, 'probe-steps.json'), JSON.stringify(steps, null, 2));
  await prisma.$disconnect();
}
