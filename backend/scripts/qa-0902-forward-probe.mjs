// Mega 09-01 Phase FW-6 / RL-3 dev E2E probe — fabricated Graph messages run
// through the REAL ingest pipeline (mapGraphMessageForIngest → ingestSingleMessage)
// against the DEV database and the dev mailbox connection row.
//
//   node --env-file=.env scripts/qa-0902-forward-probe.mjs            # dry-run: decisions only
//   node --env-file=.env scripts/qa-0902-forward-probe.mjs --apply    # creates tickets in DEV
//   options: --connection=<id> --agent=<email> --requester=<email>
//
// Scenarios: (A) Outlook OWA forward by an agent, (B) agent reply-all with the
// mailbox in Cc, (B2, --apply only) the requester's reply-all to B threading
// via rung 1, (C) external "Re:" to mail we never sent → hold queue.
// DEV ONLY — refuses any DATABASE_URL that does not look local.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prisma from '../src/services/prisma.js';
import mailboxIngestService from '../src/services/mailboxIngestService.js';
import agentIntake from '../src/services/agentIntakeService.js';
import { mapGraphMessageForIngest } from '../src/integrations/graphMailClient.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const APPLY = args.apply === true;
const dbUrl = String(process.env.DATABASE_URL || '');
if (!/localhost|127\.0\.0\.1|\bdev\b/i.test(dbUrl)) {
  console.error('Refusing: DATABASE_URL does not look like the dev database');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, '..', 'tests', 'fixtures', 'forwards', name), 'utf8');
const runId = Date.now().toString(36);
// One requester per scenario (suffix = run id) so rung 4 (sender+recency)
// cannot thread B/C onto A's ticket inside the same run; --requester=<email>
// forces a single address for all three (which DOES demonstrate rung 4).
const requesterFor = (key) => (args.requester ? String(args.requester) : `rita.requester+${key.toLowerCase()}-${runId}@customer.example`);
const REQUESTER = requesterFor('a');
const REQUESTER_B = requesterFor('b');
const REQUESTER_C = requesterFor('c');
const REQUESTER_NAME = 'Rita Requester';

const connection = args.connection
  ? await prisma.mailboxConnection.findUnique({ where: { id: Number(args.connection) } })
  : await prisma.mailboxConnection.findFirst({ where: { isEnabled: true, mode: { in: ['ingest', 'both'] } }, orderBy: { id: 'asc' } });
if (!connection) { console.error('No enabled ingest mailbox connection in dev'); process.exit(2); }

const agentRow = args.agent
  ? await prisma.technician.findFirst({ where: { workspaceId: connection.workspaceId, isActive: true, email: { equals: String(args.agent), mode: 'insensitive' } } })
  : await prisma.technician.findFirst({ where: { workspaceId: connection.workspaceId, isActive: true, email: { endsWith: '@bgcengineering.ca' } }, orderBy: { id: 'asc' } });
if (!agentRow) { console.error('No active technician found for the connection workspace'); process.exit(2); }
const AGENT = { name: agentRow.name, email: agentRow.email };

console.log(`Probe ${runId} — ${APPLY ? 'APPLY (writes to dev)' : 'DRY-RUN'}`);
console.log(`  mailbox: #${connection.id} ${connection.address} (ws ${connection.workspaceId}, policy ${agentIntake.newTicketPolicy(connection)}, agentCcIntake ${agentIntake.agentCcIntakeEnabled(connection)})`);
console.log(`  agent:   ${AGENT.name} <${AGENT.email}> (technician ${agentRow.id})`);
console.log(`  requesters: A=${REQUESTER} B=${REQUESTER_B} C=${REQUESTER_C}`);

const addr = (address, name = null) => ({ emailAddress: { address, ...(name ? { name } : {}) } });
const graphMessage = ({ id, subject, from, fromName, to = [], cc = [], html, headers = {} }) => ({
  id,
  subject,
  from: addr(from, fromName),
  toRecipients: to.map((t) => (typeof t === 'string' ? addr(t) : addr(t.address, t.name))),
  ccRecipients: cc.map((t) => (typeof t === 'string' ? addr(t) : addr(t.address, t.name))),
  receivedDateTime: new Date().toISOString(),
  bodyPreview: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 255),
  body: { contentType: 'html', content: html },
  conversationId: `conv-${id}`,
  internetMessageId: `<probe-${runId}-${id}@bgcengineering.ca>`,
  hasAttachments: false,
  internetMessageHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
});

const owaHtml = fixture('outlook-owa.html')
  .replace(/rita\.requester@customer\.example/g, REQUESTER)
  .replace(/Alex Agent &lt;alex\.agent@bgcengineering\.ca&gt;/g, `${AGENT.name} &lt;${AGENT.email}&gt;`)
  .replace(/Alex<\/div>/, `${AGENT.name.split(' ')[0]}</div>`);
const ccHtml = fixture('reply-not-forward.html')
  .replace('Thanks — attached is the remittance. Please let me know when it\'s applied.', 'Hi Rita — I\'m on it. I\'ve looped in the PA mailbox so this is tracked; you\'ll hear from us today.')
  .replace('Rita</div>', `${AGENT.name.split(' ')[0]}</div>`)
  .replace('Ticket Pulse &lt;patickets@bgcengineering.ca&gt;', `${REQUESTER_NAME} &lt;${REQUESTER_B}&gt;`)
  .replace('<b>To:</b> Rita Requester &lt;rita.requester@customer.example&gt;', `<b>To:</b> ${AGENT.name} &lt;${AGENT.email}&gt;`)
  .replace('Re: Invoice 4471 still unpaid [TP-1204]', 'Invoice 4471 still unpaid')
  .replace('Hi Rita, we are looking into invoice 4471 now and will confirm shortly.', 'Hi, invoice 4471 from July still shows unpaid on our side — can you check whether it went through AP?')
  .replace(/Alex<\/div>\s*<\/span>/, 'Rita</div></span>');

const scenarios = [
  {
    key: 'A', title: 'Outlook OWA forward by an agent (FW-2/FW-3)',
    expect: 'forward → ticket for the requester, sliced description, private agent note, forwarded_intake activity',
    message: graphMessage({
      id: 'fwd', subject: 'FW: Invoice 4471 still unpaid', from: AGENT.email, fromName: AGENT.name,
      to: [connection.address], html: owaHtml,
    }),
  },
  {
    key: 'B', title: 'Agent reply-all with the mailbox in Cc (RL-3 rule 2)',
    expect: 'agent_cc → ticket for the requester, agent text = public agent reply (deliveryState external), assigned, ack suppressed',
    message: graphMessage({
      id: 'agentcc', subject: 'RE: Invoice 4471 still unpaid', from: AGENT.email, fromName: AGENT.name,
      to: [{ address: REQUESTER_B, name: REQUESTER_NAME }], cc: [connection.address], html: ccHtml,
      headers: { 'In-Reply-To': `<never-seen-${runId}@customer.example>`, References: `<never-seen-${runId}@customer.example>` },
    }),
  },
  {
    key: 'C', title: 'External "Re:" to mail we never sent (RL-3 rule 3)',
    expect: 'external_reply_unknown → hold queue (or skip+remember while the hold service is not deployed; create only with policy=create)',
    message: graphMessage({
      id: 'extreply', subject: 'Re: quick question about my invoice', from: REQUESTER_C, fromName: REQUESTER_NAME,
      to: [connection.address], html: '<div>Any update on this? Thanks!</div><br><div>On Monday you wrote:</div><blockquote>We will look into it.</blockquote>',
      headers: { 'In-Reply-To': `<lost-${runId}@example.com>`, References: `<lost-${runId}@example.com>` },
    }),
  },
];

const results = [];
for (const s of scenarios) {
  const email = mapGraphMessageForIngest(s.message);
  console.log(`\n=== ${s.key}: ${s.title}`);
  console.log(`    expect: ${s.expect}`);
  console.log(`    mail:   "${email.subject}" from ${email.from} to [${email.to.join(', ')}] cc [${email.cc.join(', ')}] refs=${email.inReplyTo || '-'}`);

  const agent = await agentIntake.resolveAgentSender(connection.workspaceId, email.from);
  const ctx = agent ? await agentIntake.prepareAgentContext(connection, email, agent) : null;
  const match = await mailboxIngestService.matchEmailToTicket(connection.workspaceId, email, connection.address, {
    subject: ctx ? ctx.subjectForMatch : undefined, recencySender: ctx ? ctx.recencySender : email.from,
  });
  console.log(`    agent:  ${agent ? `${agent.name} (#${agent.id})` : 'no'}${ctx ? ` | parsed: isForward=${ctx.parsed.isForward} hasHeaderBlock=${ctx.parsed.hasHeaderBlock} client=${ctx.parsed.client} original=${ctx.parsed.original.email || '-'} recencySender=${ctx.recencySender || '(rung 4 skipped)'}` : ''}`);
  console.log(`    ladder: ${match?.ticket ? `matched ticket ${match.ticket.id} via ${match.via}` : match?.skip ? `skip (${match.reason})` : 'no match'}`);
  const intake = await agentIntake.classifyIntake(connection, email, { agent, ctx });
  console.log(`    decision: ${intake.kind} — rule ${intake.decision.rule}`);
  console.log(`    details:  ${JSON.stringify(intake.decision.details)}`);
  if (intake.kind === 'forward') console.log(`    requester → ${intake.original.email} (${intake.original.name}), original date ${intake.original.date?.toISOString?.() || intake.original.dateRaw}`);
  if (intake.kind === 'agent_cc') console.log(`    requester → ${intake.requester.email} (${intake.requester.name || '?'}), quoted original: ${intake.quotedOriginal ? 'yes' : 'no'}`);

  if (!APPLY) { results.push({ key: s.key, decision: intake.kind, rule: intake.decision.rule }); continue; }

  const outcome = await mailboxIngestService.ingestSingleMessage(connection, email, new Map());
  const entry = await prisma.ticketThreadEntry.findFirst({
    where: { workspaceId: connection.workspaceId, emailMessageId: email.internetMessageId },
    orderBy: { id: 'desc' },
    include: { ticket: { include: { requester: { select: { email: true, name: true } }, assignedTech: { select: { id: true, name: true } } } } },
  });
  const t = entry?.ticket;
  console.log(`    OUTCOME: ${outcome}${t ? ` → ticket ${t.id} (TP-${t.nativeNumber}) requester=${t.requester?.email} assignee=${t.assignedTech?.name || '-'} status=${t.status}` : ''}`);
  if (t) {
    const entries = await prisma.ticketThreadEntry.findMany({ where: { ticketId: t.id }, orderBy: { id: 'asc' }, select: { id: true, eventType: true, authorType: true, actorEmail: true, incoming: true, isPrivate: true, occurredAt: true, emailMessageId: true, rawPayload: true } });
    for (const e of entries) console.log(`      entry ${e.id}: ${e.eventType} by ${e.authorType}/${e.actorEmail} incoming=${e.incoming} private=${e.isPrivate} at ${e.occurredAt.toISOString()} mid=${e.emailMessageId || '-'} raw=${e.rawPayload ? Object.keys(e.rawPayload).join(',') : '-'}`);
    const acts = await prisma.ticketActivity.findMany({ where: { ticketId: t.id }, orderBy: { id: 'asc' }, select: { activityType: true, performedBy: true, details: true } });
    for (const a of acts) console.log(`      activity ${a.activityType} by ${a.performedBy}${a.details?.createdVia ? ` createdVia=${a.details.createdVia}` : ''}${a.details?.requesterEmailSuppressed ? ' ackSuppressed' : ''}`);
  }
  results.push({ key: s.key, decision: intake.kind, rule: intake.decision.rule, outcome, ticketId: t?.id ?? null, displayRef: t ? `TP-${t.nativeNumber}` : null });

  // B2: the requester's reply-all to the agent's mail must thread via rung 1.
  if (s.key === 'B' && t) {
    const replyAll = mapGraphMessageForIngest(graphMessage({
      id: 'replyall', subject: 'RE: Invoice 4471 still unpaid', from: REQUESTER_B, fromName: REQUESTER_NAME,
      to: [AGENT.email], cc: [connection.address],
      html: '<div>Thanks for the quick reply — here is the remittance number: RM-88213.</div>',
      headers: { 'In-Reply-To': email.internetMessageId, References: `<never-seen-${runId}@customer.example> ${email.internetMessageId}` },
    }));
    const o2 = await mailboxIngestService.ingestSingleMessage(connection, replyAll, new Map());
    const e2 = await prisma.ticketThreadEntry.findFirst({ where: { emailMessageId: replyAll.internetMessageId }, select: { id: true, ticketId: true, authorType: true, incoming: true } });
    console.log(`\n=== B2: requester reply-all (In-Reply-To = the agent mail) → OUTCOME: ${o2}${e2 ? ` → entry ${e2.id} on ticket ${e2.ticketId} (${e2.authorType}, incoming=${e2.incoming}) ${e2.ticketId === t.id ? 'SAME TICKET ✓' : 'DIFFERENT TICKET ✗'}` : ''}`);
    results.push({ key: 'B2', outcome: o2, ticketId: e2?.ticketId ?? null, sameTicket: e2?.ticketId === t.id });
  }
}

console.log('\nSummary:');
console.table(results);
await prisma.$disconnect();
setTimeout(() => process.exit(0), 250);
