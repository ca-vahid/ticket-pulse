/**
 * The "Mentions me" filter (29 Oct 2026 view; a combinable filter since MEGA
 * 11-14 Part H). `mentioned=me` always means the signed-in person's own agent
 * row in this workspace — never an id from the URL or a request body.
 *
 * Mentions are stored per workspace agent row (ticket_mentions.technicianId,
 * written only for active agents of the ticket's workspace), so someone with
 * no agent row here can never be mentioned here: they get -1, which matches
 * nothing (the rail hides the filter for them).
 *
 * `mentionedSince` (30 | 90 | any) and `mentionedUnseen` (1) pass through to
 * ticketService.buildListWhere, which validates them; without `mentioned=me`
 * they mean nothing and are dropped. Returns a copy; the source is untouched.
 *
 * @param {object} source the list query (req.query or a bulk body's query)
 * @param {{ ticketActor?: { technicianId?: number|null } }} req
 */
export function scopeMentions(source, req) {
  const query = { ...(source || {}) };
  delete query.mentionedTechnicianId;
  if (query.mentioned === 'me') {
    query.mentionedTechnicianId = req?.ticketActor?.technicianId || -1;
  } else {
    delete query.mentionedSince;
    delete query.mentionedUnseen;
  }
  return query;
}

export default scopeMentions;
