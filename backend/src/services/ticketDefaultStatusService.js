// Default status filter for the Tickets list, per workspace (QA 09-23 #4).
//
// Project Accounting wants Open + Pending when the list opens; IT wants every
// status (3.9.67's default). Stored as app_settings `ticket_default_statuses_ws<N>`
// = JSON array of status NAMES from the workspace registry. Empty / absent =
// every status (unchanged behaviour). The URL always wins: ?status=any shows
// everything, an explicit ?status= list shows that list.
import settingsRepository from './settingsRepository.js';
import statusService from './statusService.js';
import { ValidationError } from '../utils/errors.js';

export const defaultStatusesKey = (workspaceId) => `ticket_default_statuses_ws${Number(workspaceId)}`;

function parse(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

class TicketDefaultStatusService {
  /** The workspace's default statuses (names still in the registry). Never throws. */
  async get(workspaceId) {
    try {
      const stored = parse(await settingsRepository.get(defaultStatusesKey(workspaceId)));
      if (!stored.length) return [];
      const names = new Set((await statusService.listStatuses(workspaceId)).map((s) => s.name));
      return stored.map(String).filter((s) => names.has(s));
    } catch {
      return [];
    }
  }

  async set(workspaceId, statuses) {
    if (!Array.isArray(statuses)) throw new ValidationError('statuses must be an array of status names (empty = every status)');
    const active = (await statusService.listStatuses(workspaceId)).map((s) => s.name);
    const clean = [...new Set(statuses.map((s) => String(s).trim()).filter(Boolean))];
    const unknown = clean.filter((s) => !active.includes(s));
    if (unknown.length) throw new ValidationError(`Unknown status(es): ${unknown.join(', ')}. Valid: ${active.join(', ')}`);
    // Every status selected = no filter; store empty so new statuses show up too.
    const value = clean.length === active.length ? [] : clean;
    await settingsRepository.set(defaultStatusesKey(workspaceId), JSON.stringify(value));
    return value;
  }
}

export default new TicketDefaultStatusService();
