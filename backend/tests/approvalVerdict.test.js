import { jest } from '@jest/globals';

/**
 * The approval verdict an external gate reads (Assetron, Sep 2026).
 *
 * These guard the two things a wrong answer costs someone: a laptop handed out
 * on an approval that was never granted, and a legitimate handout blocked. The
 * state machine is pure, so it is tested directly rather than through the DB.
 */

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  APPROVAL_STATES, APPROVAL_REQUIREMENT, deriveState, rowState, decisiveGroup,
} = await import('../src/services/approvalVerdictService.js');

const NOW = new Date('2026-09-08T12:00:00Z');
const row = (over = {}) => ({ id: 1, status: 'pending', expiresAt: null, requestGroupId: 'g1', decidedAt: null, ...over });

describe('approval verdict — the state machine', () => {
  test('the enum is exactly the seven states this product can be in', () => {
    expect([...APPROVAL_STATES].sort()).toEqual([
      'APPROVED', 'CANCELLED', 'EXPIRED', 'INFO_REQUESTED', 'NOT_REQUESTED', 'PENDING', 'REJECTED',
    ]);
    // We never invent states for situations Ticket Pulse does not have.
    for (const invented of ['DELEGATE_APPROVED', 'AUTO_APPROVED', 'PARTIALLY_APPROVED', 'NOT_REQUIRED', 'REVOKED']) {
      expect(APPROVAL_STATES).not.toContain(invented);
    }
  });

  test('no approval rows reads NOT_REQUESTED, never approved', () => {
    expect(deriveState([], NOW)).toBe('NOT_REQUESTED');
    // There is no per-type approval requirement, so we say so rather than guess.
    expect(APPROVAL_REQUIREMENT).toBe('NOT_MODELLED');
  });

  test('each stored status maps to one enum value', () => {
    expect(rowState(row({ status: 'approved' }), NOW)).toBe('APPROVED');
    expect(rowState(row({ status: 'pending' }), NOW)).toBe('PENDING');
    expect(rowState(row({ status: 'rejected' }), NOW)).toBe('REJECTED');
    expect(rowState(row({ status: 'cancelled' }), NOW)).toBe('CANCELLED');
    expect(rowState(row({ status: 'info_requested' }), NOW)).toBe('INFO_REQUESTED');
  });

  test('an unrecognised status fails closed', () => {
    // A future status we have not taught this endpoint about must never gate open.
    expect(rowState(row({ status: 'something_new' }), NOW)).not.toBe('APPROVED');
  });

  test('a pending row past its expiry reads EXPIRED; a granted one never expires', () => {
    const stale = row({ status: 'pending', expiresAt: new Date('2026-08-01T00:00:00Z') });
    expect(rowState(stale, NOW)).toBe('EXPIRED');
    // Expiry is about the emailed link, not the decision: an approval that was
    // granted stays APPROVED however old it is.
    const old = row({ status: 'approved', decidedAt: new Date('2024-01-01T00:00:00Z'), expiresAt: new Date('2024-02-01T00:00:00Z') });
    expect(rowState(old, NOW)).toBe('APPROVED');
  });

  test('any-of, not all-of: one approval in a group of managers is approved', () => {
    // The real shape — a request fans out to both managers, one says yes and
    // the sibling is auto-cancelled.
    const rows = [
      row({ id: 2, status: 'cancelled' }),
      row({ id: 1, status: 'approved', decidedAt: NOW }),
    ];
    expect(deriveState(rows, NOW)).toBe('APPROVED');
  });

  test('a fresh approval outranks an older rejection on the same ticket', () => {
    const rows = [
      row({ id: 9, status: 'approved', requestGroupId: 'g2', decidedAt: NOW }),
      row({ id: 3, status: 'rejected', requestGroupId: 'g1' }),
    ];
    expect(deriveState(rows, NOW)).toBe('APPROVED');
  });

  test('pending outranks a cancelled predecessor', () => {
    const rows = [row({ id: 4, status: 'pending', requestGroupId: 'g2' }), row({ id: 1, status: 'cancelled', requestGroupId: 'g1' })];
    expect(deriveState(rows, NOW)).toBe('PENDING');
  });

  test('rejection is reported as rejected, not as an error', () => {
    expect(deriveState([row({ status: 'rejected' })], NOW)).toBe('REJECTED');
  });

  test('the decisive group is the newest one carrying the winning state', () => {
    const rows = [
      row({ id: 9, status: 'approved', requestGroupId: 'new', decidedAt: NOW }),
      row({ id: 8, status: 'cancelled', requestGroupId: 'new' }),
      row({ id: 2, status: 'approved', requestGroupId: 'old', decidedAt: new Date('2026-01-01') }),
    ];
    const group = decisiveGroup(rows, 'APPROVED', NOW);
    expect(group.map((r) => r.id).sort()).toEqual([8, 9]);
  });
});
