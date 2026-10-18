import { describe, it, expect, jest } from '@jest/globals';
import { checkTimeZoneData, logTimeZoneDataCheck } from '../src/utils/tzDataCheck.js';

const tzIsCurrent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' })
  .format(new Date('2026-11-15T20:00:00Z')) === '13';

describe('tzDataCheck', () => {
  it('reports the runtime and whether Vancouver is permanent UTC-7', () => {
    const result = checkTimeZoneData();
    expect(result.node).toBe(process.version);
    expect(typeof result.tz).toBe('string');
    expect(result.ok).toBe(tzIsCurrent);
    expect(result.vancouverHour).toBe(tzIsCurrent ? 13 : 12);
  });

  it('logs info on current data and an error on old data', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const result = logTimeZoneDataCheck(logger);
    if (result.ok) {
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('permanent UTC-7 is known'));
      expect(logger.error).not.toHaveBeenCalled();
    } else {
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ICU_TIMEZONE_FILES_DIR'));
    }
  });
});
