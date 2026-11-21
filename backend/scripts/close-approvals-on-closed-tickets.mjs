#!/usr/bin/env node
/**
 * One-off sweep (20 Nov 2026): approvals still open (pending / info_requested)
 * on tickets whose status base is Closed end as "not needed any more" — the
 * same quiet close a ticket close now does by itself
 * (src/services/approvalTicketCloseService.js):
 *
 *   status 'closed' · closeReason 'not_needed' · decidedVia 'ticket_closed'
 *   decisionNote "Not needed any more: the ticket was closed without a decision."
 *   + one history row per ticket ("Approval no longer needed: the ticket was closed")
 *
 * No e-mail, no Teams message, no workflow event. Teams approval cards already
 * sent are rewritten in place and an Assetron hold is released, as for a live close.
 *
 * Usage:
 *   node scripts/close-approvals-on-closed-tickets.mjs [--dry] [--workspace <id>] [--prod]
 *   node scripts/close-approvals-on-closed-tickets.mjs --apply [--workspace <id>] [--prod]
 *
 *   --dry        list what would close, write nothing (the default)
 *   --apply      close them
 *   --workspace  one workspace id; every workspace when left out
 *   --prod       read PROD_DATABASE_URL from scripts/.env.prod instead of DATABASE_URL
 */
/* eslint-disable no-console -- an operator script: the console is its output */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = args.includes('--dry');
const PROD = args.includes('--prod');
if (APPLY && DRY) {
  console.error('Pick one: --dry or --apply.');
  process.exit(2);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const workspaceArg = opt('--workspace');
const WORKSPACE_ID = workspaceArg ? Number(workspaceArg) : null;
if (workspaceArg && !(Number.isInteger(WORKSPACE_ID) && WORKSPACE_ID > 0)) {
  console.error(`--workspace must be a workspace id, got "${workspaceArg}"`);
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));

if (PROD) {
  const env = fs.readFileSync(path.join(here, '.env.prod'), 'utf8');
  const m = env.match(/^PROD_DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
  process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');
}
// One connection, on prod or inside the app's container alike: the database's
// connection budget is shared with the live app.
if (process.env.DATABASE_URL) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set('connection_limit', '1');
    process.env.DATABASE_URL = url.toString();
  } catch {
    console.error('DATABASE_URL is not a URL — stopping.');
    process.exit(2);
  }
}
/** The database host (and name) only — never the user or password. */
function dbTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL || '');
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || ''}`;
  } catch {
    return '(DATABASE_URL not set or not a URL)';
  }
}
// Dynamic imports AFTER the env is set: services/prisma.js reads DATABASE_URL at load.
const { default: prisma } = await import('../src/services/prisma.js');
const { closeApprovalsOnClosedTickets } = await import('../src/services/approvalTicketCloseService.js');

console.log(`TARGET: ${PROD ? 'PROD (scripts/.env.prod)' : 'DATABASE_URL'} ${dbTarget()} — ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${WORKSPACE_ID ? `workspace ${WORKSPACE_ID}` : 'every workspace'}`);

const result = await closeApprovalsOnClosedTickets({ workspaceId: WORKSPACE_ID, dryRun: !APPLY });
const rows = result.approvals || [];
if (rows.length === 0) {
  console.log('No open approvals on closed tickets. Nothing to do.');
} else {
  console.log(`\n${rows.length} open approval(s) on ${result.tickets} closed ticket(s):`);
  for (const a of rows) {
    const asked = a.requestedAt ? new Date(a.requestedAt).toISOString().slice(0, 10) : '?';
    const closedAt = a.ticketClosedAt ? new Date(a.ticketClosedAt).toISOString().slice(0, 10) : '?';
    const mark = APPLY ? (a.applied ? 'closed  ' : 'left    ') : 'would   ';
    console.log(`  ${mark} approval #${a.approvalId} (${a.status}, asked ${asked}) on ${a.ticketRef || `ticket ${a.ticketId}`} [ws ${a.workspaceId}] — ticket "${a.ticketStatus}" since ${closedAt} — approver ${a.approverEmail || '?'}`);
  }
  if (APPLY) {
    console.log(`\nAPPLIED: ${result.closed} approval(s) closed as not needed.`);
    const left = rows.filter((a) => !a.applied).length;
    if (left) console.log(`${left} left as they were (decided or reopened in the meantime).`);
  } else {
    console.log('\nDRY-RUN — nothing changed. Re-run with --apply.');
  }
}
// The Assetron release and the Teams card refresh are already finished here:
// closeApprovalsOnClosedTickets waits for both before it returns.
await prisma.$disconnect();
// The SSE / Teams modules the live path loads keep timers; end the run here.
process.exit(0);
