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

// Short / familiar first names → the formal names they stand for (one-way;
// compatibleFirst checks both directions). Kept small and common on purpose.
const NICKNAMES = {
  alex: ['alexander', 'alexandra', 'alexis'], andy: ['andrew'], bill: ['william'], bob: ['robert'], rob: ['robert'], bobby: ['robert'],
  chris: ['christopher', 'christine', 'christina'], dan: ['daniel'], danny: ['daniel'], dave: ['david'], jim: ['james'], jimmy: ['james'],
  joe: ['joseph'], jon: ['jonathan'], kate: ['katherine', 'kathryn', 'catherine'], katie: ['katherine', 'kathryn'], liz: ['elizabeth'],
  matt: ['matthew'], mike: ['michael'], nick: ['nicholas'], pat: ['patrick', 'patricia'], rick: ['richard'], rich: ['richard'],
  sam: ['samuel', 'samantha'], steve: ['stephen', 'steven'], tom: ['thomas'], tony: ['anthony'], will: ['william'], jen: ['jennifer'],
  jenny: ['jennifer'], sue: ['susan'], becky: ['rebecca'], ben: ['benjamin'], greg: ['gregory'], jeff: ['jeffrey'], ken: ['kenneth'],
};

/** "Shinduke, Randy P." → ['randy', 'shinduke'] — order fixed, initials dropped. */
function personTokens(value) {
  const raw = String(value ?? '');
  const comma = raw.indexOf(',');
  const ordered = comma > 0 && !raw.includes('@') ? `${raw.slice(comma + 1)} ${raw.slice(0, comma)}` : raw;
  return nameTokens(ordered).filter((t) => t.length > 1);
}

function firstLast(value) {
  const t = personTokens(value);
  return t.length >= 2 ? { first: t[0], last: t[t.length - 1] } : null;
}

/** Same first AND last name; middle names, initials and "Last, First" order ignored. */
export function sameFirstLast(a, b) {
  const x = firstLast(a);
  const y = firstLast(b);
  return Boolean(x && y && x.first === y.first && x.last === y.last);
}

/** Randy / Randall, Rob / Robert, Mike / Michael. */
export function compatibleFirst(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i >= 4) return true;
  return (NICKNAMES[a] || []).includes(b) || (NICKNAMES[b] || []).includes(a);
}

/** Same last name and a compatible first name. */
export function closeName(a, b) {
  const x = firstLast(a);
  const y = firstLast(b);
  return Boolean(x && y && x.last === y.last && compatibleFirst(x.first, y.first));
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
  const out = await resolveRequesterHintRaw(workspaceId, hint, peopleMentioned);
  return out.status === 'ambiguous' ? collapseSameMailbox(out) : out;
}

/**
 * One person, several addresses (5 Oct 2026). Some people have a second
 * address that is an alias on the same mailbox (katie.burkell@cambioearth.com
 * → KBurkell@bgcengineering.ca), and each address became its own requester
 * row, so "Katie Burkell" read as two people. Before offering a choice, ask
 * Entra who owns each candidate's address and keep one candidate per mailbox,
 * preferring the address that IS the mailbox's own (UPN). An address Entra
 * cannot place stays as its own candidate; Entra being unavailable leaves the
 * result exactly as it was.
 */
async function mailboxOwner(email) {
  if (!email) return null;
  try {
    const { default: azureAdService } = await import('./azureAdService.js');
    if (typeof azureAdService.resolveAddress !== 'function') return null;
    const res = await azureAdService.resolveAddress(email);
    if (res && (res.status === 'found' || res.status === 'alias') && res.owner) return String(res.owner).toLowerCase();
  } catch (err) {
    logger.debug(`Intake mailbox owner lookup failed for ${email}: ${err.message}`);
  }
  return null;
}

export async function collapseSameMailbox(result) {
  const candidates = result.candidates || [];
  if (candidates.length < 2) return result;
  const owners = await Promise.all(candidates.map((c) => mailboxOwner(c.email)));
  const groups = new Map();
  candidates.forEach((c, i) => {
    const key = owners[i] ? `owner:${owners[i]}` : `own:${c.email || c.requesterId || i}`;
    if (!groups.has(key)) groups.set(key, { owner: owners[i], members: [] });
    groups.get(key).members.push(c);
  });
  if (groups.size === candidates.length) return result;
  const pick = ({ owner, members }) => members.find((c) => owner && c.email === owner)
    || members.find((c) => c.requesterId)
    || members[0];
  const merged = [...groups.values()].map((g) => ({ ...g, chosen: pick(g) }));
  if (merged.length === 1) {
    const { chosen, members } = merged[0];
    const others = members.filter((c) => c !== chosen).map((c) => c.email).filter(Boolean);
    return requesterResult('matched', chosen, [],
      `${chosen.source === 'requester' ? 'Known requester' : 'Directory person'} "${chosen.name}" — ${others.join(', ')} ${others.length === 1 ? 'is an alias' : 'are aliases'} on the same mailbox (${chosen.email})`);
  }
  return requesterResult('ambiguous', null, merged.map((g) => g.chosen),
    `${result.reason} (addresses on the same mailbox shown once)`);
}

async function resolveRequesterHintRaw(workspaceId, hint, peopleMentioned = []) {
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
  const pt = personTokens(raw);
  const searchTokens = [...new Set([pt[pt.length - 1], pt[0], tokens[tokens.length - 1]].filter((t) => t && t.length >= 2))];
  const requesters = await prisma.requester.findMany({
    where: {
      isActive: true,
      // Last OR first name (1 Oct 2026): "Shinduke, Randy", "Randall Shinduke"
      // and "Simon P. Dickinson" all reach the candidate pool.
      OR: searchTokens.map((t) => ({ name: { contains: t, mode: 'insensitive' } })),
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
    take: 120,
  });
  const exactRequesters = requesters.filter((r) => normalizeName(r.name) === wanted);
  if (exactRequesters.length === 1) {
    return requesterResult('matched', requesterCandidate(exactRequesters[0]), [], `Known requester named "${exactRequesters[0].name}"`);
  }
  if (exactRequesters.length > 1) {
    return requesterResult('ambiguous', null, exactRequesters.map(requesterCandidate),
      `${exactRequesters.length} known requesters are named "${raw}"`);
  }
  const sameRequesters = requesters.filter((r) => sameFirstLast(r.name, raw));
  if (sameRequesters.length === 1) {
    return requesterResult('matched', requesterCandidate(sameRequesters[0]), [], `Known requester "${sameRequesters[0].name}" (same first and last name)`);
  }

  let directory = tokens.length >= 2 || raw.length >= 3 ? await searchDirectory(raw, 8) : null;
  // Nothing for the full name: try the last name alone (nicknames, "Last, First", middle names).
  const lastName = pt.length >= 2 ? pt[pt.length - 1] : null;
  if (directory !== null && lastName && lastName.length >= 3
    && !(directory || []).some((u) => sameFirstLast(u.displayName, raw) || normalizeName(u.displayName) === wanted)) {
    const byLast = await searchDirectory(lastName, 15);
    if (byLast) {
      const seenMail = new Set(directory.map((u) => String(u.mail || '').toLowerCase()));
      directory = [...directory, ...byLast.filter((u) => !seenMail.has(String(u.mail || '').toLowerCase()))];
    }
  }
  const exactDirectory = (directory || []).filter((u) => normalizeName(u.displayName) === wanted || sameFirstLast(u.displayName, raw));
  if (exactDirectory.length === 1) {
    return requesterResult('matched', directoryCandidate(exactDirectory[0]), [], `Directory person named "${exactDirectory[0].displayName}" (not yet a requester)`);
  }
  if (exactDirectory.length > 1) {
    return requesterResult('ambiguous', null, exactDirectory.map(directoryCandidate),
      `${exactDirectory.length} directory people are named "${raw}"`);
  }

  // Agents are people too: an exact / same-first-last technician with an email.
  if (pt.length >= 2) {
    let techs = [];
    try {
      techs = await prisma.technician.findMany({
        where: { isActive: true, email: { not: null } },
        select: { name: true, email: true },
      });
    } catch { techs = []; }
    const techHits = techs.filter((t) => normalizeName(t.name) === wanted || sameFirstLast(t.name, raw));
    const techEmails = [...new Set(techHits.map((t) => String(t.email).toLowerCase()))];
    if (techEmails.length === 1) {
      const byEmail = await prisma.requester.findFirst({ where: { isActive: true, email: { equals: techEmails[0], mode: 'insensitive' } }, select: { id: true, name: true, email: true } });
      if (byEmail) return requesterResult('matched', requesterCandidate(byEmail), [], `Known requester "${byEmail.name}" (also a technician)`);
      return requesterResult('matched', { requesterId: null, email: techEmails[0], name: techHits[0].name, source: 'directory' }, [],
        `Technician "${techHits[0].name}" (not yet a requester)`);
    }
  }

  // One person with the same last name and a compatible first name
  // (Randy ↔ Randall, Mike ↔ Michael) across requesters + directory → match.
  if (pt.length >= 2) {
    const pool = [];
    const keys = new Set();
    const add = (c) => {
      const key = c.email || `#${c.requesterId}`;
      if (keys.has(key)) return;
      keys.add(key);
      pool.push(c);
    };
    for (const r of requesters) if (closeName(r.name, raw)) add(requesterCandidate(r));
    for (const u of directory || []) if (closeName(u.displayName, raw)) add(directoryCandidate(u));
    if (pool.length === 1) {
      return requesterResult('matched', pool[0], [], `Closest match "${pool[0].name}" — same last name, "${pt[0]}" reads as a short form of their first name`);
    }
    if (pool.length > 1 && pool.length <= MAX_CANDIDATES) {
      return requesterResult('ambiguous', null, pool, `${pool.length} people could be "${raw}"`);
    }
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
    return (tokens.length > 0 && tokens.every((t) => theirs.some((x) => x === t || x.startsWith(t)))) || closeName(name, raw);
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

export default { resolveRequesterHint, collapseSameMailbox, resolveAssigneeHint, resolveConversingAgent, normalizeName, sameFirstLast, compatibleFirst, closeName };
