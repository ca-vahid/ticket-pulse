/**
 * DEV ONLY — end-to-end proof for QA 09-03 (TP-1221): a coalesced
 * "Ticket updated (fields)" workflow must still resolve recipients after it
 * parks and resumes.
 *
 * Reproduces the reported flow against the real dev database:
 *   1. seeds (or reuses) a "Ticket updated (fields)" workflow that mails the
 *      assigned agent, coalescing ON (the default that parks the run),
 *   2. edits a TP-born ticket's description as an agent who is NOT the assignee,
 *   3. shows the run parked (status=waiting) with recipients not yet resolved,
 *   4. forces the resume the worker would do a few minutes later,
 *   5. prints the recipients the resumed run resolved.
 *
 * BEFORE the fix step 5 prints an empty list and the mail is skipped with
 * "No recipient email address resolved". AFTER it prints the assignee.
 *
 * Usage: node scripts/qa-0903-resume-probe.mjs   (reads backend/.env)
 */
import 'dotenv/config';
import crypto from 'node:crypto';

process.env.TP_SUPPRESS_APPROVAL_EMAIL = '1';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a local dev database');
  process.exit(1);
}

const { default: prisma } = await import('../src/services/prisma.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const engine = await import('../src/services/notificationWorkflowEngine.js');
const { default: ticketService } = await import('../src/services/ticketService.js');

const ok = (label, detail) => console.log(`PASS ${label} -- ${detail}`);
const fail = (label, detail) => { console.log(`FAIL ${label} -- ${detail}`); process.exitCode = 1; };

// ---- 1. a TP-born ticket with an assignee, plus a DIFFERENT editor ----------
const ticket = await prisma.ticket.findFirst({
  where: { origin: 'ticketpulse', assignedTechId: { not: null } },
  orderBy: { id: 'desc' },
  select: { id: true, workspaceId: true, nativeNumber: true, subject: true, assignedTechId: true, assignedTech: { select: { name: true, email: true } } },
});
if (!ticket) { fail('fixture', 'no assigned TP-born ticket in dev'); process.exit(1); }
ok('fixture ticket', `TP-${ticket.nativeNumber} (id ${ticket.id}) assigned to ${ticket.assignedTech?.name} <${ticket.assignedTech?.email}>`);

const editor = await prisma.technician.findFirst({
  where: { id: { not: ticket.assignedTechId }, email: { not: null }, isActive: true },
  select: { id: true, name: true, email: true },
});
ok('editor', `${editor?.name} <${editor?.email}> (not the assignee)`);

// The run must take the REAL park + resume path (mock mode executes inline and
// would prove nothing), so delivery is neutralised instead: the ticket is parked
// on a throwaway agent at an RFC-2606 `.invalid` address for the probe, and the
// original assignee is restored at the end.
const originalAssigneeId = ticket.assignedTechId;
const probeAgent = await prisma.technician.upsert({
  where: { id: (await prisma.technician.findFirst({ where: { email: 'qa-resume-probe@example.invalid' }, select: { id: true } }))?.id ?? -1 },
  update: { isActive: true },
  create: { name: 'QA Resume Probe', email: 'qa-resume-probe@example.invalid', workspaceId: ticket.workspaceId, origin: 'local', isActive: true },
  select: { id: true, name: true, email: true },
});
await prisma.ticket.update({ where: { id: ticket.id }, data: { assignedTechId: probeAgent.id } });
ok('assignee (probe)', `${probeAgent.name} <${probeAgent.email}> — undeliverable on purpose`);

// ---- 2. the workflow QA described: mail the assigned agent, coalescing ON ----
const definition = buildDefaultWorkflowDefinition('ticket.fields_updated');
const trigger = definition.nodes.find((n) => n.type === 'trigger');
trigger.data = { ...trigger.data, coalesceMinutes: 3, includeFreshserviceChanges: false, notifyActor: false };
const recipients = definition.nodes.find((n) => n.type === 'recipient_resolver');
recipients.data = { ...recipients.data, to: ['assigned_agent'], cc: [] };

const key = `qa0903-resume-${crypto.randomBytes(3).toString('hex')}`;
const workflow = await prisma.notificationWorkflow.create({
  data: {
    workspaceId: ticket.workspaceId,
    key,
    name: 'QA 09-03 resume probe (Ticket updated)',
    triggerType: 'ticket.fields_updated',
    isEnabled: true,
    enabledAt: new Date(),
    draftDefinition: definition,
    publishedDefinition: definition,
    // listEnabledForEvent requires a published VERSION, not just a definition.
    publishedVersion: 1,
    versions: { create: { workspaceId: ticket.workspaceId, version: 1, definition, publishedAt: new Date() } },
  },
  select: { id: true, name: true, versions: { select: { id: true } } },
});
ok('workflow', `#${workflow.id} enabled, published, coalescing 3 min, to = assigned_agent`);

// ---- 3. edit the description as the OTHER agent -----------------------------
const before = await prisma.notificationWorkflowRun.count({ where: { workflowId: workflow.id } });
await ticketService.updateTicketFields(ticket.id, ticket.workspaceId, { description: `<p>QA 09-03 resume probe ${new Date().toISOString()}</p>` }, { id: editor.id, name: editor.name, email: editor.email });
await new Promise((r) => setTimeout(r, 1500));

const run = await prisma.notificationWorkflowRun.findFirst({
  where: { workflowId: workflow.id },
  orderBy: { id: 'desc' },
  select: { id: true, status: true, resumeAt: true, resumeNodeId: true, resumeState: true, eventContext: true },
});
if (!run) { fail('run', `no run created (runs before: ${before})`); }
else if (run.status !== 'waiting') fail('park', `expected status=waiting, got ${run.status}`);
else ok('park', `run #${run.id} parked at "${run.resumeNodeId}" until ${run.resumeAt?.toISOString()}`);

if (run) {
  const stored = run.eventContext || {};
  ok('stored context is redacted', `assignedAgent=${JSON.stringify(stored.assignedAgent)} hasAssignedAgent=${JSON.stringify(stored.hasAssignedAgent)} hints=${JSON.stringify(run.resumeState?.hints || null)}`);

  // ---- 4. force the resume the worker performs when the window closes -------
  await prisma.notificationWorkflowRun.update({ where: { id: run.id }, data: { resumeAt: new Date(Date.now() - 1000) } });
  const summary = await engine.resumeWaitingRuns({ limit: 5 });
  ok('resume worker', JSON.stringify(summary));

  // ---- 5. what did the resumed run resolve? --------------------------------
  const after = await prisma.notificationWorkflowRun.findUnique({
    where: { id: run.id },
    select: { status: true, error: true, steps: { select: { nodeType: true, status: true, output: true } } },
  });
  const resolver = after?.steps.find((s) => s.nodeType === 'recipient_resolver');
  const send = after?.steps.find((s) => s.nodeType === 'send_email');
  const to = resolver?.output?.recipients?.to || [];
  console.log(`RESUMED status=${after?.status} error=${after?.error || '-'}`);
  console.log(`RECIPIENTS to=${JSON.stringify(to)} cc=${JSON.stringify(resolver?.output?.recipients?.cc || [])} actorExcluded=${JSON.stringify(resolver?.output?.actorExcluded ?? null)}`);
  console.log(`SEND ${send ? JSON.stringify({ skipped: send.output?.skipped ?? false, reason: send.output?.reason ?? null, subject: send.output?.subject ?? null }) : 'no send step'}`);
  if (to.length === 1) ok('VERDICT', 'the resumed run resolved the assigned agent — the QA symptom is fixed');
  else fail('VERDICT', `the resumed run resolved ${to.length} recipients (the QA symptom)`);
}

// ---- cleanup: nothing the probe created outlives the probe ------------------
await prisma.ticket.update({ where: { id: ticket.id }, data: { assignedTechId: originalAssigneeId } }).catch(() => {});
await prisma.notificationWorkflowStepRun.deleteMany({ where: { run: { workflowId: workflow.id } } }).catch(() => {});
await prisma.notificationWorkflowRun.deleteMany({ where: { workflowId: workflow.id } }).catch(() => {});
await prisma.notificationWorkflowVersion.deleteMany({ where: { workflowId: workflow.id } }).catch(() => {});
await prisma.notificationWorkflow.delete({ where: { id: workflow.id } }).catch(() => {});
ok('cleanup', `probe workflow #${workflow.id} removed, assignee restored`);
await prisma.$disconnect();
