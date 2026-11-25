/**
 * What a leave row means for "is this person away?" (25 Nov 2026).
 *
 * technician_leaves.category is OFF | WFH | OTHER | IGNORED. Vacation Pulse's
 * "Site visit" (availability ONSITE) and Vacation Tracker's site-visit / field
 * types arrive as OTHER, and every reader treated OTHER as away, so people on
 * a site visit were skipped by assignment, shares, level match, urgent response
 * and Teams notifications. A site visit is work somewhere else, never an
 * absence (assigneeAwayService already says so). Other OTHER rows (physio,
 * leaving early, training) keep today's meaning: away during the leave.
 */

// "Site visit(s)", "Site-visit", "Field work", "Business trip(s)" (names the
// Vacation Pulse Site visit type maps from Vacation Tracker), a bare "Field"
// or "On site". A plural "Site visits" slipped past the first version's \b.
const SITE_VISIT_NAME = /\b(site[\s_-]*visits?|field[\s_-]*work|business[\s_-]*trips?)\b|^\s*(field|on[\s_-]*site)\s*$/i;

/** The leave's type name, whichever shape the row came in. */
function typeName(leave) {
  return String(leave?.leaveTypeName ?? leave?.leave_type_name ?? leave?.leaveType ?? leave?.typeName ?? '');
}

/** True when the leave is a site visit (work at another site, not an absence). */
export function isSiteVisitLeave(leave) {
  if (!leave) return false;
  // The category wins: an OFF row is a day off whatever its name or availability.
  const category = String(leave.category || '').toUpperCase();
  if (category === 'OFF' || category === 'WFH' || category === 'IGNORED') return false;
  if (String(leave.availability || '').toUpperCase() === 'ONSITE') return true;
  return SITE_VISIT_NAME.test(typeName(leave));
}

/** True when the leave makes the person unavailable (for its window). */
export function isAwayLeave(leave) {
  if (!leave) return false;
  const category = String(leave.category || '').toUpperCase();
  if (category === 'WFH' || category === 'IGNORED') return false;
  if (isSiteVisitLeave(leave)) return false;
  return true;
}

export default { isSiteVisitLeave, isAwayLeave };
