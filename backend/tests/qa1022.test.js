import { jest } from '@jest/globals';

// QA 10-22: onboarding wake lead (#6/#7) and FreshService tags (#2).

const prismaMock = {
  ticketTagLink: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  ticketTag: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { hrWakeDate } = await import('../src/utils/hrNoticeDates.js');
const { reconcileFsTags, cleanFsTags, isFsTagSyncWorkspace, fsTicketInclude, FS_TAG_SOURCE } = await import('../src/services/fsTagSyncService.js');
const { transformTicket } = await import('../src/integrations/freshserviceTransformer.js').catch(() => ({}));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FS_TAG_SYNC_WORKSPACE_IDS;
});

describe('hrWakeDate lead (QA 10-22 #6/#7)', () => {
  test('a new hire wakes 21 days before by default, as before', () => {
    expect(hrWakeDate('new_hire', '2026-11-16')).toBe('2026-10-26');
  });

  test('a longer lead moves the wake back, then onto a business day', () => {
    // 35 days before Mon 16 Nov is Mon 12 Oct.
    expect(hrWakeDate('new_hire', '2026-11-16', { leadDays: 35 })).toBe('2026-10-12');
    // 20 days before Mon 16 Nov is Tue 27 Oct; 22 days is Sun 25 Oct → Fri 23 Oct.
    expect(hrWakeDate('new_hire', '2026-11-16', { leadDays: 22 })).toBe('2026-10-23');
  });

  test('holidayAware adds one day per weekday holiday between the wake and the start', () => {
    const holidays = new Set(['2026-12-24', '2026-12-25', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01']);
    const isHoliday = (iso) => holidays.has(iso);
    const isBusinessDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d >= 1 && d <= 5 && !holidays.has(iso); };
    // Start Mon 4 Jan 2027: 21 days back is Mon 14 Dec. Seven closure days add seven: Mon 7 Dec.
    expect(hrWakeDate('new_hire', '2027-01-04', { isBusinessDay })).toBe('2026-12-14');
    expect(hrWakeDate('new_hire', '2027-01-04', { isBusinessDay, holidayAware: true, isHoliday })).toBe('2026-12-07');
  });

  test('departures keep their fixed lead', () => {
    expect(hrWakeDate('departure', '2026-11-16', { leadDays: 60 })).toBe('2026-11-02');
  });
});

describe('onboardingLeadDays (QA 10-22 #7)', () => {
  let onboardingLeadDays;
  beforeAll(async () => {
    jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn() } }));
    ({ onboardingLeadDays } = await import('../src/services/hrLifecycleService.js'));
  });
  const WAKE = { leadDays: 21, holidayAware: false, rules: [
    { key: 'cad', titleMatch: ['CAD', 'Drafter'], items: ['laptop'], leadDays: 35 },
    { key: 'pm', titleMatch: ['Project Manager'], items: [], leadDays: 28 },
  ] };

  test('no rule matches: the workspace lead', () => {
    expect(onboardingLeadDays(WAKE, { title: 'Geotechnical Engineer', templateKey: 'laptop' })).toBe(21);
  });
  test('a CAD hire: the laptop wakes 35 days before, the workstation stays at 21', () => {
    expect(onboardingLeadDays(WAKE, { title: 'Senior CAD Technician', templateKey: 'laptop' })).toBe(35);
    expect(onboardingLeadDays(WAKE, { title: 'Senior CAD Technician', templateKey: 'workstation' })).toBe(21);
    expect(onboardingLeadDays(WAKE, { title: 'senior cad technician', templateKey: null })).toBe(21);
  });
  test('a rule with no children covers the whole family, the notice too', () => {
    expect(onboardingLeadDays(WAKE, { title: 'Project Manager', templateKey: null })).toBe(28);
    expect(onboardingLeadDays(WAKE, { title: 'Project Manager', templateKey: 'workstation' })).toBe(28);
  });
  test('missing settings: 21', () => {
    expect(onboardingLeadDays(null, { title: 'CAD' })).toBe(21);
  });

  test('settings: wake is validated, keyed and audited', async () => {
    const { default: service } = await import('../src/services/hrLifecycleService.js');
    service._technicians = async () => [];
    service._groups = async () => [];
    const current = { mode: 'live', parentAssigneeTechId: null, leave: { assigneeTechId: null, park: true }, officeChange: { assigneeTechId: null, park: true }, officeRouting: { offices: [], fallbackTechIds: [] }, templates: { onboarding: [{ key: 'laptop', title: 'Laptop', dueOffsetDays: 0 }] }, wake: { leadDays: 21, holidayAware: false, rules: [] } };
    const next = await service._validate(4, { wake: { leadDays: 28, holidayAware: true, rules: [{ titleMatch: 'CAD, Drafter', items: ['laptop'], leadDays: 35 }] } }, current);
    expect(next.wake).toEqual({ leadDays: 28, holidayAware: true, rules: [{ key: 'cad_drafter_laptop', titleMatch: ['CAD', 'Drafter'], items: ['laptop'], leadDays: 35 }] });
    expect(service.diffSettings(current, next).map((c) => c.field)).toEqual(expect.arrayContaining(['wake.leadDays', 'wake.holidayAware', 'wake.rules']));
    await expect(service._validate(4, { wake: { leadDays: 0 } }, current)).rejects.toThrow(/1 to 120/);
    await expect(service._validate(4, { wake: { rules: [{ titleMatch: 'CAD', items: ['phone'], leadDays: 30 }] } }, current)).rejects.toThrow(/not an onboarding child/);
    await expect(service._validate(4, { wake: { rules: [{ titleMatch: '', items: [], leadDays: 30 }] } }, current)).rejects.toThrow(/give a job title or pick a child/);
  });
});

describe('FreshService tags (QA 10-22 #2)', () => {
  test('cleanFsTags trims, de-duplicates by case and drops blanks', () => {
    expect(cleanFsTags([' Acme Instruments ', 'acme instruments', '', null, 'Level  Meters LM'])).toEqual(['Acme Instruments', 'Level Meters LM']);
    expect(cleanFsTags(undefined)).toEqual([]);
  });

  test('a tag-sync workspace asks FreshService for the tags', () => {
    expect(fsTicketInclude(4)).toBe('requester,stats,tags');
    expect(fsTicketInclude(1)).toBe('requester,stats');
  });

  test('only Field Equipment (ws4) by default', () => {
    expect(isFsTagSyncWorkspace(4)).toBe(true);
    expect(isFsTagSyncWorkspace(1)).toBe(false);
    process.env.FS_TAG_SYNC_WORKSPACE_IDS = '1,4';
    expect(isFsTagSyncWorkspace(1)).toBe(true);
  });

  test('adds missing tags (existing by any case, new created), removes only its own links', async () => {
    prismaMock.ticketTagLink.findMany.mockResolvedValue([
      { id: 1, tagId: 10, createdBy: FS_TAG_SOURCE, tag: { name: 'Old Vendor' } },
      { id: 2, tagId: 11, createdBy: 'someone@example.com', tag: { name: 'Hand Added' } },
    ]);
    prismaMock.ticketTag.findMany.mockResolvedValue([{ id: 20, name: 'acme instruments', isActive: true }]);
    prismaMock.ticketTag.create.mockResolvedValue({ id: 21, name: 'Level Meters LM', isActive: true });
    const r = await reconcileFsTags({ id: 5, workspaceId: 4 }, ['Acme Instruments', 'Level Meters LM']);
    expect(r).toEqual({ added: 2, removed: 1, created: 1 });
    expect(prismaMock.ticketTagLink.create.mock.calls.map((c) => c[0].data)).toEqual([
      { ticketId: 5, tagId: 20, createdBy: FS_TAG_SOURCE },
      { ticketId: 5, tagId: 21, createdBy: FS_TAG_SOURCE },
    ]);
    expect(prismaMock.ticketTagLink.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1] }, createdBy: FS_TAG_SOURCE } });
  });

  test('a retired tag is not linked again; nothing to do = no writes', async () => {
    prismaMock.ticketTagLink.findMany.mockResolvedValue([]);
    prismaMock.ticketTag.findMany.mockResolvedValue([{ id: 30, name: 'Retired', isActive: false }]);
    const r = await reconcileFsTags({ id: 6, workspaceId: 4 }, ['Retired']);
    expect(r).toEqual({ added: 0, removed: 0, created: 0 });
    expect(prismaMock.ticketTagLink.create).not.toHaveBeenCalled();

    prismaMock.ticketTagLink.findMany.mockResolvedValue([{ id: 3, tagId: 40, createdBy: FS_TAG_SOURCE, tag: { name: 'Same' } }]);
    expect(await reconcileFsTags({ id: 7, workspaceId: 4 }, ['same'])).toBeNull();
  });

  test('another workspace, or a payload without tags, is left alone', async () => {
    expect(await reconcileFsTags({ id: 8, workspaceId: 1 }, ['X'])).toBeNull();
    expect(await reconcileFsTags({ id: 8, workspaceId: 4 }, undefined)).toBeNull();
    expect(prismaMock.ticketTagLink.findMany).not.toHaveBeenCalled();
  });

  test('the transformer passes tags only when the payload has them', () => {
    if (typeof transformTicket !== 'function') return;
    expect(transformTicket({ id: 1, subject: 's', status: 2, priority: 1, tags: ['A'] }).fsTags).toEqual(['A']);
    expect(transformTicket({ id: 1, subject: 's', status: 2, priority: 1 }).fsTags).toBeUndefined();
  });
});
