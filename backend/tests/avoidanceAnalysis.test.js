import {
  detectSkip,
  analyzeWindow,
  determineBadge,
} from '../src/services/avoidanceHeuristics.js';

const DEFAULT_CONFIG = {
  minWaitMinutes: 15,
  minSampleSize: 5,
  flagThreshold: 0.35,
  watchThreshold: 0.15,
  easyCategories: [],
};

function makeTicket(overrides = {}) {
  return {
    id: 1,
    freshserviceTicketId: BigInt(1001),
    subject: 'Test ticket',
    status: 'Open',
    priority: 3,
    createdAt: new Date('2026-02-23T14:00:00Z'),
    firstAssignedAt: null,
    assignedTechId: null,
    isSelfPicked: false,
    assignedBy: null,
    ticketCategory: null,
    ...overrides,
  };
}

describe('determineBadge', () => {
  test('returns insufficient_data when sample < minSampleSize', () => {
    expect(determineBadge(0.5, 3, DEFAULT_CONFIG)).toBe('insufficient_data');
  });

  test('returns flagged when skipRate >= flagThreshold', () => {
    expect(determineBadge(0.40, 10, DEFAULT_CONFIG)).toBe('flagged');
  });

  test('returns watch when skipRate >= watchThreshold but < flagThreshold', () => {
    expect(determineBadge(0.20, 10, DEFAULT_CONFIG)).toBe('watch');
  });

  test('returns good when skipRate < watchThreshold', () => {
    expect(determineBadge(0.05, 10, DEFAULT_CONFIG)).toBe('good');
  });

  test('returns good when skipRate is 0', () => {
    expect(determineBadge(0, 10, DEFAULT_CONFIG)).toBe('good');
  });
});

describe('detectSkip', () => {
  test('returns null when queue is empty at pickup time', () => {
    const picked = makeTicket({
      id: 10,
      priority: 3,
      createdAt: new Date('2026-02-23T15:00:00Z'),
      firstAssignedAt: new Date('2026-02-23T15:05:00Z'),
    });
    const pickupTime = new Date('2026-02-23T15:05:00Z');
    const allTickets = [picked];
    expect(detectSkip(picked, allTickets, pickupTime, DEFAULT_CONFIG)).toBeNull();
  });

  test('detects skip when higher-priority ticket is available', () => {
    const picked = makeTicket({
      id: 10,
      priority: 4, // Low priority
      createdAt: new Date('2026-02-23T15:00:00Z'),
      firstAssignedAt: new Date('2026-02-23T15:30:00Z'),
    });
    const urgent = makeTicket({
      id: 20,
      freshserviceTicketId: BigInt(2002),
      priority: 1, // Urgent
      createdAt: new Date('2026-02-23T14:30:00Z'),
      firstAssignedAt: null, // still unassigned
      status: 'Open',
    });
    const pickupTime = new Date('2026-02-23T15:30:00Z');
    const result = detectSkip(picked, [picked, urgent], pickupTime, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result.topSkipped.priority).toBe(1);
    expect(result.reason).toBe('priority_or_age');
  });

  test('does not flag tickets that arrived less than minWaitMinutes ago', () => {
    const picked = makeTicket({
      id: 10,
      priority: 4,
      createdAt: new Date('2026-02-23T15:00:00Z'),
      firstAssignedAt: new Date('2026-02-23T15:05:00Z'),
    });
    const recent = makeTicket({
      id: 20,
      priority: 1,
      createdAt: new Date('2026-02-23T15:04:00Z'), // Only 1 min before pickup
      firstAssignedAt: null,
      status: 'Open',
    });
    const pickupTime = new Date('2026-02-23T15:05:00Z');
    const result = detectSkip(picked, [picked, recent], pickupTime, DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  test('does not flag already-assigned tickets', () => {
    const picked = makeTicket({
      id: 10,
      priority: 4,
      createdAt: new Date('2026-02-23T15:00:00Z'),
      firstAssignedAt: new Date('2026-02-23T15:30:00Z'),
    });
    const alreadyAssigned = makeTicket({
      id: 20,
      priority: 1,
      createdAt: new Date('2026-02-23T14:00:00Z'),
      firstAssignedAt: new Date('2026-02-23T15:10:00Z'), // assigned BEFORE the pickup
      status: 'Open',
    });
    const pickupTime = new Date('2026-02-23T15:30:00Z');
    const result = detectSkip(picked, [picked, alreadyAssigned], pickupTime, DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  test('does not flag resolved/closed tickets', () => {
    const picked = makeTicket({
      id: 10,
      priority: 4,
      createdAt: new Date('2026-02-23T15:00:00Z'),
      firstAssignedAt: new Date('2026-02-23T15:30:00Z'),
    });
    const resolved = makeTicket({
      id: 20,
      priority: 1,
      createdAt: new Date('2026-02-23T14:00:00Z'),
      firstAssignedAt: null,
      status: 'Resolved',
    });
    const pickupTime = new Date('2026-02-23T15:30:00Z');
    const result = detectSkip(picked, [picked, resolved], pickupTime, DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  test('no skip when same priority and similar age', () => {
    const picked = makeTicket({
      id: 10,
      priority: 3,
      createdAt: new Date('2026-02-23T14:55:00Z'),
      firstAssignedAt: new Date('2026-02-23T15:30:00Z'),
    });
    const samePriority = makeTicket({
      id: 20,
      priority: 3,
      createdAt: new Date('2026-02-23T14:50:00Z'), // only 5 min older
      firstAssignedAt: null,
      status: 'Open',
    });
    const pickupTime = new Date('2026-02-23T15:30:00Z');
    const result = detectSkip(picked, [picked, samePriority], pickupTime, DEFAULT_CONFIG);
    // 5 min age difference is < 10 min threshold, and same priority -> no skip
    expect(result).toBeNull();
  });

  test('detects skip when same priority but significantly older ticket available', () => {
    const picked = makeTicket({
      id: 10,
      priority: 3,
      createdAt: new Date('2026-02-23T15:20:00Z'), // newer ticket
      firstAssignedAt: new Date('2026-02-23T15:30:00Z'),
    });
    const older = makeTicket({
      id: 20,
      priority: 3,
      createdAt: new Date('2026-02-23T14:00:00Z'), // much older
      firstAssignedAt: null,
      status: 'Open',
    });
    const pickupTime = new Date('2026-02-23T15:30:00Z');
    const result = detectSkip(picked, [picked, older], pickupTime, DEFAULT_CONFIG);
    // The picked ticket is 80 min newer -> older ticket's age diff > 10 min -> skip
    expect(result).not.toBeNull();
  });

  test('detects easy category skip when configured', () => {
    const config = { ...DEFAULT_CONFIG, easyCategories: ['Password Reset'] };
    const picked = makeTicket({
      id: 10,
      priority: 3,
      ticketCategory: 'Password Reset',
      createdAt: new Date('2026-02-23T15:00:00Z'),
      firstAssignedAt: new Date('2026-02-23T15:30:00Z'),
    });
    // Same priority, created only 5 min before picked — not old enough to trigger age-based skip
    const hardTicket = makeTicket({
      id: 20,
      priority: 3,
      ticketCategory: 'Network Outage',
      createdAt: new Date('2026-02-23T14:55:00Z'),
      firstAssignedAt: null,
      status: 'Open',
    });
    const pickupTime = new Date('2026-02-23T15:30:00Z');
    const result = detectSkip(picked, [picked, hardTicket], pickupTime, config);
    expect(result).not.toBeNull();
    expect(result.reason).toBe('easy_category');
  });
});

describe('analyzeWindow', () => {
  const windowStart = new Date('2026-02-23T14:00:00Z');
  const windowEnd = new Date('2026-02-23T17:00:00Z');

  test('returns zero metrics when no self-picked tickets', () => {
    const result = analyzeWindow([], [], windowStart, windowEnd, DEFAULT_CONFIG);
    expect(result.pickedInWindow).toBe(0);
    expect(result.possibleSkipped).toBe(0);
    expect(result.skipRate).toBe(0);
    expect(result.skipExamples).toHaveLength(0);
  });

  test('correctly counts eligible tickets in window', () => {
    const allTickets = [
      makeTicket({ id: 1, createdAt: new Date('2026-02-23T14:30:00Z'), status: 'Open' }),
      makeTicket({ id: 2, createdAt: new Date('2026-02-23T15:00:00Z'), status: 'Open' }),
      makeTicket({ id: 3, createdAt: new Date('2026-02-23T18:00:00Z'), status: 'Open' }), // outside window
      makeTicket({ id: 4, createdAt: new Date('2026-02-23T16:00:00Z'), status: 'Resolved' }), // resolved
    ];
    const result = analyzeWindow([], allTickets, windowStart, windowEnd, DEFAULT_CONFIG);
    expect(result.eligibleSeen).toBe(2); // only #1 and #2 are open and in-window
  });

  test('detects skips in a realistic scenario', () => {
    const urgentTicket = makeTicket({
      id: 1,
      priority: 1,
      createdAt: new Date('2026-02-23T14:00:00Z'),
      firstAssignedAt: null,
      status: 'Open',
    });
    const lowTicket = makeTicket({
      id: 2,
      priority: 4,
      createdAt: new Date('2026-02-23T14:30:00Z'),
      firstAssignedAt: new Date('2026-02-23T14:35:00Z'),
      isSelfPicked: true,
    });

    const selfPicked = [lowTicket];
    const allTickets = [urgentTicket, lowTicket];
    const result = analyzeWindow(selfPicked, allTickets, windowStart, windowEnd, DEFAULT_CONFIG);

    expect(result.pickedInWindow).toBe(1);
    expect(result.possibleSkipped).toBe(1);
    expect(result.skipRate).toBe(1);
    expect(result.skipExamples).toHaveLength(1);
  });

  test('limits skip examples to 5', () => {
    const allTickets = [];
    const selfPicked = [];

    // Create 8 skip scenarios
    for (let i = 0; i < 8; i++) {
      const urgent = makeTicket({
        id: 100 + i,
        priority: 1,
        createdAt: new Date(`2026-02-23T14:${String(i * 5).padStart(2, '0')}:00Z`),
        firstAssignedAt: null,
        status: 'Open',
      });
      const picked = makeTicket({
        id: 200 + i,
        priority: 4,
        createdAt: new Date(`2026-02-23T14:${String(i * 5 + 20).padStart(2, '0')}:00Z`),
        firstAssignedAt: new Date(`2026-02-23T14:${String(i * 5 + 22).padStart(2, '0')}:00Z`),
        isSelfPicked: true,
      });
      allTickets.push(urgent, picked);
      selfPicked.push(picked);
    }

    const result = analyzeWindow(selfPicked, allTickets, windowStart, windowEnd, DEFAULT_CONFIG);
    expect(result.skipExamples.length).toBeLessThanOrEqual(5);
  });
});

describe('Eastern technician scenario', () => {
  test('eastern tech picking easy tickets while urgent ones wait during pre-HQ window', () => {
    // Simulate: Toronto tech starts 9am ET (14:00 UTC). Vancouver starts 9am PT (17:00 UTC).
    // Between 14:00-17:00 UTC, the Toronto tech is the only one available.
    const exclusiveStart = new Date('2026-02-23T14:00:00Z');
    const exclusiveEnd = new Date('2026-02-23T17:00:00Z');

    // Urgent ticket arrives at 14:10 UTC
    const urgentTicket = makeTicket({
      id: 1,
      freshserviceTicketId: BigInt(5001),
      priority: 1,
      subject: 'Server down - urgent',
      createdAt: new Date('2026-02-23T14:10:00Z'),
      firstAssignedAt: null,
      status: 'Open',
      ticketCategory: 'Infrastructure',
    });

    // Low priority ticket arrives at 14:40 UTC
    const easyTicket = makeTicket({
      id: 2,
      freshserviceTicketId: BigInt(5002),
      priority: 4,
      subject: 'Password reset',
      createdAt: new Date('2026-02-23T14:40:00Z'),
      firstAssignedAt: new Date('2026-02-23T14:45:00Z'), // picked up 5 min later
      isSelfPicked: true,
      status: 'Open',
      ticketCategory: 'Account',
    });

    const selfPicked = [easyTicket];
    const allTickets = [urgentTicket, easyTicket];

    const result = analyzeWindow(selfPicked, allTickets, exclusiveStart, exclusiveEnd, DEFAULT_CONFIG);

    expect(result.pickedInWindow).toBe(1);
    expect(result.possibleSkipped).toBe(1);
    expect(result.skipRate).toBe(1);
    expect(result.skipExamples[0].topSkipped.priority).toBe(1);
    expect(result.skipExamples[0].pickedPriority).toBe(4);
  });

  test('eastern tech picking appropriately shows no skips', () => {
    const exclusiveStart = new Date('2026-02-23T14:00:00Z');
    const exclusiveEnd = new Date('2026-02-23T17:00:00Z');

    // Both tickets are same priority
    const ticket1 = makeTicket({
      id: 1,
      priority: 3,
      createdAt: new Date('2026-02-23T14:10:00Z'),
      firstAssignedAt: new Date('2026-02-23T14:15:00Z'),
      isSelfPicked: true,
      status: 'Pending',
    });
    const ticket2 = makeTicket({
      id: 2,
      priority: 3,
      createdAt: new Date('2026-02-23T14:30:00Z'),
      firstAssignedAt: new Date('2026-02-23T14:35:00Z'),
      isSelfPicked: true,
      status: 'Open',
    });

    const selfPicked = [ticket1, ticket2];
    const allTickets = [ticket1, ticket2];

    const result = analyzeWindow(selfPicked, allTickets, exclusiveStart, exclusiveEnd, DEFAULT_CONFIG);

    expect(result.pickedInWindow).toBe(2);
    expect(result.possibleSkipped).toBe(0);
    expect(result.skipRate).toBe(0);
  });

  test('HQ tech not picking tickets during their own window', () => {
    // Vancouver tech's window: 17:00-01:00 UTC (9am-5pm PT)
    const windowStart = new Date('2026-02-23T17:00:00Z');
    const windowEnd = new Date('2026-02-24T01:00:00Z');

    const urgentTicket = makeTicket({
      id: 1,
      priority: 1,
      createdAt: new Date('2026-02-23T17:05:00Z'),
      firstAssignedAt: null,
      status: 'Open',
    });
    const easyTicket = makeTicket({
      id: 2,
      priority: 4,
      createdAt: new Date('2026-02-23T17:30:00Z'),
      firstAssignedAt: new Date('2026-02-23T17:35:00Z'),
      isSelfPicked: true,
      status: 'Open',
    });

    const result = analyzeWindow([easyTicket], [urgentTicket, easyTicket], windowStart, windowEnd, DEFAULT_CONFIG);

    expect(result.possibleSkipped).toBe(1);
    expect(result.skipExamples[0].topSkipped.priority).toBe(1);
  });
});
