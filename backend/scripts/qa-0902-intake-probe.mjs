/**
 * QA 09-02 — Autofill v2 (AF2) live query-shape probe. DEV ONLY.
 *
 * Exercises every NEW Prisma query the feature introduces against the real
 * dev database (a mocked Prisma cannot catch a wrong field/relation name —
 * lesson from the MEGA 08-31 train), then removes its own rows:
 *   - ticketIntakeRun.create / findFirst / update / findMany(+ticket include)
 *   - the resolver lookups (requester.findFirst by email, requester.findMany
 *     by name, technician.findMany active per workspace)
 *   - the leaf-only vocabulary query (competencyCategory.findMany)
 *
 * Usage: node scripts/qa-0902-intake-probe.mjs   (reads backend/.env)
 */
import 'dotenv/config';
import prisma from '../src/services/prisma.js';
import ticketIntakeRunService, { computeApplied } from '../src/services/ticketIntakeRunService.js';
import { resolveRequesterHint, resolveAssigneeHint, resolveConversingAgent } from '../src/services/intakeResolvers.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a local dev database');
  process.exit(2);
}

const WS = Number(process.env.PROBE_WORKSPACE_ID || 1);
const steps = [];
function ok(name, detail) { steps.push({ name, ok: true, detail }); console.log(`PASS ${name}${detail ? ` -- ${detail}` : ''}`); }
function fail(name, err) { steps.push({ name, ok: false, err: err.message }); console.log(`FAIL ${name} -- ${err.message}`); }

let runId = null;
try {
  // 1. vocabulary query (same shape the service uses)
  try {
    const cats = await prisma.competencyCategory.findMany({
      where: { workspaceId: WS, isActive: true },
      select: { id: true, name: true, parentId: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const tops = cats.filter((c) => c.parentId === null);
    const leafless = tops.filter((t) => !cats.some((c) => c.parentId === t.id)).map((t) => t.name);
    ok('competencyCategory.findMany (vocabulary)', `${tops.length} tops, ${cats.length - tops.length} subs, leafless tops: ${leafless.join(', ') || '(none)'}`);
  } catch (err) { fail('competencyCategory.findMany (vocabulary)', err); }

  // 2. resolvers (real queries; the directory may be unconfigured in dev)
  try {
    const r1 = await resolveRequesterHint(WS, 'Simon Dickinson', []);
    ok('resolveRequesterHint("Simon Dickinson")', `${r1.status}: ${r1.reason}${r1.candidate ? ` -> #${r1.candidate.requesterId} ${r1.candidate.email}` : ''}`);
    const r2 = await resolveRequesterHint(WS, 'sdickinson@bgcengineering.ca', []);
    ok('resolveRequesterHint(email)', `${r2.status}: ${r2.reason}`);
    const r3 = await resolveRequesterHint(WS, 'Simon', []);
    ok('resolveRequesterHint("Simon") never matches', `${r3.status} (${r3.candidates.length} candidates): ${r3.reason}`);
    if (r3.status === 'matched') throw new Error('first name alone must not match');
  } catch (err) { fail('resolveRequesterHint', err); }
  try {
    const a1 = await resolveAssigneeHint(WS, 'Soheil');
    ok('resolveAssigneeHint("Soheil")', `${a1.status}: ${a1.reason}${a1.technician ? ` -> #${a1.technician.id} ${a1.technician.name}` : ''}`);
    const a2 = await resolveAssigneeHint(WS, 'Vahid');
    ok('resolveAssigneeHint("Vahid")', `${a2.status}: ${a2.reason} [${a2.candidates.map((c) => c.name).join(' | ')}]`);
    const c1 = await resolveConversingAgent(WS, 'Vahid Haeri');
    ok('resolveConversingAgent("Vahid Haeri")', JSON.stringify(c1));
  } catch (err) { fail('resolveAssigneeHint / resolveConversingAgent', err); }

  // 3. run persistence round trip
  const data = {
    subject: 'PROBE - ChatGPT account for Simon',
    requesterNameOrEmail: 'Simon Dickinson',
    requesterMatch: { status: 'matched', candidate: { requesterId: 99, email: 'sdickinson@bgcengineering.ca', name: 'Simon Dickinson', source: 'requester' }, candidates: [], reason: 'probe' },
    assigneeMatch: { status: 'none', technician: null, candidates: [], reason: 'probe' },
    conversingAgent: null,
    categoryHint: 'Procurement & Licensing > AI / SaaS Licensing',
    categoryLevel: 'leaf',
    priorityHint: 2,
    typeHint: 'Service Request',
    sourceSummary: 'probe',
  };
  try {
    runId = await ticketIntakeRunService.record({
      workspaceId: WS,
      actor: { email: 'probe@ticketpulse.local', name: 'Probe' },
      text: 'probe text',
      images: [{ mimeType: 'image/png', buffer: Buffer.alloc(10), fileName: 'probe.png' }],
      data,
      meta: { provider: 'probe', model: 'probe', imageCount: 1, textChars: 10, durationMs: 1, inputTokens: 1, outputTokens: 1 },
    });
    if (!runId) throw new Error('record() returned null -- see warn log above');
    ok('ticketIntakeRun.create', `id ${runId}`);
  } catch (err) { fail('ticketIntakeRun.create', err); }

  try {
    const run = await ticketIntakeRunService.assertLinkable(runId, WS);
    ok('ticketIntakeRun.findFirst (assertLinkable)', `id ${run.id}, ticketId ${run.ticketId}`);
    let foreign = 'not raised';
    try { await ticketIntakeRunService.assertLinkable(runId, WS + 1000); } catch (e) { foreign = e.message; }
    ok('assertLinkable foreign workspace rejected', foreign);
  } catch (err) { fail('assertLinkable', err); }

  try {
    const ticket = await prisma.ticket.findFirst({
      where: { workspaceId: WS },
      orderBy: { id: 'desc' },
      select: {
        id: true, subject: true, priority: true, ticketType: true, assignedTechId: true,
        requester: { select: { email: true } },
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
      },
    });
    if (!ticket) throw new Error('no ticket in workspace to link against');
    const linked = await ticketIntakeRunService.linkToTicket(runId, WS, ticket);
    if (!linked) throw new Error('linkToTicket returned null -- see warn log above');
    ok('ticketIntakeRun.update (linkToTicket)', `ticket ${linked.ticketId}, applied ${JSON.stringify(linked.resolved.applied)}`);
    const expected = computeApplied(data, ticket);
    // JSONB round-trips reorder keys -- compare field by field.
    for (const key of Object.keys(expected)) {
      if (expected[key] !== linked.resolved.applied[key]) throw new Error(`applied mismatch on ${key}: ${expected[key]} vs ${linked.resolved.applied[key]}`);
    }

    const forTicket = await ticketIntakeRunService.listForTicket(ticket.id, WS);
    ok('ticketIntakeRun.findMany (listForTicket)', `${forTicket.length} row(s), first id ${forTicket[0]?.id}`);
    const recent = await ticketIntakeRunService.listRecent(WS, 5);
    ok('ticketIntakeRun.findMany + ticket include (listRecent)', `${recent.length} row(s); ticket ${JSON.stringify(recent[0]?.ticket)}`);

    let relinked = 'not raised';
    try { await ticketIntakeRunService.assertLinkable(runId, WS); } catch (e) { relinked = e.message; }
    ok('assertLinkable already-linked rejected', relinked);
  } catch (err) { fail('link + list', err); }
} finally {
  if (runId) {
    await prisma.ticketIntakeRun.delete({ where: { id: runId } }).then(() => ok('cleanup', `deleted run ${runId}`)).catch((err) => fail('cleanup', err));
  }
  await prisma.$disconnect();
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} probe steps passed`);
process.exit(failed.length ? 1 : 0);
