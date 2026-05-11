import {
  buildCategoryIntelligence,
  buildInsight,
  categoryBreakdownFromTickets,
  categoryFilterForQuery,
  calculateDelta,
  parseAnalyticsRange,
  summarizeNumeric,
} from '../src/services/analyticsService.js';

describe('analyticsService pure helpers', () => {
  test('parseAnalyticsRange defaults to a 30-day window with previous comparison', () => {
    const range = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles' },
      new Date('2026-04-26T19:00:00.000Z'),
    );

    expect(range.range).toBe('30d');
    expect(range.groupBy).toBe('day');
    expect(range.compare).toBe('previous');
    expect(range.startDate).toBe('2026-03-28');
    expect(range.endDate).toBe('2026-04-26');
    expect(range.previousStartDate).toBe('2026-02-26');
    expect(range.previousEndDate).toBe('2026-03-27');
  });

  test('parseAnalyticsRange accepts custom ranges and swaps reversed dates safely', () => {
    const range = parseAnalyticsRange({
      range: 'custom',
      start: '2026-04-15',
      end: '2026-04-01',
      timezone: 'America/Vancouver',
      groupBy: 'week',
      compare: 'none',
    });

    expect(range.startDate).toBe('2026-04-01');
    expect(range.endDate).toBe('2026-04-15');
    expect(range.groupBy).toBe('week');
    expect(range.compare).toBe('none');
  });

  test('calculateDelta preserves null percent when previous period is zero', () => {
    expect(calculateDelta(12, 0)).toEqual({
      current: 12,
      previous: 0,
      change: 12,
      pct: null,
    });
  });

  test('summarizeNumeric ignores invalid values and returns stable percentiles', () => {
    expect(summarizeNumeric([30, null, 10, -1, Number.NaN, 20, 40])).toEqual({
      count: 4,
      avg: 25,
      median: 20,
      p90: 40,
      min: 10,
      max: 40,
    });
  });

  test('buildInsight returns explainable deterministic card shape', () => {
    const insight = buildInsight({
      id: 'overdue-risk',
      title: 'Open tickets are past due',
      severity: 'warning',
      rule: 'Open/Pending tickets with dueBy earlier than now.',
      evidenceCount: 3,
      affected: ['Current open queue'],
      drilldown: [{ id: 1 }],
    });

    expect(insight).toMatchObject({
      id: 'overdue-risk',
      severity: 'warning',
      evidenceCount: 3,
      affected: ['Current open queue'],
      drilldown: [{ id: 1 }],
    });
    expect(insight.rule).toContain('dueBy');
  });

  test('categoryFilterForQuery gates canonical filters to IT workspace', () => {
    expect(categoryFilterForQuery(1, { categoryIds: '10,11', subcategoryIds: '22' })).toMatchObject({
      mode: 'canonical',
      where: {
        OR: [
          { internalCategoryId: { in: [10, 11] } },
          { internalSubcategoryId: { in: [22] } },
        ],
      },
    });

    expect(categoryFilterForQuery(2, { categoryIds: '10', legacyCategories: 'BST,GIS' })).toMatchObject({
      mode: 'legacy',
      where: { ticketCategory: { in: ['BST', 'GIS'] } },
    });
  });

  test('categoryBreakdownFromTickets reports canonical, fallback, review-needed, and unmapped coverage', () => {
    const result = categoryBreakdownFromTickets([
      {
        internalCategoryId: 1,
        internalCategory: { id: 1, name: 'Security' },
        internalSubcategoryId: 2,
        internalSubcategory: { id: 2, name: 'Advisory' },
        taxonomyReviewNeeded: false,
      },
      {
        tpSkill: 'Endpoint',
        tpSubskill: 'Laptop',
        ticketCategory: 'Legacy endpoint',
        taxonomyReviewNeeded: true,
      },
      {
        ticketCategory: null,
        taxonomyReviewNeeded: false,
      },
    ], 10, 1);

    expect(result.coverage).toMatchObject({
      canonical: 1,
      legacyFallback: 1,
      reviewNeeded: 1,
      unmapped: 1,
      total: 3,
    });
    expect(result.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      'Security / Advisory',
      'Endpoint / Laptop',
      'Uncategorized',
    ]));
  });

  test('buildCategoryIntelligence returns canonical category and subcategory metrics', () => {
    const rangeInfo = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles', compare: 'previous' },
      new Date('2026-04-26T19:00:00.000Z'),
    );
    const baseTicket = {
      id: 1,
      freshserviceTicketId: 1001n,
      subject: 'MFA reset',
      status: 'Closed',
      priority: 2,
      source: 1,
      createdAt: new Date('2026-04-20T16:00:00.000Z'),
      firstAssignedAt: new Date('2026-04-20T16:30:00.000Z'),
      dueBy: new Date('2026-04-22T16:00:00.000Z'),
      assignedBy: 'Ticket Pulse Bot',
      assignedTech: { id: 9, name: 'Tech One' },
      isSelfPicked: false,
      internalCategoryId: 10,
      internalCategory: { id: 10, name: 'Identity' },
      internalSubcategoryId: 11,
      internalSubcategory: { id: 11, name: 'MFA', parentId: 10 },
      taxonomyReviewNeeded: true,
      resolutionTimeSeconds: 7200,
      csatScore: 4,
      csatTotalScore: 4,
      requester: { name: 'Requester', email: 'requester@example.test' },
    };

    const result = buildCategoryIntelligence({
      workspaceId: 1,
      rangeInfo,
      categoryMode: 'canonical',
      createdTickets: [baseTicket],
      assignedTickets: [baseTicket],
      openTickets: [{ ...baseTicket, status: 'Open', dueBy: new Date('2026-04-01T00:00:00.000Z') }],
      previousCreatedTickets: [{ ...baseTicket, createdAt: new Date('2026-03-25T16:00:00.000Z') }],
      pipelineRuns: [{ status: 'failed', errorMessage: 'sync failed', triggerSource: 'poll', ticket: baseTicket }],
      serviceAccountNames: ['ticket pulse bot'],
    });

    expect(result.summary).toMatchObject({
      categoryMode: 'canonical',
      totalCreated: 1,
      totalAssigned: 1,
      open: 1,
      overdue: 1,
      automationFailures: 1,
    });
    expect(result.rows[0]).toMatchObject({
      name: 'Identity / MFA',
      categoryName: 'Identity',
      subcategoryName: 'MFA',
      created: 1,
      assigned: 1,
      open: 1,
      p90ResolutionHours: 2,
      csatAverage: 4,
      automationFailureRatePct: 100,
    });
    expect(result.rows[0].assignmentMix.appAssigned).toBe(1);
    expect(result.hierarchy.map((node) => node.name)).toEqual(expect.arrayContaining(['Identity', 'MFA']));
    expect(result.hierarchy.some((node) => node.name === 'Categories')).toBe(false);
    expect(result.hierarchy.find((node) => node.name === 'Identity')).toMatchObject({
      custom: {
        nodeType: 'category',
        created: 1,
        open: 1,
      },
    });
    expect(result.agentLens[0]).toMatchObject({
      technicianId: 9,
      name: 'Tech One',
      totalCreated: 1,
      teamSharePct: 100,
      topCategories: [{ key: 'category:10', name: 'Identity', count: 1 }],
      categories: [{ key: 'subcategory:11', name: 'Identity / MFA', count: 1 }],
    });
    expect(result.assignmentFlow).toEqual(expect.arrayContaining([
      { from: 'Ticket Pulse assigned', to: 'Identity', weight: 1 },
      { from: 'Identity', to: 'Automation failed', weight: 1 },
    ]));
    expect(result.assignmentFlow.some((row) => row.to === 'Identity / MFA' || row.from === 'Identity / MFA')).toBe(false);
  });

  test('buildCategoryIntelligence hides subcategory semantics for legacy workspaces', () => {
    const rangeInfo = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles', compare: 'none' },
      new Date('2026-04-26T19:00:00.000Z'),
    );
    const ticket = {
      id: 2,
      freshserviceTicketId: 1002n,
      subject: 'Legacy category ticket',
      status: 'Open',
      createdAt: new Date('2026-04-21T16:00:00.000Z'),
      firstAssignedAt: null,
      ticketCategory: 'Hardware',
      assignedTech: null,
      taxonomyReviewNeeded: false,
    };

    const result = buildCategoryIntelligence({
      workspaceId: 2,
      rangeInfo,
      categoryMode: 'legacy',
      createdTickets: [ticket],
      assignedTickets: [],
      openTickets: [ticket],
      previousCreatedTickets: [],
      pipelineRuns: [],
      serviceAccountNames: [],
    });

    expect(result.summary.categoryMode).toBe('legacy');
    expect(result.rows[0]).toMatchObject({
      name: 'Hardware',
      categoryName: 'Hardware',
      subcategoryName: null,
      created: 1,
      open: 1,
    });
    expect(result.hierarchy).toHaveLength(1);
    expect(result.hierarchy[0]).toMatchObject({
      name: 'Hardware',
      custom: {
        nodeType: 'category',
        created: 1,
        open: 1,
      },
    });
  });

  test('buildCategoryIntelligence groups tiny canonical treemap leaves', () => {
    const rangeInfo = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles', compare: 'none' },
      new Date('2026-04-26T19:00:00.000Z'),
    );
    const makeTicket = (id, subcategoryId, subcategoryName) => ({
      id,
      freshserviceTicketId: BigInt(2000 + id),
      subject: subcategoryName,
      status: 'Open',
      createdAt: new Date('2026-04-21T16:00:00.000Z'),
      internalCategoryId: 20,
      internalCategory: { id: 20, name: 'Service Desk & Routing' },
      internalSubcategoryId: subcategoryId,
      internalSubcategory: { id: subcategoryId, name: subcategoryName, parentId: 20 },
      assignedTech: null,
      taxonomyReviewNeeded: false,
    });

    const result = buildCategoryIntelligence({
      workspaceId: 1,
      rangeInfo,
      categoryMode: 'canonical',
      createdTickets: [
        makeTicket(1, 21, 'Tiny A'),
        makeTicket(2, 22, 'Tiny B'),
      ],
      assignedTickets: [],
      openTickets: [],
      previousCreatedTickets: [],
      pipelineRuns: [],
      serviceAccountNames: [],
    });

    expect(result.hierarchy).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'category:20:other-small',
        name: 'Other subcategories',
        value: 2,
        custom: expect.objectContaining({
          nodeType: 'subcategoryGroup',
          groupedCount: 2,
          groupedNames: ['Tiny A', 'Tiny B'],
        }),
      }),
    ]));
    expect(result.hierarchy.some((node) => node.name === 'Tiny A')).toBe(false);
    expect(result.hierarchy.some((node) => node.name === 'Tiny B')).toBe(false);
  });
});
