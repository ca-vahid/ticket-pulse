import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const prismaMock = {
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn() },
  notificationDelivery: { findFirst: jest.fn() },
};
const holdMock = { isKnownMessageId: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/mailboxHoldService.js', () => ({ default: holdMock }), { virtual: true });
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  default: agentIntake, resolveAgentSender, looksLikeReply, classifyIntake, recipientRoles, isKnownReference,
  isMailboxAddress, newTicketPolicy, agentCcIntakeEnabled, prepareAgentContext,
} = await import('../src/services/agentIntakeService.js');

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'forwards');
const fixture = (name) => readFileSync(path.join(fixturesDir, name), 'utf8');

const connection = { id: 5, workspaceId: 5, address: 'patickets@bgcengineering.ca' };
const AGENT = { id: 7, name: 'Alex Agent', email: 'alex.agent@bgcengineering.ca' };
const RITA = 'rita.requester@customer.example';
const MAILBOX = 'patickets@bgcengineering.ca';

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
  holdMock.isKnownMessageId.mockResolvedValue(false);
});

describe('resolveAgentSender', () => {
  test('active technician by email, case-insensitive, lowercased on return; lookup failure → null', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 7, name: 'Alex Agent', email: 'Alex.Agent@BGCengineering.ca' });
    expect(await resolveAgentSender(5, 'ALEX.AGENT@bgcengineering.ca')).toEqual(AGENT);
    expect(prismaMock.technician.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 5, isActive: true, email: { equals: 'alex.agent@bgcengineering.ca', mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
    expect(await resolveAgentSender(5, 'Alex <alex.agent@bgcengineering.ca>')).toEqual(AGENT);
    expect(await resolveAgentSender(5, '')).toBeNull();
    expect(await resolveAgentSender(5, 'not-an-address')).toBeNull();
    prismaMock.technician.findFirst.mockRejectedValue(new Error('db down'));
    expect(await resolveAgentSender(5, 'x@y.example')).toBeNull();
  });
});

describe('looksLikeReply (rung 0 classifier)', () => {
  test('threading headers, subject prefixes (incl. AW/SV/Antw/WG/TR), body tokens, TP footer', () => {
    expect(looksLikeReply({ inReplyTo: '<a@x>' })).toEqual(expect.objectContaining({ isReply: true, evidence: ['threading_headers'] }));
    expect(looksLikeReply({ references: '<a@x> <b@x>' }).evidence).toEqual(['threading_headers']);
    for (const s of ['Re: x', 'RE: x', 'AW: x', 'SV: x', 'Antw: x', 'FW: x', 'Fwd: x', 'WG: x', 'TR: x', '[EXT] Re: x']) {
      expect(looksLikeReply({ subject: s }).evidence).toEqual(['subject_prefix']);
    }
    expect(looksLikeReply({ subject: 'Report: weekly' }).isReply).toBe(false);
    expect(looksLikeReply({ subject: 'x', bodyText: 'hi\n\nyour ticket [TP-1204] was updated' }).evidence).toEqual(['body_tp_token']);
    expect(looksLikeReply({ subject: 'x', bodyHtml: '<p>Ticket received: #240116</p>' }).evidence).toEqual(['body_ack_subject']);
    expect(looksLikeReply({ subject: 'x', bodyText: 'ok\n\nSent by Ticket Pulse — you can review the full task list' }).evidence).toEqual(['body_tp_footer']);
    expect(looksLikeReply({ subject: 'x', bodyText: 'nothing here' })).toEqual({ isReply: false, evidence: [], strongEvidence: [], subjectPrefixKind: null, bodyRefs: { tp: [], fs: [] } });
  });

  test('scans the first ~2 KB of the body for TP-<n> / #<n> candidate refs', () => {
    const r = looksLikeReply({ subject: 'x', bodyText: 'see TP-1204 and TP-1204 again, also #240116 and item #12 and PO-4471' });
    expect(r.bodyRefs).toEqual({ tp: [1204], fs: [240116] });
    const far = `${'x'.repeat(2100)} TP-9999`;
    expect(looksLikeReply({ subject: 'x', bodyText: far }).bodyRefs.tp).toEqual([]);
    // HTML bodies are flattened first (bodyText is null for Outlook mail); 2-digit refs are not tickets.
    expect(looksLikeReply({ subject: 'x', bodyHtml: '<div>Re <b>TP-77</b></div>' }).bodyRefs.tp).toEqual([]);
    expect(looksLikeReply({ subject: 'x', bodyHtml: '<div>Re <b>TP-771</b></div>' }).bodyRefs.tp).toEqual([771]);
    // A forward prefix alone is weak evidence; a reply prefix is strong.
    expect(looksLikeReply({ subject: 'FW: vendor invoice' })).toEqual(expect.objectContaining({ isReply: true, strongEvidence: [], subjectPrefixKind: 'forward' }));
    expect(looksLikeReply({ subject: 'Re: vendor invoice' })).toEqual(expect.objectContaining({ strongEvidence: ['subject_prefix'], subjectPrefixKind: 'reply' }));
  });
});

describe('recipient roles', () => {
  test('mailbox (+tag variants) / agents / loop senders / the sender are never externals', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'Bob.Middle@bgcengineering.ca' }]);
    const roles = await recipientRoles(connection, {
      from: AGENT.email,
      to: ['Rita <rita.requester@customer.example>', 'bob.middle@bgcengineering.ca', 'no-reply@vendor.example'],
      cc: ['patickets+tp12@bgcengineering.ca', AGENT.email, 'boss@customer.example'],
    });
    expect(roles).toEqual(expect.objectContaining({
      mailboxInTo: false, mailboxInCc: true, mailboxPresent: true, mailboxSoleTo: false,
      externals: [RITA, 'boss@customer.example'],
      agentRecipients: ['bob.middle@bgcengineering.ca'],
    }));
    expect(isMailboxAddress('PATickets+tp5@bgcengineering.ca', MAILBOX)).toBe(true);
    expect(isMailboxAddress('other+tp5@bgcengineering.ca', MAILBOX)).toBe(false);
    const sole = await recipientRoles(connection, { from: AGENT.email, to: [MAILBOX], cc: [] });
    expect(sole.mailboxSoleTo).toBe(true);
    expect(sole.externals).toEqual([]);
  });

  test('policy + switch defaults work before the RL-4 migration lands', () => {
    expect(newTicketPolicy({})).toBe('hold_unmatched');
    expect(newTicketPolicy({ newTicketPolicy: 'create' })).toBe('create');
    expect(newTicketPolicy({ newTicketPolicy: 'bogus' })).toBe('hold_unmatched');
    expect(agentCcIntakeEnabled({})).toBe(true);
    expect(agentCcIntakeEnabled({ agentCcIntake: false })).toBe(false);
  });
});

describe('isKnownReference', () => {
  test('the hold service lookup (a superset) answers alone when deployed; bare ids included', async () => {
    expect(await isKnownReference(5, [])).toEqual({ known: false, via: null });
    holdMock.isKnownMessageId.mockResolvedValueOnce(true);
    expect(await isKnownReference(5, ['<a@x>'])).toEqual({ known: true, via: 'hold_service' });
    expect(holdMock.isKnownMessageId).toHaveBeenCalledWith(5, ['<a@x>', 'a@x']);
    expect(prismaMock.ticketThreadEntry.findFirst).not.toHaveBeenCalled();
    expect(await isKnownReference(5, ['<a@x>'])).toEqual({ known: false, via: null });
  });

  test('without the hold service: thread entries → deliveries (provider_message_id, then message_id); bare ids included', async () => {
    holdMock.isKnownMessageId = undefined; // simulate a build without RL-4
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce({ id: 1 });
    expect(await isKnownReference(5, ['<a@x>'])).toEqual({ known: true, via: 'thread_entry' });
    expect(prismaMock.ticketThreadEntry.findFirst).toHaveBeenCalledWith({ where: { workspaceId: 5, emailMessageId: { in: ['<a@x>', 'a@x'] } }, select: { id: true } });

    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce({ id: 2 });
    expect(await isKnownReference(5, ['<a@x>'])).toEqual({ known: true, via: 'notification_delivery' });

    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 3 });
    expect(await isKnownReference(5, ['<a@x>'])).toEqual({ known: true, via: 'notification_delivery_message_id' });

    // message_id column missing → the second query throws → unknown.
    prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Unknown arg messageId'));
    expect(await isKnownReference(5, ['<a@x>'])).toEqual({ known: false, via: null });
    holdMock.isKnownMessageId = jest.fn().mockResolvedValue(false);
  });
});

describe('classifyIntake — the RL-3 decision table', () => {
  const asAgent = () => prismaMock.technician.findFirst.mockResolvedValue(AGENT);
  const owaForward = (extra = {}) => ({
    subject: 'FW: Invoice 4471 still unpaid', from: AGENT.email, to: [MAILBOX], cc: [], bodyHtml: fixture('outlook-owa.html'), ...extra,
  });
  const ccReply = (extra = {}) => ({
    subject: 'RE: Invoice 4471 still unpaid', from: AGENT.email, to: [RITA], cc: [MAILBOX],
    bodyHtml: '<div>I am on it, Rita.</div>', inReplyTo: '<never-seen@customer.example>', references: '<never-seen@customer.example>', ...extra,
  });

  test('rule FW: agent + parsed forward → forward with the quoted original', async () => {
    asAgent();
    const r = await classifyIntake(connection, owaForward());
    expect(r.kind).toBe('forward');
    expect(r.original.email).toBe(RITA);
    expect(r.decision).toEqual({ rule: 'agent_forward', details: expect.objectContaining({ agentId: 7, originalFrom: RITA, sliced: true, client: 'outlook_owa', policy: 'hold_unmatched' }) });
  });

  test('rule FW fallback: forward-shaped but unattributable → fresh + agent_forward_unparsed (reason)', async () => {
    asAgent();
    expect((await classifyIntake(connection, owaForward({ bodyHtml: '<p>see below</p>' }))).decision).toEqual(expect.objectContaining({ rule: 'agent_forward_unparsed', details: expect.objectContaining({ reason: 'no_header_block' }) }));
    const selfQuoted = fixture('outlook-owa.html').replace(/Rita Requester &lt;rita\.requester@customer\.example&gt;/, `Alex &lt;${AGENT.email}&gt;`);
    expect((await classifyIntake(connection, owaForward({ bodyHtml: selfQuoted }))).decision.details.reason).toBe('original_is_agent');
    const mailboxQuoted = fixture('outlook-owa.html').replace(/Rita Requester &lt;rita\.requester@customer\.example&gt;/, `Ticket Pulse &lt;${MAILBOX}&gt;`);
    expect((await classifyIntake(connection, owaForward({ bodyHtml: mailboxQuoted }))).decision.details.reason).toBe('original_is_mailbox');
    const loopQuoted = fixture('outlook-owa.html').replace(/rita\.requester@customer\.example/, 'no-reply@vendor.example');
    expect((await classifyIntake(connection, owaForward({ bodyHtml: loopQuoted }))).decision.details.reason).toBe('original_invalid');
  });

  test('rule 2: agent From + external To + mailbox Cc + unknown refs → agent_cc (requester = external, quoted From preferred)', async () => {
    asAgent();
    const r = await classifyIntake(connection, ccReply());
    expect(r.kind).toBe('agent_cc');
    expect(r.requester).toEqual({ email: RITA, name: null });
    expect(r.quotedOriginal).toBeNull();
    expect(r.decision).toEqual({ rule: 'agent_cc_intake', details: expect.objectContaining({ requester: RITA, viaQuotedFrom: false, mailboxInCc: true, externals: [RITA], evidence: ['threading_headers', 'subject_prefix'] }) });

    // Quoted header block naming one of two externals → that one wins, with their name + the sliced original.
    const quoted = fixture('reply-not-forward.html').replace('Ticket Pulse &lt;patickets@bgcengineering.ca&gt;', 'Boss Person &lt;boss@customer.example&gt;');
    const r2 = await classifyIntake(connection, ccReply({ to: [RITA, 'boss@customer.example'], bodyHtml: quoted }));
    expect(r2.kind).toBe('agent_cc');
    expect(r2.requester).toEqual({ email: 'boss@customer.example', name: 'Boss Person' });
    expect(r2.quotedOriginal).toEqual(expect.objectContaining({ subject: 'Re: Invoice 4471 still unpaid [TP-1204]' }));
    expect(r2.quotedOriginal.html).toMatch(/we are looking into invoice 4471/);
    expect(r2.decision.details.viaQuotedFrom).toBe(true);

    // Mailbox in To alongside the external also counts (not the sole To); no reply evidence needed.
    const r3 = await classifyIntake(connection, ccReply({ subject: 'Invoice question', to: [RITA, MAILBOX], cc: [], inReplyTo: null, references: null }));
    expect(r3.kind).toBe('agent_cc');
  });

  test('rule 2 off (agentCcIntake=false) → held chooser when reply evidence, else fresh', async () => {
    asAgent();
    const off = { ...connection, agentCcIntake: false };
    const held = await classifyIntake(off, ccReply());
    expect(held.kind).toBe('agent_no_requester');
    expect(held.candidates).toEqual([{ email: RITA }]);
    expect(held.decision.rule).toBe('agent_cc_intake_disabled');
    const fresh = await classifyIntake(off, ccReply({ subject: 'Invoice question', inReplyTo: null, references: null }));
    expect(fresh).toEqual(expect.objectContaining({ kind: 'fresh', decision: expect.objectContaining({ rule: 'agent_cc_intake_disabled_fresh' }) }));
  });

  test('rule 2 guard: a quoted From that contradicts two externals → ambiguous_sender', async () => {
    asAgent();
    const quoted = fixture('reply-not-forward.html').replace('Ticket Pulse &lt;patickets@bgcengineering.ca&gt;', 'Third Party &lt;third@elsewhere.example&gt;');
    const r = await classifyIntake(connection, ccReply({ to: [RITA, 'boss@customer.example'], bodyHtml: quoted }));
    expect(r.kind).toBe('ambiguous_sender');
    expect(r.candidates.map((c) => c.email)).toEqual(['third@elsewhere.example', RITA, 'boss@customer.example']);
    expect(r.decision.rule).toBe('agent_ambiguous_sender');
  });

  test('rule 2 guard: a KNOWN reference the ladder could not thread (held mail) → never a new ticket', async () => {
    asAgent();
    holdMock.isKnownMessageId.mockResolvedValue(true);
    const r = await classifyIntake(connection, ccReply());
    expect(r).toEqual(expect.objectContaining({ kind: 'external_reply_unknown', decision: expect.objectContaining({ rule: 'reply_to_known_unthreaded', details: expect.objectContaining({ via: 'hold_service' }) }) }));
    expect((await classifyIntake(connection, ccReply(), { knownReferenceFound: true })).decision.details.via).toBe('ladder');
  });

  test('rule 4: agent Bcc (mailbox absent) → agent_no_requester with the externals as candidates', async () => {
    asAgent();
    const r = await classifyIntake(connection, ccReply({ cc: [] }));
    expect(r.kind).toBe('agent_no_requester');
    expect(r.candidates).toEqual([{ email: RITA }]);
    expect(r.decision.rule).toBe('agent_bcc_mailbox');
    // Even without reply evidence — the plan says: never Bcc the mailbox.
    expect((await classifyIntake(connection, ccReply({ cc: [], subject: 'fresh', inReplyTo: null, references: null }))).kind).toBe('agent_no_requester');
  });

  test('rule 4: agents-only recipients with reply evidence → agent_no_requester (quoted From offered when usable)', async () => {
    asAgent();
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'bob.middle@bgcengineering.ca' }]);
    const r = await classifyIntake(connection, ccReply({ to: ['bob.middle@bgcengineering.ca'], cc: [MAILBOX] }));
    expect(r.kind).toBe('agent_no_requester');
    expect(r.candidates).toEqual([]);
    expect(r.decision).toEqual({ rule: 'agent_reply_no_requester', details: expect.objectContaining({ agentRecipients: ['bob.middle@bgcengineering.ca'] }) });
    const quoted = fixture('reply-not-forward.html').replace('Ticket Pulse &lt;patickets@bgcengineering.ca&gt;', 'Rita Requester &lt;rita.requester@customer.example&gt;');
    const r2 = await classifyIntake(connection, ccReply({ to: [MAILBOX], cc: [], bodyHtml: quoted }));
    expect(r2.kind).toBe('agent_no_requester');
    expect(r2.candidates).toEqual([{ email: RITA, name: 'Rita Requester' }]);
  });

  test('rule 5: an agent simply emailing the mailbox → fresh (agent is the requester)', async () => {
    asAgent();
    const r = await classifyIntake(connection, { subject: 'My laptop fan is loud', from: AGENT.email, to: [MAILBOX], cc: [], bodyHtml: '<p>help</p>' });
    expect(r).toEqual(expect.objectContaining({ kind: 'fresh', decision: expect.objectContaining({ rule: 'fresh_from_agent' }) }));
  });

  test('rule 3 / 5 for non-agents: reply evidence → external_reply_unknown; else fresh; replies_only policy holds fresh mail', async () => {
    const r = await classifyIntake(connection, { subject: 'Re: hello', from: RITA, to: [MAILBOX], bodyText: 'hi', inReplyTo: '<gone@x>' });
    expect(r).toEqual(expect.objectContaining({ kind: 'external_reply_unknown', agent: null, decision: expect.objectContaining({ rule: 'external_reply_unknown', details: expect.objectContaining({ evidence: ['threading_headers', 'subject_prefix'], refs: ['<gone@x>'] }) }) }));
    expect((await classifyIntake(connection, { subject: 'hello', from: RITA, to: [MAILBOX], bodyText: 'hi' })).kind).toBe('fresh');
    expect((await classifyIntake({ ...connection, newTicketPolicy: 'replies_only' }, { subject: 'hello', from: RITA, to: [MAILBOX], bodyText: 'hi' })).decision.rule).toBe('policy_replies_only');
    // A non-agent FW: with a header block is NOT re-attributed (gate 1) and
    // a forward prefix alone never holds it — it is a fresh ticket for the sender.
    const fw = await classifyIntake(connection, { subject: 'FW: Invoice 4471 still unpaid', from: 'someone@customer.example', to: [MAILBOX], bodyHtml: fixture('outlook-owa.html') });
    expect(fw).toEqual(expect.objectContaining({ kind: 'fresh', agent: null, decision: expect.objectContaining({ rule: 'fresh' }) }));
    // …but a non-agent FW: carrying our [TP-n] token in the quoted body is held.
    const fwTok = await classifyIntake(connection, { subject: 'FW: hello', from: 'someone@customer.example', to: [MAILBOX], bodyText: 'see below\n\nSubject: Re: hello [TP-1204]' });
    expect(fwTok.kind).toBe('external_reply_unknown');
  });

  test('prepareAgentContext: rung-4 address is the original sender (forward) / external recipient (Cc) / null — never the agent; subject prefixes stripped', async () => {
    const fwd = await prepareAgentContext(connection, owaForward({ subject: 'FW: RE: Invoice 4471 [TP-1204]' }), AGENT);
    expect(fwd.recencySender).toBe(RITA);
    expect(fwd.subjectForMatch).toBe('Invoice 4471 [TP-1204]');
    const cc = await prepareAgentContext(connection, ccReply(), AGENT);
    expect(cc.recencySender).toBe(RITA);
    const solo = await prepareAgentContext(connection, { subject: 'Re: x', from: AGENT.email, to: [MAILBOX], cc: [], bodyHtml: '<p>x</p>' }, AGENT);
    expect(solo.recencySender).toBeNull();
    expect(agentIntake.stripSubject('AW: WG: Rechnung')).toBe('Rechnung');
  });
});
