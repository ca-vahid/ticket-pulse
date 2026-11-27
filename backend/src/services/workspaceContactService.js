import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Contacts (QA 11-26 item 2): Settings -> Contacts.
 *
 * A workspace's own list of people outside the directory that its admins want
 * to pick as requesters or recipients. Requester rows are GLOBAL and shared
 * with the FreshService sync, Entra enrichment and inbound mail, so a contact
 * is a LINK (workspace_contacts) to a requester row:
 *   - add: the e-mail is the identity. A known requester (any case) is linked,
 *     never duplicated; otherwise a TP-native requester is created
 *     (freshserviceId null) and the link is marked createdRequester.
 *     FreshService is never called.
 *   - remove: deletes the link only. Requester rows are never deleted (tickets
 *     point at them). The createdRequester mark lives on the links (not on the
 *     shared requesters table, so nothing outside Contacts depends on this
 *     migration); a removed link hands it to another workspace's link. A row
 *     Contacts itself created, with no other workspace link and no tickets, is
 *     hidden from pickers with suppressedAt + 'contact_removed' (isActive
 *     belongs to the FreshService sync, which rewrites it every cycle). Adding
 *     it again clears that.
 * Integration sandboxes (workspaces 6-9) are read-only here.
 * Logs carry workspace and row ids only, never e-mail addresses.
 */

export const SANDBOX_WORKSPACES = [6, 7, 8, 9];
export const CONTACT_REMOVED = 'contact_removed';

const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;
const LIMITS = { name: 255, email: 255, phone: 50, jobTitle: 255, note: 255 };
const LIST_LIMIT = 500;

const REQUESTER_SELECT = {
  id: true, name: true, email: true, phone: true, jobTitle: true, freshserviceId: true,
  isActive: true, suppressedAt: true, suppressedReason: true,
};

const SUPPRESSION_WORDS = {
  entra_absent: 'not a real mailbox',
  qa_artifact: 'a test address',
};

/** Trim e-mail, lowercase it, check its shape. */
export function normaliseEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email) throw new ValidationError('E-mail is required');
  if (email.length > LIMITS.email || !EMAIL_RE.test(email)) {
    throw new ValidationError('Enter a valid e-mail address, like name@example.com');
  }
  return email;
}

function cleanText(value, field, { required = false, label = field } = {}) {
  if (value === undefined) return undefined;
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new ValidationError(`${label} is required`);
    return null;
  }
  if (text.length > LIMITS[field]) throw new ValidationError(`${label} can be at most ${LIMITS[field]} characters`);
  return text;
}

function assertWritable(workspaceId) {
  if (SANDBOX_WORKSPACES.includes(Number(workspaceId))) {
    throw new AuthorizationError('Contacts cannot be changed in an integration sandbox workspace', 'sandbox_workspace');
  }
}

function wsId(workspaceId) {
  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) throw new ValidationError('Workspace selection required');
  return ws;
}

function contactId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('Contact not found');
  return id;
}

/** Why this person does not show in pickers, in plain words (null = they do). */
function hiddenNote(requester) {
  if (!requester?.suppressedAt) return null;
  if (requester.suppressedReason === CONTACT_REMOVED) return 'removed from Contacts';
  return SUPPRESSION_WORDS[requester.suppressedReason] || 'hidden by an admin clean-up';
}

const hasFsId = (requester) => requester?.freshserviceId !== null && requester?.freshserviceId !== undefined;

/** API shape. Never exposes the BigInt FreshService id. */
export function toContactDto(link) {
  const r = link.requester || {};
  return {
    id: link.id,
    requesterId: link.requesterId ?? r.id ?? null,
    name: r.name || r.email || '',
    email: r.email || '',
    phone: r.phone || null,
    jobTitle: r.jobTitle || null,
    note: link.note || null,
    addedBy: link.addedByEmail || null,
    addedAt: link.createdAt || null,
    // FreshService owns name/phone/job title once the person exists there
    // (the requester sync rewrites them every cycle); only the note is ours.
    managedByFreshService: hasFsId(r),
    hiddenFromPickers: hiddenNote(r),
  };
}

async function findLink(ws, id) {
  const link = await prisma.workspaceContact.findFirst({
    where: { id, workspaceId: ws },
    include: { requester: { select: REQUESTER_SELECT } },
  });
  if (!link) throw new NotFoundError('Contact not found');
  return link;
}

function isUniqueViolation(err) {
  return err?.code === 'P2002';
}

class WorkspaceContactService {
  /** This workspace's contacts, name order; `search` matches name or e-mail. */
  async list(workspaceId, { search = '' } = {}) {
    const ws = wsId(workspaceId);
    const q = String(search || '').trim().slice(0, 100);
    const where = { workspaceId: ws };
    if (q) {
      where.requester = {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      };
    }
    const [rows, total] = await Promise.all([
      prisma.workspaceContact.findMany({
        where,
        include: { requester: { select: REQUESTER_SELECT } },
        orderBy: [{ requester: { name: 'asc' } }, { id: 'asc' }],
        take: LIST_LIMIT,
      }),
      prisma.workspaceContact.count({ where: { workspaceId: ws } }),
    ]);
    return { contacts: rows.map(toContactDto), total, sandbox: SANDBOX_WORKSPACES.includes(ws) };
  }

  /**
   * Add a contact. Returns { contact, existing, message }: existing=true when
   * the e-mail already belonged to a known person (linked, not duplicated).
   */
  async add(workspaceId, input = {}, by = null) {
    const ws = wsId(workspaceId);
    assertWritable(ws);
    const email = normaliseEmail(input.email);
    const name = cleanText(input.name, 'name', { required: true, label: 'Name' });
    const phone = cleanText(input.phone, 'phone', { label: 'Phone' }) ?? null;
    const jobTitle = cleanText(input.jobTitle, 'jobTitle', { label: 'Job title' }) ?? null;
    const note = cleanText(input.note, 'note', { label: 'Note' }) ?? null;
    const addedByEmail = by ? String(by).trim().toLowerCase().slice(0, 255) : null;

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const known = await tx.requester.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
          orderBy: { id: 'asc' },
          select: REQUESTER_SELECT,
        });

        if (known) {
          const already = await tx.workspaceContact.findFirst({ where: { workspaceId: ws, requesterId: known.id }, select: { id: true } });
          if (already) throw new ConflictError(`${known.name || email} is already a contact in this workspace`);
          let requester = known;
          // Only Contacts sets 'contact_removed', so this row is one Contacts made.
          const ours = Boolean(known.suppressedAt) && known.suppressedReason === CONTACT_REMOVED;
          if (ours) {
            // Adding it back undoes the hiding and, while FreshService does not
            // own the row yet, takes the details just typed.
            const refresh = !hasFsId(known)
              ? { name, ...(phone ? { phone } : {}), ...(jobTitle ? { jobTitle } : {}) }
              : {};
            requester = await tx.requester.update({
              where: { id: known.id },
              data: { suppressedAt: null, suppressedReason: null, ...refresh },
              select: REQUESTER_SELECT,
            });
          }
          const link = await tx.workspaceContact.create({
            data: { workspaceId: ws, requesterId: known.id, note, addedByEmail, createdRequester: ours },
          });
          return { link: { ...link, requester }, existing: true };
        }

        const requester = await tx.requester.create({
          data: {
            freshserviceId: null, name, email, phone, jobTitle, isActive: true,
          },
          select: REQUESTER_SELECT,
        });
        const link = await tx.workspaceContact.create({
          data: { workspaceId: ws, requesterId: requester.id, note, addedByEmail, createdRequester: true },
        });
        return { link: { ...link, requester }, existing: false };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('That person is already a contact in this workspace');
      throw err;
    }

    const contact = toContactDto(outcome.link);
    logger.info(`Contacts: added contact ${outcome.link.id} (requester ${contact.requesterId}, ${outcome.existing ? 'known person' : 'new person'}) in workspace ${ws}`);
    let message;
    if (!outcome.existing) message = `${contact.name} added to this workspace's contacts.`;
    else if (contact.hiddenFromPickers) message = `${contact.name} was already known and is now a contact here, but stays out of the pickers (${contact.hiddenFromPickers}).`;
    else message = `${contact.name} was already known — added to this workspace's contacts.`;
    return { contact, existing: outcome.existing, message };
  }

  /**
   * Edit name / phone / job title / note. The e-mail is the identity: to
   * change it, remove the contact and add the new address.
   */
  // `_by` (the admin) is accepted for symmetry with add(); logs carry ids only.
  async update(workspaceId, rawId, fields = {}, _by = null) {
    const ws = wsId(workspaceId);
    assertWritable(ws);
    const id = contactId(rawId);
    const link = await findLink(ws, id);
    const r = link.requester;

    if (fields.email !== undefined && String(fields.email || '').trim().toLowerCase() !== String(r.email || '').toLowerCase()) {
      throw new ValidationError('The e-mail address is who the contact is. To use a different address, remove this contact and add the new one.');
    }

    const personPatch = {};
    const name = cleanText(fields.name, 'name', { required: true, label: 'Name' });
    const phone = cleanText(fields.phone, 'phone', { label: 'Phone' });
    const jobTitle = cleanText(fields.jobTitle, 'jobTitle', { label: 'Job title' });
    if (name !== undefined && name !== r.name) personPatch.name = name;
    if (phone !== undefined && phone !== (r.phone || null)) personPatch.phone = phone;
    if (jobTitle !== undefined && jobTitle !== (r.jobTitle || null)) personPatch.jobTitle = jobTitle;
    if (Object.keys(personPatch).length && hasFsId(r)) {
      throw new ValidationError('FreshService keeps this person\'s name, phone and job title, so only the note can be changed here.');
    }

    const note = cleanText(fields.note, 'note', { label: 'Note' });
    let requester = r;
    if (Object.keys(personPatch).length) {
      requester = await prisma.requester.update({ where: { id: r.id }, data: personPatch, select: REQUESTER_SELECT });
    }
    let saved = link;
    if (note !== undefined && note !== (link.note || null)) {
      saved = await prisma.workspaceContact.update({ where: { id: link.id }, data: { note } });
    }
    const changed = [...Object.keys(personPatch), ...(saved !== link ? ['note'] : [])];
    if (changed.length) {
      logger.info(`Contacts: updated contact ${link.id} (${changed.join(', ')}) in workspace ${ws}`);
    }
    return { contact: toContactDto({ ...saved, requester }), changed };
  }

  /**
   * Remove a contact: the link row only. Returns { removed, hidden } where
   * hidden=true means the person left the pickers too (see the header).
   */
  async remove(workspaceId, rawId, _by = null) {
    const ws = wsId(workspaceId);
    assertWritable(ws);
    const id = contactId(rawId);
    const link = await findLink(ws, id);
    const r = link.requester;
    await prisma.workspaceContact.delete({ where: { id: link.id } });

    let hidden = false;
    if (link.createdRequester === true && !r.suppressedAt) {
      const next = await prisma.workspaceContact.findFirst({
        where: { requesterId: r.id },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      if (next) {
        // Another workspace still lists them: it inherits the "Contacts made
        // this person" mark, so its own removal can still hide them later.
        await prisma.workspaceContact.update({ where: { id: next.id }, data: { createdRequester: true } });
      } else if (await prisma.ticket.count({ where: { requesterId: r.id } }) === 0) {
        await prisma.requester.update({
          where: { id: r.id },
          data: { suppressedAt: new Date(), suppressedReason: CONTACT_REMOVED },
        });
        hidden = true;
      }
    }
    logger.info(`Contacts: removed contact ${link.id} (requester ${r.id}${hidden ? ', now hidden from pickers' : ''}) in workspace ${ws}`);
    return { removed: true, hidden };
  }
}

export default new WorkspaceContactService();
