// "Other teams" people (assignable-only) sit in their own FreshService group
// (e.g. Coreshack). Assigning one of them an FS-born ticket in another group
// moves the ticket to their group in the same write-back (2 Oct 2026) — the
// server decides; this only previews it in the FreshService confirm.
export function groupMoveFor(tech, ticketGroupId, groups = []) {
  const home = tech?.assignableOnly ? tech.homeGroup : null;
  if (!home || ticketGroupId === null || ticketGroupId === undefined || ticketGroupId === '') return null;
  const current = String(ticketGroupId);
  if ((home.memberOf || [home.id]).map(String).includes(current)) return null;
  const fromName = (groups || []).find((g) => g.freshserviceId && String(g.freshserviceId) === current)?.name || 'Current group';
  return { field: 'Group', from: fromName, to: home.name };
}
