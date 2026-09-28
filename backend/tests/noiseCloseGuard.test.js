import { jest } from '@jest/globals';

/**
 * Noise-close guard (27 Sep 2026). The AI's noise verdict may close a ticket
 * only when nothing says a person is waiting on it. Cases come from the 30-day
 * replay of IT's AI closes (27 of 93 would have been held).
 */

const prismaMock = {
  ticket: { findUnique: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const parkMock = {
  hrAutoParkEnabled: jest.fn(),
  hrSuggestion: jest.fn(),
  park: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketParkService.js', () => ({ default: parkMock }));

const {
  evaluateNoiseCloseGuard, parkHeldHrNotice, isHrNoticeSubject, emailDomainIsInternal, NOISE_CLOSE_HOLD_REASONS: R,
} = await import('../src/services/noiseCloseGuard.js');

const ticket = (over = {}) => ({
  id: 10, subject: 'Hello', assignedTechId: null, requesterId: 5, requester: { email: 'someone@bgcengineering.ca' }, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketActivity.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['bgcengineering.ca'] });
  prismaMock.ticket.findFirst.mockResolvedValue(null);
});

const guard = () => evaluateNoiseCloseGuard({ ticketId: 10, workspaceId: 1 });

describe('what holds a close', () => {
  test('an assigned ticket is never closed (#241481 was reopened and picked up)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ assignedTechId: 7 }));
    expect(await guard()).toMatchObject({ hold: true, reason: R.ASSIGNED });
  });

  test('a person already said "not noise" - the routing run may not close it again', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ requester: { email: 'alerts@vendor.com' } }));
    prismaMock.ticketActivity.findFirst.mockResolvedValue({ id: 3 });
    expect(await guard()).toMatchObject({ hold: true, reason: R.MARKED_NOT_NOISE });
    expect(prismaMock.ticketActivity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 10, activityType: 'noise_cleared' },
    }));
  });

  test('HR On Leave notices are held (and parked), never closed', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ subject: 'On Leave Notification: Owen Bunce' }));
    expect(await guard()).toMatchObject({ hold: true, reason: R.HR_NOTICE, hrNotice: true });
  });

  test('a forwarded mail from a person (#242259 "FW: Stay connected with Sage")', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ subject: 'FW: Stay connected with Sage' }));
    expect(await guard()).toMatchObject({ hold: true, reason: R.FORWARDED });
  });

  test('one of our people with a real ticket in the past year', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ subject: 'Hello there is a package for you' }));
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 99 });
    expect(await guard()).toMatchObject({ hold: true, reason: R.PERSON });
    // The ticket itself never counts as its own history.
    expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toMatchObject({ requesterId: 5, id: { not: 10 }, isNoise: false });
  });

  test('a lookup failure holds (fail safe)', async () => {
    prismaMock.ticket.findUnique.mockRejectedValue(new Error('pool timeout'));
    expect(await guard()).toMatchObject({ hold: true, reason: R.LOOKUP_FAILED });
  });
});

describe('what may still close', () => {
  test('a machine address', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ requester: { email: 'noreply@digicert.com' }, subject: 'Your seat at WQRD 2026 is waiting' }));
    expect(await guard()).toMatchObject({ hold: false });
  });

  test('an outside vendor, even one with a past support case (Veeam marketing)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ requester: { email: 'webinars@veeam.com' }, subject: 'Mixed hypervisors. One recovery strategy.' }));
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 99 });
    expect(await guard()).toMatchObject({ hold: false });
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
  });

  test('an internal robot with no real ticket history (NAS alerts)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ requester: { email: 'bgc-nas@bgcengineering.ca' }, subject: '[BGC-TOR-LIDAR1] Volume 2 is running out of space' }));
    expect(await guard()).toMatchObject({ hold: false });
  });

  test('no internal domains configured: history alone decides', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: [] });
    prismaMock.ticket.findUnique.mockResolvedValue(ticket({ requester: { email: 'person@elsewhere.com' } }));
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 99 });
    expect(await guard()).toMatchObject({ hold: true, reason: R.PERSON });
  });

  test('a ticket that no longer exists is not held', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    expect(await guard()).toMatchObject({ hold: false });
  });
});

describe('helpers', () => {
  test('HR notice subjects match the park sweep filters', () => {
    expect(isHrNoticeSubject('On Leave Notification: Jaspreet Singh will be going On Leave')).toBe(true);
    expect(isHrNoticeSubject('Departure Notification - A Person')).toBe(true);
    expect(isHrNoticeSubject('Transfer Notification: X')).toBe(true);
    expect(isHrNoticeSubject('New Hire: Y')).toBe(true);
    expect(isHrNoticeSubject('NH Z starting Monday')).toBe(true);
    expect(isHrNoticeSubject('Re: my leave request')).toBe(false);
  });

  test('internal domain matching includes subdomains, not lookalikes', () => {
    expect(emailDomainIsInternal('a@bgcengineering.ca', ['bgcengineering.ca'])).toBe(true);
    expect(emailDomainIsInternal('a@mail.bgcengineering.ca', ['bgcengineering.ca'])).toBe(true);
    expect(emailDomainIsInternal('a@notbgcengineering.ca', ['bgcengineering.ca'])).toBe(false);
    expect(emailDomainIsInternal('a@bgcengineering.ca', [])).toBe(false);
  });
});

describe('parkHeldHrNotice', () => {
  test('parks until the wake date when the notice has a usable date', async () => {
    parkMock.hrAutoParkEnabled.mockResolvedValue(true);
    parkMock.hrSuggestion.mockResolvedValue({ usable: true, until: '2026-10-05T15:00:00.000Z', wakeDate: '2026-10-05', reason: 'On leave from 6 Oct' });
    parkMock.park.mockResolvedValue({});
    expect(await parkHeldHrNotice({ ticketId: 10, workspaceId: 1 })).toBe('2026-10-05');
    expect(parkMock.park).toHaveBeenCalledWith(10, 1, expect.objectContaining({ kind: 'until_date' }), expect.any(Object), { source: 'suggested_hr' });
  });

  test('no park when the workspace has HR auto-park off, or the date is unclear', async () => {
    parkMock.hrAutoParkEnabled.mockResolvedValueOnce(false);
    expect(await parkHeldHrNotice({ ticketId: 10, workspaceId: 2 })).toBeNull();
    parkMock.hrAutoParkEnabled.mockResolvedValueOnce(true);
    parkMock.hrSuggestion.mockResolvedValueOnce(null);
    expect(await parkHeldHrNotice({ ticketId: 10, workspaceId: 1 })).toBeNull();
    expect(parkMock.park).not.toHaveBeenCalled();
  });

  test('a park failure is swallowed - the sweep retries', async () => {
    parkMock.hrAutoParkEnabled.mockResolvedValue(true);
    parkMock.hrSuggestion.mockResolvedValue({ usable: true, until: 'x', wakeDate: '2026-10-05', reason: 'r' });
    parkMock.park.mockRejectedValue(new Error('already parked'));
    expect(await parkHeldHrNotice({ ticketId: 10, workspaceId: 1 })).toBeNull();
  });
});
