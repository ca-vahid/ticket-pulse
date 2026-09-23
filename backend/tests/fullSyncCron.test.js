import cron from 'node-cron';
import { createRequire } from 'node:module';
import { fullSyncCronExpression, fastSyncCronExpression } from '../src/utils/fastSyncCron.js';

// The minutes node-cron will actually fire on, from its own expander.
const convertExpression = createRequire(import.meta.url)('node-cron/src/convert-expression');
const firingMinutes = (expr) => convertExpression(expr).split(' ')[1].split(',').map(Number);

/**
 * 22 Sep 2026: the five workspaces' scheduled full syncs all fired in the same
 * minute (`*\/5`), and each burst pushed the shared FreshService limiter into
 * 429s and 90 s queue timeouts. Full syncs now take their own minute inside
 * the window; the cadence per workspace is unchanged.
 */
describe('fullSyncCronExpression', () => {
  test('five workspaces on a 5-minute cadence land on five different minutes', () => {
    const exprs = [1, 2, 3, 4, 5].map((ws) => fullSyncCronExpression(5, ws));
    expect(exprs[0]).toBe('1,6,11,16,21,26,31,36,41,46,51,56 * * * *');
    expect(exprs[4]).toBe('0,5,10,15,20,25,30,35,40,45,50,55 * * * *');
    for (const e of exprs) expect(cron.validate(e)).toBe(true);
  });

  // 23 Sep 2026: '1-59/5' validated fine but node-cron expanded it to the
  // multiples of 5, so all five still fired together. Check what it FIRES on.
  test('node-cron fires each workspace on its own minutes, every 5 minutes, :00 included', () => {
    const fired = [1, 2, 3, 4, 5].map((ws) => firingMinutes(fullSyncCronExpression(5, ws)));
    expect(fired[0]).toEqual([1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56]);
    expect(fired[1]).toEqual([2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57]);
    expect(fired[4]).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    const all = fired.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(60);
  });

  test('the cadence is kept: a 10-minute workspace still fires every 10 minutes, on its own offset', () => {
    expect(firingMinutes(fullSyncCronExpression(10, 3))).toEqual([3, 13, 23, 33, 43, 53]);
    expect(fullSyncCronExpression(10, 13)).toBe(fullSyncCronExpression(10, 3));
  });

  test('every minute has no offset to spread; hourly takes a minute of the hour; junk falls back to 5', () => {
    expect(fullSyncCronExpression(1, 4)).toBe('* * * * *');
    expect(fullSyncCronExpression(60, 7)).toBe('7 * * * *');
    expect(firingMinutes(fullSyncCronExpression(0, 2))).toEqual([2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57]);
    expect(fullSyncCronExpression('x', 2)).toBe(fullSyncCronExpression(5, 2));
    expect(cron.validate(fullSyncCronExpression(60, 7))).toBe(true);
  });

  test('fast sync expressions are untouched', () => {
    expect(fastSyncCronExpression(1, 13)).toBe('13 * * * * *');
    expect(fastSyncCronExpression(3, 26)).toBe('26 */3 * * * *');
  });
});
