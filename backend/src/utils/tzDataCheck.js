/**
 * BC stopped changing its clocks on 1 Nov 2026 (permanent UTC-7, tzdata 2026b).
 * Older Node builds (Node 20 ships 2025c) still move Vancouver back an hour,
 * which puts business hours, SLA clocks, digests and shift checks an hour late
 * for BC staff. Logged once at boot so a runtime downgrade is visible at once.
 */
const PROBE_INSTANT = new Date('2026-11-15T20:00:00Z');

function hourIn(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(PROBE_INSTANT);
  return Number(parts.find((p) => p.type === 'hour')?.value);
}

export function checkTimeZoneData() {
  let vancouverHour = null;
  try {
    vancouverHour = hourIn('America/Vancouver');
  } catch {
    vancouverHour = null;
  }
  return {
    node: process.version,
    tz: process.versions.tz || 'unknown',
    vancouverHour,
    ok: vancouverHour === 13,
  };
}

export function logTimeZoneDataCheck(logger) {
  const result = checkTimeZoneData();
  if (result.ok) {
    logger.info(`Time-zone data ${result.tz} (Node ${result.node}): BC's permanent UTC-7 is known`);
  } else {
    logger.error(`Time-zone data ${result.tz} (Node ${result.node}) is too old for BC's permanent UTC-7: 15 Nov 2026 20:00 UTC reads as ${result.vancouverHour}:00 in Vancouver, not 13:00. Business hours, SLA clocks and shift checks will be an hour off; set ICU_TIMEZONE_FILES_DIR to backend/tzdata/<release> (see tzdata/README.md).`);
  }
  return result;
}
