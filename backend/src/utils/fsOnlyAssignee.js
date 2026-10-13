/**
 * The assignee of a ticket when that person works in FreshService ONLY (12 Oct 2026).
 *
 * Four people (the Coreshack group) are assigned IT tickets in Ticket Pulse but have no Ticket Pulse
 * access: `assignable_only = true`, `is_active = false`. They work the FreshService ticket. While
 * FreshService received IT's mail, it told them itself when a requester replied. Now the reply
 * arrives in Ticket Pulse, which writes it onto the FreshService ticket as a note with no
 * notification, and Ticket Pulse's own "requester replied" e-mail skips inactive people. So nobody
 * would tell them. For these assignees the note asks FreshService to notify them.
 *
 * Returns the address to notify, or null for anyone who uses Ticket Pulse (they get its e-mail).
 * Never throws.
 */
import prisma from '../services/prisma.js';

export async function fsOnlyAssigneeEmail(ticket) {
  const id = ticket?.assignedTechId;
  if (!id) return null;
  try {
    const tech = await prisma.technician.findUnique({ where: { id }, select: { email: true, assignableOnly: true } });
    return tech?.assignableOnly === true && tech.email ? String(tech.email).trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

export default fsOnlyAssigneeEmail;
