// QA 11-19 #1: a row that replaced a retired one inherits its saved default
// (mirrors CARRIED_FROM in backend/src/services/teamsNotificationService.js).
const CARRIED_FROM = { survey_result: 'survey_response' };
const ALL_MODES = ['teams', 'digest', 'off'];

/**
 * The default agents really get for a Teams row in a workspace: the server's
 * computed value (settings.effectiveDefaults) when it sends one, else the
 * same rule mirrored - the row's saved default, else the retired row's
 * carried default, else the row's own default.
 */
export function effectiveDefault(e, defaults = {}, serverDefaults = null) {
  const ok = (v) => (Array.isArray(e.modes) && e.modes.length ? e.modes : ALL_MODES).includes(v);
  if (ok(serverDefaults?.[e.key])) return serverDefaults[e.key];
  const saved = defaults?.events || {};
  if (ok(saved[e.key])) return saved[e.key];
  const old = CARRIED_FROM[e.key];
  if (old && ok(saved[old])) return saved[old];
  return e.mode;
}
