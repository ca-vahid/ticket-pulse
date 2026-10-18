import { jest } from '@jest/globals';

/** Custom agent alerts (QA feedback) — matching, dedup, quiet hours; Oct 2026:
 *  several categories per alert, top category covers its subcategories, Teams. */

const prismaMock = {
  ticket: { findUnique: jest.fn() },
  agentAlertSubscription: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  agentAlertEvent: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  competencyCategory: { findMany: jest.fn() },
  ticketTag: { findMany: jest.fn() },
  technicianNotificationPreference: { findUnique: jest.fn() },
  technicianCompetency: { findMany: jest.fn().mockResolvedValue([]) },
};
const teamsMock = {
  alertReadiness: jest.fn(),
  sendAgentAlert: jest.fn(),
};
const emailMock = { sendTransactionalEmail: jest.fn() };
const resolveAgentTechnician = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/agentCompetencyService.js', () => ({ resolveAgentTechnician }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: teamsMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => emailMock);
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tp.example.com', default: () => 'https://tp.example.com' }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: agentAlertService } = await import('../src/services/agentAlertService.js');

const TECH = { id: 11, workspaceId: 1, email: 'priya.nair@example.com', name: 'Priya Nair' };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.agentAlertEvent.createMany.mockResolvedValue({ count: 1 });
  prismaMock.competencyCategory.findMany.mockReset().mockResolvedValue([]);
  prismaMock.ticketTag.findMany.mockResolvedValue([]);
  resolveAgentTechnician.mockResolvedValue({ technician: TECH });
});

describe('agentAlertService.evaluate — matching', () => {
  // Ticket in category 10 (sub 20), tag 5, priority 3 (High).
  const TICKET = {
    id: 100, workspaceId: 1, priority: 3,
    internalCategoryId: 10, internalSubcategoryId: 20,
    tagLinks: [{ tagId: 5 }],
  };

  test('buffers events only for subscriptions whose scope matches', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(TICKET);
    prismaMock.agentAlertSubscription.findMany.mockResolvedValue([
      { id: 1, technicianId: 11, categoryId: 10, tagId: null, priorityMin: null },   // matches (top category)
      { id: 2, technicianId: 12, categoryId: 20, tagId: null, priorityMin: null },   // matches (subcategory)
      { id: 3, technicianId: 13, categoryId: 99, tagId: null, priorityMin: null },   // NO — different category
      { id: 4, technicianId: 14, categoryId: null, tagId: 5, priorityMin: null },    // matches (tag)
      { id: 5, technicianId: 15, categoryId: null, tagId: 7, priorityMin: null },    // NO — different tag
      { id: 6, technicianId: 16, categoryId: 10, tagId: null, priorityMin: 4 },      // NO — needs Urgent, ticket is High
      { id: 7, technicianId: 17, categoryId: 10, tagId: 5, priorityMin: 3 },         // matches (cat AND tag AND High+)
    ]);

    await agentAlertService.evaluate('created', 100);

    expect(prismaMock.agentAlertEvent.createMany).toHaveBeenCalledTimes(1);
    const { data, skipDuplicates } = prismaMock.agentAlertEvent.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true); // dedup guard
    expect(data.map((d) => d.subscriptionId).sort()).toEqual([1, 2, 4, 7]);
    expect(data.every((d) => d.trigger === 'created' && d.priority === 3)).toBe(true);
  });

  test('only queries subscriptions with the matching trigger flag on', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(TICKET);
    prismaMock.agentAlertSubscription.findMany.mockResolvedValue([]);
    await agentAlertService.evaluate('priority_raised', 100);
    expect(prismaMock.agentAlertSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 1, isActive: true, onPriorityRaised: true }),
    }));
  });

  test('no matches → no buffer write', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(TICKET);
    prismaMock.agentAlertSubscription.findMany.mockResolvedValue([{ id: 9, technicianId: 1, categoryId: 999, tagId: null, priorityMin: null }]);
    await agentAlertService.evaluate('created', 100);
    expect(prismaMock.agentAlertEvent.createMany).not.toHaveBeenCalled();
  });

  test('unknown trigger and missing ticket are no-ops (never throw)', async () => {
    await expect(agentAlertService.evaluate('bogus', 100)).resolves.toBeUndefined();
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    await expect(agentAlertService.evaluate('created', 404)).resolves.toBeUndefined();
    expect(prismaMock.agentAlertEvent.createMany).not.toHaveBeenCalled();
  });
});

describe('agentAlertService quiet hours', () => {
  const svc = agentAlertService;
  test('daytime window: inside vs outside', () => {
    const pref = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    // Use a fixed formatter by stubbing Date via the service helper directly.
    // 02:00 local is inside a 22:00→07:00 wrap window; 12:00 is outside.
    const at = (hhmm) => {
      const orig = Intl.DateTimeFormat;
      // eslint-disable-next-line no-global-assign
      Intl.DateTimeFormat = function () { return { format: () => hhmm }; };
      const r = svc._inQuietHours(pref, 'America/Vancouver');
      Intl.DateTimeFormat = orig;
      return r;
    };
    expect(at('02:00')).toBe(true);
    expect(at('23:30')).toBe(true);
    expect(at('12:00')).toBe(false);
    expect(at('07:00')).toBe(false); // end is exclusive
  });

  test('disabled or incomplete window → never quiet', () => {
    expect(svc._inQuietHours({ quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00' })).toBe(false);
    expect(svc._inQuietHours({ quietHoursEnabled: true, quietHoursStart: null, quietHoursEnd: '07:00' })).toBe(false);
    expect(svc._inQuietHours(null)).toBe(false);
  });
});

describe('agentAlertService._normalize — several categories + Teams', () => {
  const base = { onCreated: true, channelEmail: true };

  test('categoryIds are cleaned: whole numbers, no repeats', () => {
    const d = agentAlertService._normalize({ ...base, categoryIds: ['3', 3, 5, 'x', -1, 0, 5] }, 1, 11);
    expect(d.categoryIds).toEqual([3, 5]);
    expect(d.categoryId).toBeNull(); // legacy column no longer written
  });

  test('a legacy categoryId becomes a one-item list', () => {
    const d = agentAlertService._normalize({ ...base, categoryId: '7' }, 1, 11);
    expect(d.categoryIds).toEqual([7]);
    expect(d.categoryId).toBeNull();
  });

  test('more than 40 categories is refused in plain words', () => {
    const many = Array.from({ length: 41 }, (_, i) => i + 1);
    expect(() => agentAlertService._normalize({ ...base, categoryIds: many }, 1, 11)).toThrow(/up to 40 categories/);
  });

  test('Teams on its own counts as a channel', () => {
    const d = agentAlertService._normalize({ ...base, channelEmail: false, channelTeams: true, priorityMin: 4 }, 1, 11);
    expect(d.channelTeams).toBe(true);
    expect(d.channelEmail).toBe(false);
  });

  test('no channel at all, or nothing to match, is refused', () => {
    expect(() => agentAlertService._normalize({ ...base, channelEmail: false, priorityMin: 4 }, 1, 11)).toThrow(/one way to be alerted/);
    expect(() => agentAlertService._normalize({ ...base, categoryIds: [] }, 1, 11)).toThrow(/every ticket/);
  });
});

describe('agentAlertService create / update — category checks', () => {
  test('create refuses a category that is not live in the workspace', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValueOnce([{ id: 3 }]); // 9 is missing
    await expect(agentAlertService.create(TECH.email, 1, { onCreated: true, channelEmail: true, categoryIds: [3, 9] }))
      .rejects.toThrow(/no longer in use/);
    expect(prismaMock.competencyCategory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [3, 9] }, workspaceId: 1, isActive: true },
    }));
    expect(prismaMock.agentAlertSubscription.create).not.toHaveBeenCalled();
  });

  test('create writes the list and Teams flag', async () => {
    prismaMock.competencyCategory.findMany
      .mockResolvedValueOnce([{ id: 3 }, { id: 9 }]) // validation
      .mockResolvedValue([{ id: 3, name: 'Devices & Hardware', parentId: null }, { id: 9, name: 'RDP', parentId: 4 }]);
    prismaMock.agentAlertSubscription.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
    const out = await agentAlertService.create(TECH.email, 1, { onCreated: true, channelTeams: true, channelEmail: false, categoryIds: [3, 9] });
    const { data } = prismaMock.agentAlertSubscription.create.mock.calls[0][0];
    expect(data).toEqual(expect.objectContaining({ categoryIds: [3, 9], categoryId: null, channelTeams: true }));
    expect(out.categoryIds).toEqual([3, 9]);
    expect(out.channelTeams).toBe(true);
  });

  test('pausing an old single-category alert converts it and skips re-checking its category', async () => {
    prismaMock.agentAlertSubscription.findFirst.mockResolvedValue({
      id: 5, workspaceId: 1, technicianId: 11, categoryId: 12, categoryIds: [], tagId: null, priorityMin: null,
      onCreated: true, channelEmail: true, isActive: true,
    });
    prismaMock.agentAlertSubscription.update.mockImplementation(async ({ data }) => ({ id: 5, ...data }));
    await agentAlertService.update(TECH.email, 1, 5, { isActive: false });
    const { data } = prismaMock.agentAlertSubscription.update.mock.calls[0][0];
    expect(data).toEqual(expect.objectContaining({ categoryIds: [12], categoryId: null, isActive: false }));
    // The only findMany calls are name lookups, never a validation of id 12.
    const validation = prismaMock.competencyCategory.findMany.mock.calls.find(([q]) => q.where?.isActive === true);
    expect(validation).toBeUndefined();
  });

  test('an explicit empty list clears a legacy category', async () => {
    prismaMock.agentAlertSubscription.findFirst.mockResolvedValue({
      id: 6, workspaceId: 1, technicianId: 11, categoryId: 12, categoryIds: [], tagId: null, priorityMin: 4,
      onCreated: true, channelEmail: true, isActive: true,
    });
    prismaMock.agentAlertSubscription.update.mockImplementation(async ({ data }) => ({ id: 6, ...data }));
    await agentAlertService.update(TECH.email, 1, 6, { categoryIds: [] });
    const { data } = prismaMock.agentAlertSubscription.update.mock.calls[0][0];
    expect(data.categoryIds).toEqual([]);
    expect(data.categoryId).toBeNull();
  });
});

describe('agentAlertService.evaluate — category lists', () => {
  // Ticket in top category 10, subcategory 20.
  const TICKET = { id: 200, workspaceId: 1, priority: 2, internalCategoryId: 10, internalSubcategoryId: 20, tagLinks: [] };

  test('a top category covers its subcategories; a sibling sub does not; legacy rows still match', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(TICKET);
    prismaMock.agentAlertSubscription.findMany.mockResolvedValue([
      { id: 1, technicianId: 11, categoryId: null, categoryIds: [10], tagId: null, priorityMin: null },      // top → matches
      { id: 2, technicianId: 12, categoryId: null, categoryIds: [21], tagId: null, priorityMin: null },      // sibling sub → no
      { id: 3, technicianId: 13, categoryId: 10, categoryIds: [], tagId: null, priorityMin: null },          // legacy → matches
      { id: 4, technicianId: 14, categoryId: null, categoryIds: [55, 20], tagId: null, priorityMin: null },  // one of several → matches
      { id: 5, technicianId: 15, categoryId: null, categoryIds: [55, 66], tagId: null, priorityMin: null },  // none → no
    ]);
    await agentAlertService.evaluate('created', 200);
    const { data } = prismaMock.agentAlertEvent.createMany.mock.calls[0][0];
    expect(data.map((d) => d.subscriptionId).sort()).toEqual([1, 3, 4]);
    expect(prismaMock.agentAlertSubscription.findMany.mock.calls[0][0].select).toEqual(expect.objectContaining({ categoryIds: true }));
  });
});

describe('agentAlertService._deliver — Teams', () => {
  const SUB = {
    id: 9, workspaceId: 1, label: 'Hardware watch', categoryIds: [10], categoryId: null, tagId: null, priorityMin: null,
    channelEmail: true, channelSms: false, channelWhatsapp: false, channelPhone: false, channelTeams: true,
    technician: TECH,
  };
  const EVENTS = [{ trigger: 'created' }, { trigger: 'created' }];
  const TICKETS = [
    { id: 301, subject: 'Laptop [screen] flickers', origin: 'ticketpulse', nativeNumber: 41, priority: 3, status: 'Open' },
    { id: 302, subject: 'Dock not charging', origin: 'freshservice', freshserviceTicketId: 9001, priority: 2, status: 'Open' },
  ];

  test('sends one Teams message with the batch, and the e-mail too', async () => {
    teamsMock.sendAgentAlert.mockResolvedValue({ sent: true, via: 'teams' });
    emailMock.sendTransactionalEmail.mockResolvedValue({ sent: true });
    const out = await agentAlertService._deliver(SUB, null, EVENTS, TICKETS);
    expect(teamsMock.sendAgentAlert).toHaveBeenCalledTimes(1);
    const arg = teamsMock.sendAgentAlert.mock.calls[0][0];
    expect(arg.workspaceId).toBe(1);
    expect(arg.technician).toBe(TECH);
    expect(arg.title).toMatch(/^2 new tickets in Hardware watch/);
    expect(arg.lines).toHaveLength(2);
    expect(arg.lines[0]).toMatch(/^\[TP-41\]\(https:\/\/tp\.example\.com\/.+\) — Laptop screen flickers \(High\)$/);
    expect(out.channels.teams).toEqual({ sent: true, via: 'teams' });
    expect(out.channels.email).toEqual({ sent: true });
  });

  test('a Teams failure does not stop the e-mail', async () => {
    teamsMock.sendAgentAlert.mockRejectedValue(new Error('bot down'));
    emailMock.sendTransactionalEmail.mockResolvedValue({ sent: true });
    const out = await agentAlertService._deliver(SUB, null, EVENTS, TICKETS);
    expect(out.channels.teams).toEqual(expect.objectContaining({ sent: false, error: 'bot down' }));
    expect(emailMock.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(out.channels.email.sent).toBe(true);
  });

  test('no Teams call when the alert does not ask for it', async () => {
    emailMock.sendTransactionalEmail.mockResolvedValue({ sent: true });
    await agentAlertService._deliver({ ...SUB, channelTeams: false }, null, EVENTS, TICKETS);
    expect(teamsMock.sendAgentAlert).not.toHaveBeenCalled();
  });
});

describe('agentAlertService.options — tree + Teams readiness', () => {
  test('returns tops with their subcategories and the Teams state', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 1, name: 'Devices & Hardware', parentId: null },
      { id: 2, name: 'Account & Access', parentId: null },
      { id: 3, name: 'Laptops', parentId: 1 },
      { id: 4, name: 'RDP', parentId: 2 },
      { id: 5, name: 'Orphan sub', parentId: 99 }, // parent retired
    ]);
    teamsMock.alertReadiness.mockResolvedValue({ available: true, connected: true });
    prismaMock.technicianCompetency.findMany.mockResolvedValueOnce([{ competencyCategoryId: 3 }, { competencyCategoryId: 777 }]);
    const out = await agentAlertService.options(TECH.email, 1);
    expect(out.mine).toEqual([3]); // only live categories
    expect(out.tree).toEqual([
      { id: 1, name: 'Devices & Hardware', children: [{ id: 3, name: 'Laptops' }] },
      { id: 2, name: 'Account & Access', children: [{ id: 4, name: 'RDP' }] },
      { id: 5, name: 'Orphan sub', children: [] },
    ]);
    expect(out.categories.find((c) => c.id === 4).path).toBe('Account & Access › RDP');
    expect(out.teams).toEqual({ available: true, connected: true });
    expect(teamsMock.alertReadiness).toHaveBeenCalledWith(1, TECH.email);
  });

  test('a readiness failure reads as "not available", never an error', async () => {
    teamsMock.alertReadiness.mockRejectedValue(new Error('no config'));
    const out = await agentAlertService.options(TECH.email, 1);
    expect(out.teams).toEqual({ available: false, connected: false });
  });
});

describe('agentAlertService.list — shaped categories', () => {
  test('resolves names + paths and summarises in the computed label', async () => {
    prismaMock.agentAlertSubscription.findMany.mockResolvedValue([
      { id: 1, label: null, categoryIds: [1, 4], categoryId: null, tagId: null, priorityMin: null, channelTeams: true, isActive: true },
      { id: 2, label: null, categoryIds: [1, 3, 4], categoryId: null, tagId: null, priorityMin: 4, isActive: true },
      { id: 3, label: null, categoryIds: [], categoryId: 3, tagId: null, priorityMin: null, isActive: true }, // legacy
    ]);
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(null);
    prismaMock.competencyCategory.findMany
      .mockResolvedValueOnce([
        { id: 1, name: 'Devices & Hardware', parentId: null },
        { id: 3, name: 'Laptops', parentId: 1 },
        { id: 4, name: 'RDP', parentId: 2 },
      ])
      .mockResolvedValueOnce([{ id: 2, name: 'Account & Access' }]); // parent lookup
    const out = await agentAlertService.list(TECH.email, 1);
    const [a, b, c] = out.subscriptions;
    expect(a.categories).toEqual([
      { id: 1, name: 'Devices & Hardware', path: 'Devices & Hardware' },
      { id: 4, name: 'RDP', path: 'Account & Access › RDP' },
    ]);
    expect(a.computedLabel).toBe('Devices & Hardware, Account & Access › RDP');
    expect(a.channelTeams).toBe(true);
    expect(b.computedLabel).toBe('3 categories · Urgent+');
    expect(c.categoryIds).toEqual([3]);
    expect(c.computedLabel).toBe('Devices & Hardware › Laptops');
  });
});
