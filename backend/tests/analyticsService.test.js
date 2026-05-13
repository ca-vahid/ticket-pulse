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

  test('buildCategoryIntelligence gives category-only canonical tickets a child bucket', () => {
    const rangeInfo = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles', compare: 'none' },
      new Date('2026-04-26T19:00:00.000Z'),
    );
    const base = {
      status: 'Open',
      createdAt: new Date('2026-04-21T16:00:00.000Z'),
      internalCategoryId: 10,
      internalCategory: { id: 10, name: 'Identity' },
      assignedTech: { id: 9, name: 'Tech One' },
      taxonomyReviewNeeded: false,
    };
    const categoryOnly = {
      ...base,
      id: 10,
      freshserviceTicketId: 1010n,
      subject: 'Needs category cleanup',
      internalSubcategoryId: null,
      internalSubcategory: null,
    };
    const subcategoryTicket = {
      ...base,
      id: 11,
      freshserviceTicketId: 1011n,
      subject: 'MFA reset',
      internalSubcategoryId: 11,
      internalSubcategory: { id: 11, name: 'MFA', parentId: 10 },
    };

    const result = buildCategoryIntelligence({
      workspaceId: 1,
      rangeInfo,
      categoryMode: 'canonical',
      createdTickets: [categoryOnly, subcategoryTicket],
      assignedTickets: [],
      openTickets: [],
      previousCreatedTickets: [],
      pipelineRuns: [],
      serviceAccountNames: [],
    });

    expect(result.hierarchy).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'category:10:no-subcategory',
        parent: 'category:10',
        name: 'No subcategory',
        value: 1,
        custom: expect.objectContaining({
          key: 'category:10:no-subcategory',
          agentLeafKeys: expect.arrayContaining(['category:10']),
          nodeType: 'categoryOnly',
        }),
      }),
      expect.objectContaining({
        id: 'subcategory:11',
        parent: 'category:10',
        name: 'MFA',
        value: 1,
      }),
    ]));
    expect(result.hierarchy.filter((node) => node.id === 'category:10')).toHaveLength(1);
  });

  test('buildCategoryIntelligence keeps standalone legacy fallback counts out of canonical treemap hierarchy', () => {
    const rangeInfo = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles', compare: 'none' },
      new Date('2026-04-26T19:00:00.000Z'),
    );
    const ticket = {
      id: 12,
      freshserviceTicketId: 1012n,
      subject: 'Legacy-only analytics row',
      status: 'Open',
      createdAt: new Date('2026-04-21T16:00:00.000Z'),
      ticketCategory: 'Software & Apps',
      assignedTech: null,
      taxonomyReviewNeeded: false,
    };

    const result = buildCategoryIntelligence({
      workspaceId: 1,
      rangeInfo,
      categoryMode: 'canonical',
      createdTickets: [ticket],
      assignedTickets: [],
      openTickets: [],
      previousCreatedTickets: [],
      pipelineRuns: [],
      serviceAccountNames: [],
    });

    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'category-label:Software & Apps',
        name: 'Software & Apps',
        source: 'legacyFallback',
        created: 1,
      }),
    ]));
    expect(result.hierarchy.some((node) => node.id === 'legacy-fallback')).toBe(false);
    expect(result.hierarchy.some((node) => node.id === 'category-label:Software & Apps')).toBe(false);
  });

  test('buildCategoryIntelligence does not merge legacy fallback rows into canonical treemap parents', () => {
    const rangeInfo = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles', compare: 'none' },
      new Date('2026-04-26T19:00:00.000Z'),
    );
    const canonicalTicket = {
      id: 13,
      freshserviceTicketId: 1013n,
      subject: 'MFA reset',
      status: 'Open',
      createdAt: new Date('2026-04-21T16:00:00.000Z'),
      internalCategoryId: 10,
      internalCategory: { id: 10, name: 'Identity' },
      internalSubcategoryId: 11,
      internalSubcategory: { id: 11, name: 'MFA', parentId: 10 },
      assignedTech: null,
      taxonomyReviewNeeded: false,
    };
    const fallbackTicket = {
      id: 14,
      freshserviceTicketId: 1014n,
      subject: 'Legacy identity row',
      status: 'Open',
      createdAt: new Date('2026-04-21T16:00:00.000Z'),
      ticketCategory: 'Identity',
      assignedTech: null,
      taxonomyReviewNeeded: false,
    };

    const result = buildCategoryIntelligence({
      workspaceId: 1,
      rangeInfo,
      categoryMode: 'canonical',
      createdTickets: [canonicalTicket, fallbackTicket],
      assignedTickets: [],
      openTickets: [],
      previousCreatedTickets: [],
      pipelineRuns: [],
      serviceAccountNames: [],
    });

    expect(result.hierarchy.filter((node) => node.id === 'category:10')).toHaveLength(1);
    expect(result.hierarchy.some((node) => node.id === 'category-label:Identity')).toBe(false);
    expect(result.hierarchy.some((node) => node.id === 'category:10:no-subcategory')).toBe(false);
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'category-label:Identity',
        source: 'legacyFallback',
        created: 1,
      }),
    ]));
  });

  test('buildCategoryIntelligence keeps unmapped counts out of canonical treemap hierarchy', () => {
    const rangeInfo = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles', compare: 'none' },
      new Date('2026-04-26T19:00:00.000Z'),
    );
    const canonicalTicket = {
      id: 15,
      freshserviceTicketId: 1015n,
      subject: 'MFA reset',
      status: 'Open',
      createdAt: new Date('2026-04-21T16:00:00.000Z'),
      internalCategoryId: 10,
      internalCategory: { id: 10, name: 'Identity' },
      internalSubcategoryId: 11,
      internalSubcategory: { id: 11, name: 'MFA', parentId: 10 },
      assignedTech: null,
      taxonomyReviewNeeded: false,
    };
    const unmappedTicket = {
      id: 16,
      freshserviceTicketId: 1016n,
      subject: 'Missing category fields',
      status: 'Open',
      createdAt: new Date('2026-04-21T17:00:00.000Z'),
      ticketCategory: null,
      internalCategoryId: null,
      internalCategory: null,
      internalSubcategoryId: null,
      internalSubcategory: null,
      assignedTech: null,
      taxonomyReviewNeeded: false,
    };

    const result = buildCategoryIntelligence({
      workspaceId: 1,
      rangeInfo,
      categoryMode: 'canonical',
      createdTickets: [canonicalTicket, unmappedTicket],
      assignedTickets: [],
      openTickets: [],
      previousCreatedTickets: [],
      pipelineRuns: [],
      serviceAccountNames: [],
    });

    expect(result.summary.unmapped).toBe(1);
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'category-label:Uncategorized',
        name: 'Uncategorized',
        source: 'unmapped',
        created: 1,
      }),
    ]));
    expect(result.hierarchy).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'category:10', name: 'Identity' }),
      expect.objectContaining({ id: 'subcategory:11', parent: 'category:10', name: 'MFA' }),
    ]));
    expect(result.hierarchy.some((node) => node.id === 'category-label:Uncategorized')).toBe(false);
    expect(result.hierarchy.some((node) => node.parent === 'category-label:Uncategorized')).toBe(false);
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

  test('buildCategoryIntelligence excludes zero-created rows from treemap hierarchy', () => {
    const rangeInfo = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles', compare: 'none' },
      new Date('2026-04-26T19:00:00.000Z'),
    );
    const openOnlyTicket = {
      id: 50,
      freshserviceTicketId: 2050n,
      subject: 'Open from earlier range',
      status: 'Open',
      createdAt: new Date('2026-03-01T16:00:00.000Z'),
      internalCategoryId: 30,
      internalCategory: { id: 30, name: 'Historical Open' },
      internalSubcategoryId: 31,
      internalSubcategory: { id: 31, name: 'No created demand', parentId: 30 },
      assignedTech: null,
      taxonomyReviewNeeded: false,
    };

    const result = buildCategoryIntelligence({
      workspaceId: 1,
      rangeInfo,
      categoryMode: 'canonical',
      createdTickets: [],
      assignedTickets: [],
      openTickets: [openOnlyTicket],
      previousCreatedTickets: [],
      pipelineRuns: [],
      serviceAccountNames: [],
    });

    expect(result.rows[0]).toMatchObject({
      name: 'Historical Open / No created demand',
      created: 0,
      open: 1,
    });
    expect(result.hierarchy).toHaveLength(0);
  });
});
