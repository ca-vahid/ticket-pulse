import { describe, expect, test } from '@jest/globals';
import { FS_SOURCE, TP_TO_FS_SOURCE, fsSourceFor } from '../src/utils/fsSourceMap.js';
import { TICKET_SOURCE } from '../src/utils/ticketOrigin.js';

/**
 * QA 11-24 item 10: a Ticket Pulse ticket stored source 3 (Phone) while its
 * FreshService copy showed "Email". The copy now gets the closest
 * FreshService source, from this table.
 */
describe('Ticket Pulse source → FreshService source', () => {
  // [TP source, TP label, FS source on a front-door mailbox workspace, FS source otherwise]
  const TABLE = [
    [1, 'Email', 1, 2],
    [2, 'Portal', 2, 2],
    [3, 'Phone', 3, 3],
    [9, 'Walk-up', 9, 9],
    [100, 'API', 2, 2],
    [101, 'Webhook', 2, 2],
    [102, 'MS Teams', 4, 4],
    [103, 'Agent', 2, 2],
    [104, 'Security Agent', 2, 2],
    [105, 'Office Check-in', 2, 2],
    [106, 'Monitoring Alert', 2, 2],
  ];

  test.each(TABLE)('TP %i (%s) → FS %i (front-door mail) / %i', (tp, _label, frontDoor, other) => {
    expect(fsSourceFor(tp, { frontDoorMail: true })).toBe(frontDoor);
    expect(fsSourceFor(tp, { frontDoorMail: false })).toBe(other);
  });

  test('the production case: Phone is Phone on the copy, never Email', () => {
    expect(fsSourceFor(3)).toBe(FS_SOURCE.PHONE);
    expect(fsSourceFor('3')).toBe(FS_SOURCE.PHONE);
  });

  test('every Ticket Pulse source has a row, and every row is a standard FreshService id', () => {
    for (const code of Object.values(TICKET_SOURCE)) {
      expect(Object.keys(TP_TO_FS_SOURCE).map(Number)).toContain(code);
    }
    const standard = new Set(Object.values(FS_SOURCE));
    for (const fs of Object.values(TP_TO_FS_SOURCE)) expect(standard.has(fs)).toBe(true);
  });

  test("FreshService's own ids pass through; unknown and empty go to Portal", () => {
    expect(fsSourceFor(4)).toBe(4);
    expect(fsSourceFor(10)).toBe(10);
    expect(fsSourceFor(1002)).toBe(FS_SOURCE.PORTAL);
    expect(fsSourceFor(null)).toBe(FS_SOURCE.PORTAL);
    expect(fsSourceFor(undefined)).toBe(FS_SOURCE.PORTAL);
  });
});
