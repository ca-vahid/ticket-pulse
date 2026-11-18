/**
 * The job title to show for a requester (18 Nov 2026).
 *
 * Two copies exist: `entraJobTitle` from the Entra profile sync (the live
 * directory) and `jobTitle` from FreshService, which is typed by hand and goes
 * stale after a promotion (Maria Dietrich: Entra "Project Accountant I", FS
 * still "Senior Project Administrator"). Entra wins; FreshService only fills in
 * when Entra has nothing. Every surface reads it through here so the search
 * dropdown, Teams cards and the profile page agree.
 */
export function requesterTitle(r) {
  const entra = String(r?.entraJobTitle ?? '').trim();
  if (entra) return entra;
  const fs = String(r?.jobTitle ?? '').trim();
  return fs || null;
}
