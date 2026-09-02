import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Autofill v2 (MEGA 09-02 Phase AF2) — people resolvers.
 *
 * The model returns NAMES; the form needs IDs. These resolvers turn a hint
 * into a match against what Ticket Pulse already knows, with one hard rule:
 * a `matched` status is only ever produced by an UNAMBIGUOUS identity —
 * an exact email, an exact full name held by exactly one person, or (for
 * technicians only, a small closed set) a first name held by exactly one
 * active technician. Anything looser is `ambiguous` with ≤ 5 candidates for
 * the human to pick from, or `none`. A partial name never auto-matches.
 *
 * The requester table is global (not per workspace — same as the create
 * form's typeahead, ticketService.searchRequesters); `workspaceId` is kept
 * on the signature for symmetry and future scoping. Technicians ARE per
 * workspace (FS-synced + local, active only).
 */

const MAX_CANDIDATES = 5;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[‘’“”"']/g, '')
    .replace(/[.,;:()<>[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function nameTokens(value) {
  return normalizeName(value).split(' ').filter(Boolean);
}

function asEmail(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return EMAIL_RE.test(text) ? text : null;
}

function requesterCandidate(row) {
  return {
    requesterId: row.id,
    email: row.email ? String(row.email).toLowerCase() : null,
    name: row.name,
    source: 'requester',
  };
}

function directoryCandidate(user) {
  return {
    requesterId: null,
    email: user.mail ? String(user.mail).toLowerCase() : null,
    name: user.displayName || user.mail,
    source: 'directory',
  };
}

function requesterResult(status, candidate, candidates, reason) {
  return {
    status,
    candidate: candidate || null,
    candidates: status === 'ambiguous' ? candidates.slice(0, MAX_CANDIDATES) : [],
    reason,
  };
}

async function searchDirectory(query, top = 8) {
  try {
    const { default: azureAdService } = await import('./azureAdService.js');
    const users = await azureAdService.searchUsers(query, top);
    return (users || []).filter((u) => u && (u.mail || u.displayName));
  } catch (err) {
    logger.warn(`Intake directory lookup unavailable (requesters still consulted): ${err.message}`);
    return null; // null = directory not consulted (distinct from "no hits")
  }
}

/**
 * @param {number} workspaceId
 * @param {string|null} hint  name or email the model extracted
 * @param {Array<{name:string,email:string|null,role:string}>} [peopleMentioned]
 *   used to upgrade a name hint to an email when the model listed the same
 *   person with a verbatim address.
 */
export async function resolveRequesterHint(workspaceId, hint, peopleMentioned = []) {
  const raw = String(hint ?? '').trim();
  if (!raw) return requesterResult('none', null, [], 'No requester was identified in the material');

  let email = asEmail(raw);
  if (!email) {
    const wanted = normalizeName(raw);
    const person = (Array.isArray(peopleMentioned) ? peopleMentioned : [])
      .find((p) => p && p.email && normalizeName(p.name) === wanted && asEmail(p.email));
    if (person) email = asEmail(person.email);
  }

  // ---- email path: exact address wins outright
  if (email) {
    const byEmail = await prisma.requester.findFirst({
      where: { isActive: true, email: { equals: email, mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
    if (byEmail) return requesterResult('matched', requesterCandidate(byEmail), [], `Known requester with email ${email}`);

    const directory = await searchDirectory(email, 5);
    const exact = (directory || []).filter((u) => String(u.mail || '').toLowerCase() === email);
    if (exact.length === 1) {
      return requesterResult('matched', directoryCandidate(exact[0]), [], `Directory person with email ${email} (not yet a requester)`);
    }
    return requesterResult('none', null, [], directory === null
      ? `No known requester with email ${email} (directory unavailable)`
      : `No known requester or directory person with email ${email}`);
  }

  // ---- name path: exact full name, unique, else ambiguous with candidates
  const wanted = normalizeName(raw);
  const tokens = wanted.split(' ').filter(Boolean);
  const requesters = await prisma.requester.findMany({
    where: {
      isActive: true,
      // Broad contains on the LAST token keeps the scan cheap and index-friendly
      // while still catching "Simon P. Dickinson" vs "Simon Dickinson".
      name: { contains: tokens[tokens.length - 1], mode: 'insensitive' },
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
    take: 50,
  });
  const exactRequesters = requesters.filter((r) => normalizeName(r.name) === wanted);
  if (exactRequesters.length === 1) {
    return requesterResult('matched', requesterCandidate(exactRequesters[0]), [], `Known requester named "${exactRequesters[0].name}"`);
  }
  if (exactRequesters.length > 1) {
    return requesterResult('ambiguous', null, exactRequesters.map(requesterCandidate),
      `${exactRequesters.length} known requesters are named "${raw}"`);
  }

  const directory = tokens.length >= 2 || raw.length >= 3 ? await searchDirectory(raw, 8) : null;
  const exactDirectory = (directory || []).filter((u) => normalizeName(u.displayName) === wanted);
  if (exactDirectory.length === 1) {
    return requesterResult('matched', directoryCandidate(exactDirectory[0]), [], `Directory person named "${exactDirectory[0].displayName}" (not yet a requester)`);
  }
  if (exactDirectory.length > 1) {
    return requesterResult('ambiguous', null, exactDirectory.map(directoryCandidate),
      `${exactDirectory.length} directory people are named "${raw}"`);
  }

  // No exact identity anywhere. Offer similar names (never auto-match — a
  // first name or a partial is not an identity).
  const seen = new Set();
  const similar = [];
  const consider = (candidate) => {
    const key = candidate.email || `#${candidate.requesterId}` || candidate.name;
    if (seen.has(key)) return;
    seen.add(key);
    similar.push(candidate);
  };
  const looksSimilar = (name) => {
    const theirs = nameTokens(name);
    return tokens.length > 0 && tokens.every((t) => theirs.some((x) => x === t || x.startsWith(t)));
  };
  for (const r of requesters) if (looksSimilar(r.name)) consider(requesterCandidate(r));
  for (const u of directory || []) if (looksSimilar(u.displayName)) consider(directoryCandidate(u));

  if (similar.length >= 1 && similar.length <= MAX_CANDIDATES) {
    return requesterResult('ambiguous', null, similar,
      tokens.length < 2
        ? `"${raw}" is only a partial name — ${similar.length} possible match${similar.length === 1 ? '' : 'es'}`
        : `No exact match for "${raw}" — ${similar.length} similar name${similar.length === 1 ? '' : 's'}`);
  }
  if (similar.length > MAX_CANDIDATES) {
    return requesterResult('none', null, [], `"${raw}" matches too many people (${similar.length}) — search for the requester by hand`);
  }
  return requesterResult('none', null, [], directory === null
    ? `No known requester named "${raw}" (directory unavailable)`
    : `No known requester or directory person named "${raw}"`);
}

// ------------------------------------------------------------ technicians

function techCandidate(t) {
  return { id: t.id, name: t.name, email: t.email ? String(t.email).toLowerCase() : null };
}

function assigneeResult(status, technician, candidates, reason) {
  return {
    status,
    technician: technician || null,
    candidates: status === 'ambiguous' ? candidates.slice(0, MAX_CANDIDATES) : [],
    reason,
  };
}

async function loadActiveTechnicians(workspaceId) {
  const rows = await prisma.technician.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });
  // The service account is never a person to assign to.
  return rows.filter((t) => normalizeName(t.name) !== 'ticket pulse');
}

/**
 * Technician resolver. Unique full name → matched; unique first name
 * ("Soheil" → Soheil Nasiri) → matched; an initial/prefix on the last name
 * ("Soheil N.") narrows a first-name tie; several → ambiguous; else none.
 * An email hint matches the technician's email exactly.
 */
export async function resolveAssigneeHint(workspaceId, hint) {
  const raw = String(hint ?? '').trim();
  if (!raw) return assigneeResult('none', null, [], 'No handler was named in the material');

  const technicians = await loadActiveTechnicians(workspaceId);
  if (!technicians.length) return assigneeResult('none', null, [], 'The workspace has no active technicians');

  const email = asEmail(raw);
  if (email) {
    const byEmail = technicians.filter((t) => String(t.email || '').toLowerCase() === email);
    if (byEmail.length === 1) return assigneeResult('matched', techCandidate(byEmail[0]), [], `Technician with email ${email}`);
    return assigneeResult('none', null, [], `No active technician with email ${email}`);
  }

  const wanted = normalizeName(raw);
  const tokens = wanted.split(' ').filter(Boolean);
  if (!tokens.length) return assigneeResult('none', null, [], 'No handler was named in the material');

  const exact = technicians.filter((t) => normalizeName(t.name) === wanted);
  if (exact.length === 1) return assigneeResult('matched', techCandidate(exact[0]), [], `Technician "${exact[0].name}"`);
  if (exact.length > 1) {
    return assigneeResult('ambiguous', null, exact.map(techCandidate), `${exact.length} active technicians are named "${raw}"`);
  }

  // First-name match (optionally narrowed by a last-name initial/prefix).
  const first = tokens[0];
  let byFirst = technicians.filter((t) => nameTokens(t.name)[0] === first);
  if (byFirst.length > 1 && tokens.length > 1) {
    const rest = tokens.slice(1);
    const narrowed = byFirst.filter((t) => {
      const theirs = nameTokens(t.name).slice(1);
      return rest.every((token) => theirs.some((x) => x.startsWith(token)));
    });
    if (narrowed.length) byFirst = narrowed;
  }
  if (byFirst.length === 1) {
    return assigneeResult('matched', techCandidate(byFirst[0]), [],
      `Only one active technician is named ${byFirst[0].name.split(/\s+/)[0]} ("${byFirst[0].name}")`);
  }
  if (byFirst.length > 1) {
    return assigneeResult('ambiguous', null, byFirst.map(techCandidate),
      `${byFirst.length} active technicians share the first name "${byFirst[0].name.split(/\s+/)[0]}"`);
  }

  // Last-name-only / any-token containment: offer, never match.
  const loose = technicians.filter((t) => {
    const theirs = nameTokens(t.name);
    return tokens.every((token) => theirs.some((x) => x === token || x.startsWith(token)));
  });
  if (loose.length >= 1 && loose.length <= MAX_CANDIDATES) {
    return assigneeResult('ambiguous', null, loose.map(techCandidate),
      `No technician is named "${raw}" — ${loose.length} similar name${loose.length === 1 ? '' : 's'}`);
  }
  return assigneeResult('none', null, [], `No active technician named "${raw}"`);
}

/**
 * The IT side of the chat: name → { name, technicianId, email } (ids only
 * when unique). `preferTechnicianId` (the caller's own technician id) breaks
 * a first-name tie — the person pasting a chat is usually its IT side — but
 * never overrides a different unique match.
 */
export async function resolveConversingAgent(workspaceId, name, { preferTechnicianId = null } = {}) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const match = await resolveAssigneeHint(workspaceId, raw);
  if (match.status === 'matched') {
    return { name: match.technician.name, technicianId: match.technician.id, email: match.technician.email };
  }
  if (match.status === 'ambiguous' && preferTechnicianId) {
    const own = match.candidates.find((c) => c.id === Number(preferTechnicianId));
    if (own) return { name: own.name, technicianId: own.id, email: own.email };
  }
  return { name: raw, technicianId: null, email: null };
}

export default { resolveRequesterHint, resolveAssigneeHint, resolveConversingAgent, normalizeName };
