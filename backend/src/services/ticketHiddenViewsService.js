// Ticket views an admin hides for a workspace (QA 10-14 #1).
//
// The Tickets filter rail lists canned views; five of them belong to features
// a workspace may not use (Verified solutions, Scheduled, Grouped, Parked,
// Auto-help waiting). Stored as app_settings `ticket_hidden_views_ws<N>` = JSON
// array of view keys. Empty / absent = every view shows (unchanged behaviour).
// Hiding is presentation only: a link with the view's filters still works.
import settingsRepository from './settingsRepository.js';
import { ValidationError } from '../utils/errors.js';

export const HIDEABLE_VIEWS = Object.freeze(['solutions', 'scheduled', 'grouped', 'parked', 'auto_help_waiting']);

export const hiddenViewsKey = (workspaceId) => `ticket_hidden_views_ws${Number(workspaceId)}`;

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

class TicketHiddenViewsService {
  /** The workspace's hidden views (known keys only). Never throws. */
  async get(workspaceId) {
    try {
      return parse(await settingsRepository.get(hiddenViewsKey(workspaceId))).map(String).filter((k) => HIDEABLE_VIEWS.includes(k));
    } catch {
      return [];
    }
  }

  async set(workspaceId, views) {
    if (!Array.isArray(views)) throw new ValidationError('views must be an array of view keys (empty = show every view)');
    const clean = [...new Set(views.map((v) => String(v).trim()).filter(Boolean))];
    const unknown = clean.filter((v) => !HIDEABLE_VIEWS.includes(v));
    if (unknown.length) throw new ValidationError(`These views cannot be hidden: ${unknown.join(', ')}. Hideable: ${HIDEABLE_VIEWS.join(', ')}`);
    const value = HIDEABLE_VIEWS.filter((v) => clean.includes(v));
    await settingsRepository.set(hiddenViewsKey(workspaceId), JSON.stringify(value));
    return value;
  }
}

export default new TicketHiddenViewsService();
