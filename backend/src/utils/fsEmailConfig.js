/**
 * Which FreshService support address a Ticket Pulse ticket's FreshService copy replies from (6 Nov 2026).
 *
 * FreshService sends an agent's reply from the ticket's support e-mail configuration
 * (`email_config_id`), fixed when the ticket is created. A copy created without one falls back
 * to the workspace default — in Accounting that is APTickets@, so an Accounts Receivable copy
 * would have answered customers as AP. The workspace setting `fs_email_config_by_group_ws<N>`
 * maps a FreshService group id to its support-address id, e.g.
 *   {"1000209106": 1000018014, "1000210021": 1000018224}
 * Read from FreshService's own tickets (an AP ticket carries 1000018014, an AR one 1000018224).
 * Returns the id for the ticket's group, or undefined (FreshService's default applies). Never throws.
 */
import settingsRepository from '../services/settingsRepository.js';

export function fsEmailConfigSettingKey(workspaceId) {
  return `fs_email_config_by_group_ws${Number(workspaceId) || 0}`;
}

/** Setting value (JSON text or object) → Map of group id → config id (positive integers only). */
export function parseEmailConfigMap(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return new Map(); }
  }
  const out = new Map();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [group, config] of Object.entries(obj)) {
    const g = String(group).trim();
    const c = Number(config);
    if (/^\d+$/.test(g) && Number.isSafeInteger(c) && c > 0) out.set(g, c);
  }
  return out;
}

export async function fsEmailConfigIdFor(workspaceId, groupId) {
  if (groupId === null || groupId === undefined || groupId === '') return undefined;
  try {
    const map = parseEmailConfigMap(await settingsRepository.get(fsEmailConfigSettingKey(workspaceId)));
    return map.get(String(groupId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export default fsEmailConfigIdFor;
