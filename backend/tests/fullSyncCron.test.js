import cron from 'node-cron';
import { fullSyncCronExpression, fastSyncCronExpression } from '../src/utils/fastSyncCron.js';

/**
 * 22 Sep 2026: the five workspaces' scheduled full syncs all fired in the same
 * minute (`*\/5`), and each burst pushed the shared FreshService limiter into
 * 429s and 90 s queue timeouts. Full syncs now take their own minute inside
 * the window; the cadence per workspace is unchanged.
 */
describe('fullSyncCronExpression', () => {
  test('five workspaces on a 5-minute cadence land on five different minutes', () => {
    const exprs = [1, 2, 3, 4, 5].map((ws) => fullSyncCronExpression(5, ws));
    expect(exprs).toEqual(['1-59/5 * * * *', '2-59/5 * * * *', '3-59/5 * * * *', '4-59/5 * * * *', '0-59/5 * * * *']);
    for (const e of exprs) expect(cron.validate(e)).toBe(true);
  });

  test('the cadence is kept: a 10-minute workspace still fires every 10 minutes, on its own offset', () => {
    expect(fullSyncCronExpression(10, 3)).toBe('3-59/10 * * * *');
    expect(fullSyncCronExpression(10, 13)).toBe('3-59/10 * * * *');
  });

  test('every minute has no offset to spread; hourly takes a minute of the hour; junk falls back to 5', () => {
    expect(fullSyncCronExpression(1, 4)).toBe('* * * * *');
    expect(fullSyncCronExpression(60, 7)).toBe('7 * * * *');
    expect(fullSyncCronExpression(0, 2)).toBe('2-59/5 * * * *');
    expect(fullSyncCronExpression('x', 2)).toBe('2-59/5 * * * *');
    expect(cron.validate(fullSyncCronExpression(60, 7))).toBe(true);
  });

  test('fast sync expressions are untouched', () => {
    expect(fastSyncCronExpression(1, 13)).toBe('13 * * * * *');
    expect(fastSyncCronExpression(3, 26)).toBe('26 */3 * * * *');
  });
});
