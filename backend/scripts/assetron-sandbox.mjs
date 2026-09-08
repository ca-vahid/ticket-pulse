#!/usr/bin/env node
/**
 * Assetron integration sandbox (Sep 2026).
 *
 * Assetron's R7 asks for a non-production environment with a seeded ticket in
 * every approval state, plus a way to move a test ticket between states on
 * demand. We do not run a second App Service + database for one read-only
 * endpoint, so the sandbox is a dedicated WORKSPACE instead:
 *
 *   - isActive: false, so the sync scheduler, the assignment pipeline and
 *     sync-health all skip it (they enumerate active workspaces only). Nothing
 *     here is ever pushed to or pulled from FreshService.
 *   - Rows are written with Prisma directly, NOT through ticketService /
 *     ticketApprovalService — so no FS mirror, no workflow triggers, and above
 *     all no approval emails to the fixture managers.
 *   - Fixture people use @example.invalid, an address that can never resolve.
 *
 * Be honest with anyone's security review: this is the same host and the same
 * database as production, isolated by workspace — not a separate environment.
 *
 * Usage (dry-run unless --apply is passed):
 *   node scripts/assetron-sandbox.mjs                     # show the plan
 *   node scripts/assetron-sandbox.mjs --apply             # create/refresh it
 *   node scripts/assetron-sandbox.mjs --list              # current refs + states
 *   node scripts/assetron-sandbox.mjs --set TP-9001 REJECTED --apply
 *   node scripts/assetron-sandbox.mjs --destroy --apply   # remove it entirely
 *
 * Against production: DATABASE_URL="$PROD_DATABASE_URL" node scripts/assetron-sandbox.mjs
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has('--apply');
const valueAfter = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv.slice(i + 1).filter((a) => !a.startsWith('--')) : [];
};

const WORKSPACE = { name: 'Assetron Sandbox', slug: 'assetron-sandbox' };
const CATEGORY = 'New Computer Upgrade';
// Mirrors the real ws1 category: two managers, first decision wins.
const MANAGERS = [
  { email: 'sandbox.manager1@example.invalid', name: 'Sandbox Manager One' },
  { email: 'sandbox.manager2@example.invalid', name: 'Sandbox Manager Two' },
];
const REQUESTER = { name: 'Sandbox Requester', email: 'sandbox.requester@example.invalid' };

const DAY = 24 * 60 * 60 * 1000;

/**
 * One fixture per state the endpoint can return. `rows` describes the approval
 * rows to write; a null `rows` means no approval was ever requested.
 */
const FIXTURES = [
  {
    state: 'APPROVED',
    subject: 'New laptop for a new starter — approved',
    rows: [
      { manager: 0, status: 'approved', decidedAt: -2 * DAY, decidedVia: 'link' },
      { manager: 1, status: 'cancelled', decidedAt: -2 * DAY },
    ],
  },
  {
    state: 'PENDING',
    subject: 'New laptop for a new starter — awaiting a manager',
    rows: [
      { manager: 0, status: 'pending', expiresAt: +28 * DAY },
      { manager: 1, status: 'pending', expiresAt: +28 * DAY },
    ],
  },
  {
    state: 'REJECTED',
    subject: 'New laptop request — declined by the manager',
    rows: [
      { manager: 0, status: 'rejected', decidedAt: -1 * DAY, decidedVia: 'link' },
      { manager: 1, status: 'cancelled', decidedAt: -1 * DAY },
    ],
  },
  {
    state: 'CANCELLED',
    subject: 'New laptop request — withdrawn by the requester',
    rows: [
      { manager: 0, status: 'cancelled', decidedAt: -3 * DAY },
      { manager: 1, status: 'cancelled', decidedAt: -3 * DAY },
    ],
  },
  {
    state: 'INFO_REQUESTED',
    subject: 'New laptop request — approver asked a question',
    rows: [{ manager: 0, status: 'info_requested', expiresAt: +20 * DAY }],
  },
  {
    state: 'EXPIRED',
    subject: 'New laptop request — approval link lapsed',
    // Still pending in storage; the endpoint derives EXPIRED from expiresAt.
    rows: [{ manager: 0, status: 'pending', expiresAt: -5 * DAY }],
  },
  {
    state: 'NOT_REQUESTED',
    subject: 'New laptop request — no approval was ever requested',
    rows: null,
  },
];

// --set accepts these; EXPIRED/NOT_REQUESTED are shapes, not stored statuses.
const SETTABLE = new Set(['APPROVED', 'PENDING', 'REJECTED', 'CANCELLED', 'INFO_REQUESTED', 'EXPIRED']);

function log(...a) { console.log(...a); }
function plan(...a) { console.log(APPLY ? '  ✓' : '  would:', ...a); }

async function findWorkspace() {
  return prisma.workspace.findFirst({ where: { slug: WORKSPACE.slug } });
}

async function ensureWorkspace() {
  const existing = await findWorkspace();
  if (existing) { log(`Workspace: #${existing.id} "${existing.name}" (exists)`); return existing; }
  plan(`create workspace "${WORKSPACE.name}" (isActive: false — invisible to every scheduler)`);
  if (!APPLY) return null;
  // freshserviceWorkspaceId is required but never used: nothing syncs an
  // inactive workspace. 0 is reserved for "not a real FreshService workspace".
  return prisma.workspace.create({
    data: {
      name: WORKSPACE.name, slug: WORKSPACE.slug, freshserviceWorkspaceId: 0,
      isActive: false, nativeTicketingEnabled: true,
      internalDomains: ['bgcengineering.ca'],
    },
  });
}

async function ensureCategory(workspaceId) {
  const found = await prisma.approvalCategory.findFirst({ where: { workspaceId, name: CATEGORY } });
  if (found) { log(`Approval category: #${found.id} "${found.name}" (exists)`); return found; }
  plan(`create approval category "${CATEGORY}" with ${MANAGERS.length} fixture managers`);
  if (!APPLY) return null;
  return prisma.approvalCategory.create({
    data: { workspaceId, name: CATEGORY, description: 'Assetron sandbox fixture — mirrors the live IT category.', managerEmails: MANAGERS.map((m) => m.email), isActive: true },
  });
}

async function ensureRequester() {
  const found = await prisma.requester.findFirst({ where: { email: REQUESTER.email } });
  if (found) return found;
  plan(`create fixture requester ${REQUESTER.email}`);
  if (!APPLY) return null;
  return prisma.requester.create({ data: { name: REQUESTER.name, email: REQUESTER.email, isActive: true } });
}

async function nextNativeNumber() {
  const max = await prisma.ticket.aggregate({ _max: { nativeNumber: true } });
  // Sandbox numbering starts well clear of the live sequence so a ref is
  // recognisable on sight and can never collide with a real TP number.
  return Math.max(90001, (max._max.nativeNumber || 0) + 1);
}

async function seed() {
  const ws = await ensureWorkspace();
  if (!ws && !APPLY) { log('\n(dry run — later steps need the workspace to exist)'); return; }
  const category = await ensureCategory(ws.id);
  const requester = await ensureRequester();
  if (!APPLY) { FIXTURES.forEach((f) => plan(`create a ${f.state} ticket: "${f.subject}"`)); return; }

  let n = await nextNativeNumber();
  const created = [];
  for (const fixture of FIXTURES) {
    const existing = await prisma.ticket.findFirst({
      where: { workspaceId: ws.id, subject: fixture.subject },
      select: { id: true, nativeNumber: true },
    });
    let ticket = existing;
    if (!ticket) {
      ticket = await prisma.ticket.create({
        data: {
          workspaceId: ws.id, origin: 'ticketpulse', nativeNumber: n++,
          subject: fixture.subject,
          description: `<p>Assetron sandbox fixture. This ticket exists so the approval endpoint can be exercised in the <strong>${fixture.state}</strong> state.</p>`,
          descriptionText: `Assetron sandbox fixture — ${fixture.state}.`,
          status: 'Open', priority: 2, ticketType: 'Service Request',
          requesterId: requester.id,
          createdAt: new Date(Date.now() - 7 * DAY),
        },
        select: { id: true, nativeNumber: true },
      });
    }
    await writeApprovals(ws.id, ticket.id, category.id, fixture.rows);
    created.push({ ref: `TP-${ticket.nativeNumber}`, id: ticket.id, state: fixture.state });
  }
  log('\nSeeded fixtures:');
  for (const c of created) log(`  ${c.ref.padEnd(10)} ${c.state.padEnd(16)} (internal id ${c.id})`);
  log(`\nWorkspace id ${ws.id} — issue the OAuth client against this id.`);
}

/** Replace a ticket's approval rows with the fixture shape. */
async function writeApprovals(workspaceId, ticketId, approvalCategoryId, rows) {
  await prisma.ticketApproval.deleteMany({ where: { ticketId, workspaceId } });
  if (!rows) return;
  const requestGroupId = crypto.randomUUID();
  for (const r of rows) {
    const m = MANAGERS[r.manager];
    await prisma.ticketApproval.create({
      data: {
        workspaceId, ticketId, approvalCategoryId, requestGroupId,
        status: r.status,
        approverEmail: m.email, approverName: m.name,
        requestedBy: REQUESTER.email,
        requestNote: 'Assetron sandbox fixture.',
        decisionNote: r.status === 'rejected' ? 'Not budgeted this quarter.'
          : r.status === 'info_requested' ? 'Which model is being requested?' : null,
        decidedAt: r.decidedAt ? new Date(Date.now() + r.decidedAt) : null,
        decidedVia: r.decidedVia || null,
        expiresAt: r.expiresAt ? new Date(Date.now() + r.expiresAt) : null,
        // Never a usable token: these rows must not be decidable from a link.
        tokenHash: `sandbox-${crypto.randomUUID()}`.slice(0, 64),
      },
    });
  }
}

async function list() {
  const ws = await findWorkspace();
  if (!ws) { log('No sandbox workspace yet — run with --apply to create it.'); return; }
  const tickets = await prisma.ticket.findMany({
    where: { workspaceId: ws.id },
    select: { id: true, nativeNumber: true, subject: true, approvals: { select: { status: true, expiresAt: true } } },
    orderBy: { nativeNumber: 'asc' },
  });
  log(`Workspace #${ws.id} "${ws.name}" — ${tickets.length} fixture ticket(s):\n`);
  for (const t of tickets) {
    const states = t.approvals.map((a) => (a.status === 'pending' && a.expiresAt && a.expiresAt < new Date() ? 'pending(expired)' : a.status));
    log(`  TP-${t.nativeNumber}  ${(states.join(', ') || 'no approvals').padEnd(28)} ${t.subject}`);
  }
}

async function setState(ref, state) {
  const upper = String(state || '').toUpperCase();
  if (!SETTABLE.has(upper)) {
    log(`State must be one of: ${[...SETTABLE].join(', ')} (NOT_REQUESTED: delete the rows instead).`);
    process.exitCode = 1; return;
  }
  const ws = await findWorkspace();
  if (!ws) { log('No sandbox workspace.'); process.exitCode = 1; return; }
  const num = Number(String(ref).replace(/^tp-?/i, ''));
  const ticket = await prisma.ticket.findFirst({ where: { workspaceId: ws.id, nativeNumber: num }, select: { id: true } });
  if (!ticket) { log(`${ref} is not a sandbox ticket.`); process.exitCode = 1; return; }
  const category = await prisma.approvalCategory.findFirst({ where: { workspaceId: ws.id, name: CATEGORY }, select: { id: true } });

  const shape = {
    APPROVED: [{ manager: 0, status: 'approved', decidedAt: -60 * 1000, decidedVia: 'link' }, { manager: 1, status: 'cancelled', decidedAt: -60 * 1000 }],
    PENDING: [{ manager: 0, status: 'pending', expiresAt: +30 * DAY }, { manager: 1, status: 'pending', expiresAt: +30 * DAY }],
    REJECTED: [{ manager: 0, status: 'rejected', decidedAt: -60 * 1000, decidedVia: 'link' }, { manager: 1, status: 'cancelled', decidedAt: -60 * 1000 }],
    CANCELLED: [{ manager: 0, status: 'cancelled', decidedAt: -60 * 1000 }],
    INFO_REQUESTED: [{ manager: 0, status: 'info_requested', expiresAt: +20 * DAY }],
    EXPIRED: [{ manager: 0, status: 'pending', expiresAt: -1 * DAY }],
  }[upper];

  plan(`set ${ref} to ${upper}`);
  if (!APPLY) return;
  await writeApprovals(ws.id, ticket.id, category.id, shape);
  log(`${ref} is now ${upper}.`);
}

async function destroy() {
  const ws = await findWorkspace();
  if (!ws) { log('Nothing to remove.'); return; }
  const tickets = await prisma.ticket.count({ where: { workspaceId: ws.id } });
  plan(`delete workspace #${ws.id} and its ${tickets} fixture ticket(s)`);
  if (!APPLY) return;
  await prisma.ticketApproval.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.ticket.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.approvalCategory.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.oAuthClient.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.apiKey.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.workspace.delete({ where: { id: ws.id } });
  log('Sandbox removed.');
}

const [setRef, setVal] = valueAfter('--set');

try {
  if (!APPLY) log('DRY RUN — pass --apply to write.\n');
  if (has('--destroy')) await destroy();
  else if (has('--list')) await list();
  else if (setRef) await setState(setRef, setVal);
  else await seed();
} finally {
  await prisma.$disconnect();
}
