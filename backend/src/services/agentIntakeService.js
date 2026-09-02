/**
 * Agent-initiated intake (Mega 09-01 Phase FW-2 + RL-3) — the ONE module the
 * mailbox ingest uses to recognise a workspace agent as the sender and decide
 * what an unmatched inbound mail is:
 *
 *   forward                → an agent forwarded a requester's mail to the
 *                            mailbox: requester = the quoted `From:`.
 *   agent_cc               → an agent replied to (or wrote) a requester with
 *                            the mailbox in Cc: requester = the external
 *                            recipient, the agent's words = first public reply.
 *   agent_no_requester     → an agent mail with reply evidence but nobody to
 *                            file it for (agents-only To, mailbox Bcc'd) → hold.
 *   ambiguous_sender       → the quoted From contradicts the recipients → hold.
 *   external_reply_unknown → a non-agent reply to mail we never sent → hold.
 *   fresh                  → a new conversation → create as today.
 *
 * The decision table (RL-3) is evaluated AFTER the matching ladder found no
 * ticket; `classifyIntake` never touches the ladder. Rung 4 (sender+recency)
 * is the ingest's job — this module only tells it which address to use
 * (`recencySender`) and it is NEVER the agent.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { parseForwardedMail, stripSubjectPrefixes } from '../utils/forwardedMailParser.js';

// Mirrors mailboxIngestService.LOOP_SENDERS (kept local to avoid a module cycle).
const LOOP_SENDERS = /(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply)@/i;
const EMAIL_SHAPE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const REPLY_SUBJECT_RE = /^\s*(?:\[[^\]]{1,40}\]\s*)?(re|aw|sv|antw|fw|fwd|wg|tr)\s*:/i;
const BODY_HEAD_BYTES = 2048;

export const NEW_TICKET_POLICIES = ['create', 'replies_only', 'hold_unmatched'];
export const DEFAULT_NEW_TICKET_POLICY = 'hold_unmatched';

/** Effective per-mailbox policy — works before the RL-4 migration lands. */
export function newTicketPolicy(connection) {
  const v = String(connection?.newTicketPolicy ?? DEFAULT_NEW_TICKET_POLICY).toLowerCase();
  return NEW_TICKET_POLICIES.includes(v) ? v : DEFAULT_NEW_TICKET_POLICY;
}

/** Per-mailbox switch for rule 2 (agent Cc intake), default ON. */
export function agentCcIntakeEnabled(connection) {
  return connection?.agentCcIntake !== false;
}

export function normalizeEmail(s) {
  const v = String(s || '').trim().toLowerCase();
  const angle = v.match(/<([^<>]+)>/);
  return (angle ? angle[1] : v).trim();
}

function addressList(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[,;]/);
  return [...new Set(parts.map(normalizeEmail).filter((a) => a.includes('@')))];
}

/** Angle-bracketed ids from In-Reply-To/References (same shape as the ingest's helper). */
export function headerMessageIds(email) {
  const raw = `${email?.inReplyTo || ''} ${email?.references || ''}`;
  return [...new Set([...raw.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]))];
}

/**
 * Is `address` the connection's mailbox (or a `mailbox+tag@` variant of it)?
 */
export function isMailboxAddress(address, mailboxAddress) {
  const a = normalizeEmail(address);
  const base = normalizeEmail(mailboxAddress);
  if (!a || !base) return false;
  if (a === base) return true;
  const [baseLocal, baseDomain] = base.split('@');
  const m = a.match(/^([^@+]+)\+[^@]*@(.+)$/);
  return Boolean(m) && m[1] === baseLocal && m[2] === baseDomain;
}

/** Active workspace technician by email (case-insensitive), or null. */
export async function resolveAgentSender(workspaceId, fromEmail) {
  const email = normalizeEmail(fromEmail);
  if (!email || !EMAIL_SHAPE.test(email)) return null;
  try {
    const tech = await prisma.technician.findFirst({
      where: { workspaceId, isActive: true, email: { equals: email, mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
    return tech ? { id: tech.id, name: tech.name, email: normalizeEmail(tech.email) } : null;
  } catch (err) {
    logger.warn(`agentIntake: technician lookup failed for ${email} (treating as non-agent): ${err.message}`);
    return null;
  }
}

/** Active technicians among `addresses` (lowercased set). */
async function agentAddressesAmong(workspaceId, addresses) {
  const list = addresses.filter((a) => EMAIL_SHAPE.test(a));
  if (!list.length) return new Set();
  try {
    const rows = await prisma.technician.findMany({
      where: { workspaceId, isActive: true, email: { in: list, mode: 'insensitive' } },
      select: { email: true },
    });
    return new Set(rows.map((r) => normalizeEmail(r.email)).filter(Boolean));
  } catch (err) {
    logger.warn(`agentIntake: recipient technician lookup failed (non-fatal): ${err.message}`);
    return new Set();
  }
}

/**
 * Reply evidence (rung 0): threading headers, a reply/forward subject prefix,
 * or our own markers in the body head ([TP-n], "Ticket received: #", the TP
 * footer). Also scans the first ~2 KB of the body for TP-/#-refs so the ingest
 * can make one last matching attempt before falling through.
 */
export function looksLikeReply(email) {
  const evidence = [];
  if (headerMessageIds(email).length) evidence.push('threading_headers');
  const prefix = String(email?.subject || '').match(REPLY_SUBJECT_RE);
  if (prefix) evidence.push('subject_prefix');
  const subjectPrefixKind = prefix ? (/^(fw|fwd|wg|tr)$/i.test(prefix[1]) ? 'forward' : 'reply') : null;

  const head = bodyHead(email);
  if (/\[TP-\d+\]/i.test(head)) evidence.push('body_tp_token');
  if (/ticket received:\s*#/i.test(head)) evidence.push('body_ack_subject');
  if (/sent (?:by|from) ticket pulse|ticket pulse mail/i.test(head)) evidence.push('body_tp_footer');

  const tp = [...new Set([...head.matchAll(/\bTP-(\d{3,})\b/gi)].map((m) => Number(m[1])))];
  const fs = [...new Set([...head.matchAll(/(?<![\w-])#(\d{5,})\b/g)].map((m) => Number(m[1])))];
  // A forward prefix ALONE is weak evidence: a requester forwarding a vendor
  // mail is a legitimate new ticket. Callers hold on `strongEvidence`;
  // agent rules still see the prefix (a forward of a thread is their case).
  const strongEvidence = evidence.filter((e) => e !== 'subject_prefix' || subjectPrefixKind !== 'forward');
  return { isReply: evidence.length > 0, evidence, strongEvidence, subjectPrefixKind, bodyRefs: { tp, fs } };
}

function bodyHead(email) {
  const raw = email?.bodyText && String(email.bodyText).trim()
    ? String(email.bodyText)
    : stripTags(email?.bodyHtml || email?.bodyPreview || '');
  return raw.slice(0, BODY_HEAD_BYTES);
}

function stripTags(html) {
  return String(html || '')
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
}

/**
 * Who the mail was addressed to, classified against the mailbox and the
 * workspace's agents. `externals` = To ∪ Cc minus the mailbox (any +tag
 * variant), minus every active agent, minus loop senders, minus the sender.
 */
export async function recipientRoles(connection, email, { agentEmails = null } = {}) {
  const to = addressList(email?.to);
  const cc = addressList(email?.cc);
  const mailbox = normalizeEmail(connection?.address);
  const mailboxInTo = to.some((a) => isMailboxAddress(a, mailbox));
  const mailboxInCc = cc.some((a) => isMailboxAddress(a, mailbox));
  const sender = normalizeEmail(email?.from);
  const all = [...new Set([...to, ...cc])];
  const agents = agentEmails ? new Set([...agentEmails].map(normalizeEmail)) : await agentAddressesAmong(connection.workspaceId, all);
  const externals = all.filter((a) => a !== sender
    && !isMailboxAddress(a, mailbox)
    && !agents.has(a)
    && !LOOP_SENDERS.test(a)
    && EMAIL_SHAPE.test(a));
  const agentRecipients = all.filter((a) => agents.has(a));
  return {
    to, cc, mailboxInTo, mailboxInCc,
    mailboxPresent: mailboxInTo || mailboxInCc,
    mailboxSoleTo: mailboxInTo && to.length === 1 && !cc.length,
    externals, agentRecipients,
  };
}

/**
 * Do we know ANY of these Message-IDs? Thread entries, notification
 * deliveries (provider_message_id and — when the RL-5 column exists —
 * message_id) and the hold queue (when the hold service exports
 * isKnownMessageId). Returns {known, via}.
 */
export async function isKnownReference(workspaceId, ids) {
  const refs = [...new Set((ids || []).filter(Boolean))];
  if (!refs.length) return { known: false, via: null };
  const bare = refs.map((r) => r.replace(/^<|>$/g, ''));
  const both = [...new Set([...refs, ...bare])];

  // RL-4: the hold service's lookup is a superset (thread entries ∪
  // notification_deliveries message_id/provider_message_id ∪ held rows) —
  // one call when it is deployed; the layered queries below are the
  // fallback for a build without it.
  try {
    const { default: holdService } = await import('./mailboxHoldService.js');
    if (typeof holdService?.isKnownMessageId === 'function') {
      const known = await holdService.isKnownMessageId(workspaceId, both);
      return { known: Boolean(known), via: known ? 'hold_service' : null };
    }
  } catch { /* hold service not present — layered fallback */ }

  const entry = await prisma.ticketThreadEntry.findFirst({
    where: { workspaceId, emailMessageId: { in: both } }, select: { id: true },
  }).catch(() => null);
  if (entry) return { known: true, via: 'thread_entry' };

  const delivery = await prisma.notificationDelivery.findFirst({
    where: { workspaceId, providerMessageId: { in: both } }, select: { id: true },
  }).catch(() => null);
  if (delivery) return { known: true, via: 'notification_delivery' };

  // RL-5: the RFC Message-ID column; absent until that migration lands.
  try {
    const byMessageId = await prisma.notificationDelivery.findFirst({
      where: { workspaceId, messageId: { in: both } }, select: { id: true },
    });
    if (byMessageId) return { known: true, via: 'notification_delivery_message_id' };
  } catch { /* column not there yet */ }

  return { known: false, via: null };
}

/**
 * Pre-ladder context for an agent sender: parse the body once, decide which
 * address rung 4 may use (never the agent) and the subject the ref rungs see.
 */
export async function prepareAgentContext(connection, email, agent) {
  const subject = String(email?.subject || '');
  const parsed = parseForwardedMail({ html: email?.bodyHtml, text: email?.bodyText, subject });
  const roles = await recipientRoles(connection, email);
  const mailbox = normalizeEmail(connection?.address);
  const original = parsed.original;
  const originalOk = Boolean(original.email)
    && EMAIL_SHAPE.test(original.email)
    && original.email !== agent.email
    && !isMailboxAddress(original.email, mailbox)
    && !LOOP_SENDERS.test(original.email);

  let recencySender = null;
  if (parsed.isForward && originalOk) recencySender = original.email;
  else if (roles.externals.length) recencySender = pickRequester(roles.externals, parsed, originalOk).email;

  return {
    agent,
    parsed,
    roles,
    originalOk,
    subjectForMatch: stripSubjectPrefixes(subject),
    recencySender,
  };
}

function pickRequester(externals, parsed, originalOk) {
  const quoted = originalOk && parsed.hasHeaderBlock ? parsed.original.email : null;
  if (quoted && externals.includes(quoted)) return { email: quoted, name: parsed.original.name || null };
  return { email: externals[0], name: null };
}

/**
 * The RL-3 decision table, evaluated after the ladder found nothing.
 * Returns {kind, decision:{rule, details}, …kind-specific fields}.
 */
export async function classifyIntake(connection, email, { knownReferenceFound = false, agent = undefined, ctx = null } = {}) {
  const from = normalizeEmail(email?.from);
  const resolvedAgent = agent === undefined ? await resolveAgentSender(connection.workspaceId, from) : agent;
  const reply = looksLikeReply(email);
  const refs = headerMessageIds(email);
  const policy = newTicketPolicy(connection);

  // Any known reference that the ladder could not thread (a reply to a HELD
  // message, or a delivery without a ticket) → never a new ticket.
  const refCheck = knownReferenceFound ? { known: true, via: 'ladder' } : await isKnownReference(connection.workspaceId, refs);
  if (refCheck.known) {
    return {
      kind: 'external_reply_unknown',
      agent: resolvedAgent,
      reply,
      decision: { rule: 'reply_to_known_unthreaded', details: { via: refCheck.via, refs, from, policy } },
    };
  }

  if (!resolvedAgent) {
    if (reply.strongEvidence.length) {
      return {
        kind: 'external_reply_unknown',
        agent: null,
        reply,
        decision: { rule: 'external_reply_unknown', details: { evidence: reply.evidence, refs, from, policy } },
      };
    }
    if (policy === 'replies_only') {
      return { kind: 'external_reply_unknown', agent: null, reply, decision: { rule: 'policy_replies_only', details: { from, policy } } };
    }
    return { kind: 'fresh', agent: null, reply, decision: { rule: 'fresh', details: { from, policy } } };
  }

  const context = ctx || await prepareAgentContext(connection, email, resolvedAgent);
  const { parsed, roles, originalOk } = context;
  const base = { agentId: resolvedAgent.id, agentEmail: resolvedAgent.email, from, refs, evidence: reply.evidence, policy, client: parsed.client };

  // Rule FW: a forwarded mail with a usable quoted From → original requester.
  if (parsed.isForward && originalOk) {
    return {
      kind: 'forward',
      agent: resolvedAgent,
      parsed,
      original: parsed.original,
      reply,
      decision: { rule: 'agent_forward', details: { ...base, originalFrom: parsed.original.email, sliced: Boolean(parsed.originalHtml || parsed.originalText) } },
    };
  }

  // Rule 2: agent-initiated intake — mailbox in Cc (or To with company),
  // at least one external recipient, every reference unknown (checked above).
  const mailboxShared = roles.mailboxInCc || (roles.mailboxInTo && !roles.mailboxSoleTo);
  if (roles.externals.length && mailboxShared) {
    if (!agentCcIntakeEnabled(connection)) {
      if (reply.isReply) {
        return {
          kind: 'agent_no_requester',
          agent: resolvedAgent,
          candidates: roles.externals.map((e) => ({ email: e })),
          reply,
          decision: { rule: 'agent_cc_intake_disabled', details: { ...base, externals: roles.externals } },
        };
      }
      return { kind: 'fresh', agent: resolvedAgent, reply, decision: { rule: 'agent_cc_intake_disabled_fresh', details: base } };
    }
    const quoted = originalOk && parsed.hasHeaderBlock ? parsed.original.email : null;
    if (quoted && !roles.externals.includes(quoted) && roles.externals.length > 1) {
      return {
        kind: 'ambiguous_sender',
        agent: resolvedAgent,
        candidates: [{ email: quoted, name: parsed.original.name || null }, ...roles.externals.map((e) => ({ email: e }))],
        reply,
        decision: { rule: 'agent_ambiguous_sender', details: { ...base, quotedFrom: quoted, externals: roles.externals } },
      };
    }
    const requester = pickRequester(roles.externals, parsed, originalOk);
    const quotedOriginal = parsed.hasHeaderBlock && (parsed.originalHtml || parsed.originalText)
      ? { html: parsed.originalHtml, text: parsed.originalText, date: parsed.original.date, dateRaw: parsed.original.dateRaw, subject: parsed.original.subject }
      : null;
    return {
      kind: 'agent_cc',
      agent: resolvedAgent,
      parsed,
      requester,
      quotedOriginal,
      externals: roles.externals,
      reply,
      decision: {
        rule: 'agent_cc_intake',
        details: { ...base, requester: requester.email, viaQuotedFrom: requester.email === quoted, externals: roles.externals, mailboxInCc: roles.mailboxInCc },
      },
    };
  }

  // Rule 4: an agent mail we cannot file for anyone — Bcc'd mailbox (absent
  // from the headers) with externals, or agents-only recipients with reply
  // evidence, or an unparseable forward.
  if (roles.externals.length && !roles.mailboxPresent) {
    return {
      kind: 'agent_no_requester',
      agent: resolvedAgent,
      candidates: roles.externals.map((e) => ({ email: e })),
      reply,
      decision: { rule: 'agent_bcc_mailbox', details: { ...base, externals: roles.externals } },
    };
  }
  // A forward we could not attribute (no header block, or the quoted sender
  // is the agent / the mailbox / not an address): today's behaviour — the
  // agent becomes the requester — plus a system note (FW-3 fallback).
  const forwardShaped = parsed.subjectPrefix.kind === 'forward' || parsed.isForward;
  if (forwardShaped && !originalOk && !refs.length) {
    const reason = !parsed.hasHeaderBlock ? 'no_header_block'
      : !parsed.original.email ? 'original_has_no_address'
        : parsed.original.email === resolvedAgent.email ? 'original_is_agent'
          : isMailboxAddress(parsed.original.email, connection?.address) ? 'original_is_mailbox'
            : 'original_invalid';
    return {
      kind: 'fresh',
      agent: resolvedAgent,
      parsed,
      reply,
      decision: { rule: 'agent_forward_unparsed', details: { ...base, reason, hasHeaderBlock: parsed.hasHeaderBlock } },
    };
  }

  if (reply.isReply) {
    const candidates = [];
    if (originalOk && parsed.hasHeaderBlock) candidates.push({ email: parsed.original.email, name: parsed.original.name || null });
    for (const e of roles.externals) if (!candidates.some((c) => c.email === e)) candidates.push({ email: e });
    return {
      kind: 'agent_no_requester',
      agent: resolvedAgent,
      candidates,
      reply,
      decision: {
        rule: 'agent_reply_no_requester',
        details: { ...base, agentRecipients: roles.agentRecipients, hasHeaderBlock: parsed.hasHeaderBlock },
      },
    };
  }

  // Rule 5: an agent simply emailed the mailbox → they are the requester.
  return { kind: 'fresh', agent: resolvedAgent, reply, decision: { rule: 'fresh_from_agent', details: base } };
}

export { stripSubjectPrefixes as stripSubject };

export default {
  resolveAgentSender, looksLikeReply, classifyIntake, prepareAgentContext, recipientRoles,
  isKnownReference, newTicketPolicy, agentCcIntakeEnabled, headerMessageIds, isMailboxAddress, normalizeEmail,
  stripSubject: stripSubjectPrefixes,
};
