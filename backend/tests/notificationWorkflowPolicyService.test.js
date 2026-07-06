import { jest } from '@jest/globals';

const prismaMock = {
  workspace: {
    findUnique: jest.fn(),
  },
  notificationWorkflowPolicy: {
    findUnique: jest.fn(),
  },
};

const availabilityServiceMock = {
  getBusinessHours: jest.fn(),
  isBusinessHours: jest.fn(),
  isHoliday: jest.fn(),
  getNextBusinessTime: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/availabilityService.js', () => ({
  default: availabilityServiceMock,
}));

const {
  getNotificationWorkflowSchedulePreview,
  selectWorkflowsForNotificationTiming,
} = await import('../src/services/notificationWorkflowPolicyService.js');
const {
  selectWorkflowVariants,
} = await import('../src/services/notificationWorkflowRoutingService.js');

const standardWorkflow = {
  id: 1,
  key: 'ticket_created',
  triggerType: 'ticket.created',
  publishedDefinition: { metadata: { scheduleMode: 'standard' } },
};

const afterHoursWorkflow = {
  id: 2,
  key: 'ticket_created_after_hours',
  triggerType: 'ticket.created',
  publishedDefinition: { metadata: { scheduleMode: 'after_hours' } },
};

function context({
  eventType = 'ticket.created',
  isBusinessHours = true,
  isAfterHours = false,
  isHoliday = false,
  afterHoursEnabled = true,
  holidaysEnabled = true,
  suppressStandardTicketCreated = true,
} = {}) {
  return {
    event: { type: eventType },
    availability: {
      isBusinessHours,
      isAfterHours,
      isHoliday,
    },
    notificationPolicy: {
      afterHoursEnabled,
      holidaysEnabled,
      suppressStandardTicketCreated,
      offHoursWorkflowKey: 'ticket_created_after_hours',
    },
  };
}

describe('notification workflow policy routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses the standard ticket-created workflow during business hours', () => {
    const result = selectWorkflowsForNotificationTiming(
      [standardWorkflow, afterHoursWorkflow],
      context(),
    );

    expect(result.mode).toBe('standard');
    expect(result.selected.map((workflow) => workflow.id)).toEqual([1]);
    expect(result.suppressed.map((workflow) => workflow.id)).toEqual([2]);
  });

  test('suppresses standard ticket-created workflow after hours when policy requires replacement', () => {
    const result = selectWorkflowsForNotificationTiming(
      [standardWorkflow, afterHoursWorkflow],
      context({ isBusinessHours: false, isAfterHours: true }),
    );

    expect(result.mode).toBe('after_hours');
    expect(result.selected.map((workflow) => workflow.id)).toEqual([2]);
    expect(result.suppressed.map((workflow) => workflow.id)).toEqual([1]);
  });

  test('can run after-hours and standard workflows together when suppression is disabled', () => {
    const result = selectWorkflowsForNotificationTiming(
      [standardWorkflow, afterHoursWorkflow],
      context({
        isBusinessHours: false,
        isAfterHours: true,
        suppressStandardTicketCreated: false,
      }),
    );

    expect(result.mode).toBe('after_hours_plus_standard');
    expect(result.selected.map((workflow) => workflow.id)).toEqual([1, 2]);
    expect(result.suppressed).toEqual([]);
  });

  test('does not activate holiday routing when holidays are excluded', () => {
    const result = selectWorkflowsForNotificationTiming(
      [standardWorkflow, afterHoursWorkflow],
      context({
        isBusinessHours: false,
        isAfterHours: true,
        isHoliday: true,
        holidaysEnabled: false,
      }),
    );

    expect(result.mode).toBe('standard');
    expect(result.selected.map((workflow) => workflow.id)).toEqual([1]);
    expect(result.suppressed.map((workflow) => workflow.id)).toEqual([2]);
  });

  test('does not route non-created events through after-hours policy', () => {
    const result = selectWorkflowsForNotificationTiming(
      [standardWorkflow, afterHoursWorkflow],
      context({ eventType: 'ticket.assigned', isBusinessHours: false, isAfterHours: true }),
    );

    expect(result.mode).toBe('standard');
    expect(result.selected.map((workflow) => workflow.id)).toEqual([1, 2]);
    expect(result.suppressed).toEqual([]);
  });

  test('variant routing selects Brisbane/Australia from normalized requester region', () => {
    const brisbaneVariant = {
      id: 3,
      key: 'ticket_created_brisbane',
      name: 'Brisbane arrival',
      triggerType: 'ticket.created',
      routingMode: 'exclusive',
      routingPriority: 25,
      routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
    };

    const result = selectWorkflowVariants(
      [{ ...standardWorkflow, isDefaultVariant: true, routingPriority: 100 }, brisbaneVariant],
      { event: { type: 'ticket.created' }, requester: { regionKey: 'AU-BRISBANE' } },
    );

    expect(result.selectedWorkflowIds).toEqual([3]);
    expect(result.fallbackWorkflowId).toBeNull();
    expect(result.matched.map((workflow) => workflow.id)).toContain(3);
  });

  test('a rule-less workflow ACTS as the default when its trigger has no default variant', () => {
    // The dev self-test trap: a user's only workflow on a fresh trigger type
    // (status_changed, SLA, schedule…) has no routing rule and no default
    // sibling — it must fire, not be silently suppressed.
    const only = {
      id: 9,
      key: 'qa_status_automation',
      triggerType: 'ticket.status_changed',
      routingMode: 'exclusive',
      routingPriority: 100,
      routingRule: null,
      isDefaultVariant: false,
    };

    const result = selectWorkflowVariants([only], { event: { type: 'ticket.status_changed' } });

    expect(result.selectedWorkflowIds).toEqual([9]);
    expect(result.matched).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 9, reason: 'acting_default_no_rule' }),
    ]));

    // …but with a default sibling present, rule-less variants stay suppressed
    // (unchanged behavior).
    const withDefault = selectWorkflowVariants(
      [{ id: 1, key: 'default', triggerType: 'ticket.status_changed', isDefaultVariant: true, routingPriority: 100 }, only],
      { event: { type: 'ticket.status_changed' } },
    );
    expect(withDefault.selectedWorkflowIds).toEqual([1]);
    expect(withDefault.suppressed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 9, reason: 'missing_routing_rule' }),
    ]));
  });

  test('variant routing falls back to default when no custom variant matches', () => {
    const result = selectWorkflowVariants(
      [
        { ...standardWorkflow, isDefaultVariant: true, routingPriority: 100 },
        {
          id: 3,
          key: 'ticket_created_brisbane',
          triggerType: 'ticket.created',
          routingMode: 'exclusive',
          routingPriority: 25,
          routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
        },
      ],
      { event: { type: 'ticket.created' }, requester: { regionKey: 'CA-BC' } },
    );

    expect(result.selectedWorkflowIds).toEqual([1]);
    expect(result.fallbackWorkflowId).toBe(1);
    expect(result.suppressed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 3, reason: 'routing_rule_not_matched' }),
    ]));
  });

  test('highest-priority exclusive match wins and lower-priority match is suppressed', () => {
    const contextValue = { requester: { department: 'Brisbane' } };
    const result = selectWorkflowVariants(
      [
        { ...standardWorkflow, isDefaultVariant: true, routingPriority: 100 },
        {
          id: 3,
          key: 'ticket_created_brisbane_low',
          triggerType: 'ticket.created',
          routingMode: 'exclusive',
          routingPriority: 40,
          routingRule: { in: ['Brisbane', { var: 'requester.department' }] },
        },
        {
          id: 4,
          key: 'ticket_created_brisbane_high',
          triggerType: 'ticket.created',
          routingMode: 'exclusive',
          routingPriority: 10,
          routingRule: { in: ['Brisbane', { var: 'requester.department' }] },
        },
      ],
      contextValue,
    );

    expect(result.selectedWorkflowIds).toEqual([4]);
    expect(result.suppressed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 3, reason: 'lower_priority_exclusive_match_suppressed' }),
    ]));
  });

  test('additive variants run only when explicitly configured', () => {
    const result = selectWorkflowVariants(
      [
        { ...standardWorkflow, isDefaultVariant: true, routingPriority: 100 },
        {
          id: 3,
          key: 'ticket_created_brisbane_exclusive',
          triggerType: 'ticket.created',
          routingMode: 'exclusive',
          routingPriority: 20,
          routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
        },
        {
          id: 4,
          key: 'ticket_created_audit_copy',
          triggerType: 'ticket.created',
          routingMode: 'additive',
          routingPriority: 30,
          routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
        },
      ],
      { requester: { regionKey: 'AU-BRISBANE' } },
    );

    expect(result.selectedWorkflowIds).toEqual([3, 4]);
  });

  test('variant routing preserves after-hours replacement suppression result', () => {
    const timing = selectWorkflowsForNotificationTiming(
      [
        { ...standardWorkflow, isDefaultVariant: true, routingPriority: 100 },
        { ...afterHoursWorkflow, isDefaultVariant: true, routingPriority: 20 },
      ],
      context({ isBusinessHours: false, isAfterHours: true }),
    );
    const result = selectWorkflowVariants(timing.selected, context(), {
      baseSuppressed: timing.suppressed,
    });

    expect(timing.mode).toBe('after_hours');
    expect(result.selectedWorkflowIds).toEqual([2]);
    expect(result.suppressed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, reason: 'schedule_policy_suppressed' }),
    ]));
  });

  test('schedule preview shows the active after-hours window and the next one', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 1,
      name: 'IT',
      defaultTimezone: 'America/Los_Angeles',
    });
    prismaMock.notificationWorkflowPolicy.findUnique.mockResolvedValue(null);
    availabilityServiceMock.getBusinessHours.mockResolvedValue([
      { dayOfWeek: 1, startTime: '05:00', endTime: '17:00', isEnabled: true, timezone: 'America/Los_Angeles' },
      { dayOfWeek: 2, startTime: '05:00', endTime: '17:00', isEnabled: true, timezone: 'America/Los_Angeles' },
      { dayOfWeek: 3, startTime: '05:00', endTime: '17:00', isEnabled: true, timezone: 'America/Los_Angeles' },
      { dayOfWeek: 4, startTime: '05:00', endTime: '17:00', isEnabled: true, timezone: 'America/Los_Angeles' },
      { dayOfWeek: 5, startTime: '05:00', endTime: '17:00', isEnabled: true, timezone: 'America/Los_Angeles' },
    ]);
    availabilityServiceMock.isHoliday.mockResolvedValue({ isHoliday: false, name: null });
    availabilityServiceMock.isBusinessHours.mockResolvedValue({
      isBusinessHours: false,
      reason: 'Outside business hours (05:00 - 17:00)',
    });
    availabilityServiceMock.getNextBusinessTime.mockResolvedValue({
      nextBusinessTime: new Date('2026-06-01T12:00:00.000Z'),
      reason: 'Next business hours start at 05:00',
    });

    const preview = await getNotificationWorkflowSchedulePreview(
      1,
      { afterHoursEnabled: true, holidaysEnabled: true, suppressStandardTicketCreated: true },
      new Date('2026-05-30T04:00:00.000Z'),
    );

    expect(preview.activeNow).toBe(true);
    expect(preview.current.mode).toBe('after_hours');
    expect(preview.current.startsAtLocal).toContain('Fri, May 29, 5:00 PM');
    expect(preview.current.endsAtLocal).toContain('Mon, Jun 1, 5:00 AM');
    expect(preview.nextActiveWindow.startsAtLocal).toContain('Mon, Jun 1, 5:00 PM');
    expect(preview.upcomingActiveWindows.length).toBeGreaterThan(1);
  });
});
