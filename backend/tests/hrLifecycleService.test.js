import { jest } from '@jest/globals';

/**
 * Onboarding / Offboarding service (plans/HR_LIFECYCLE_PLAN.md): family
 * creation (standard 5, after-the-fact 3, onboarding 2), date changes,
 * cancellations, observe mode, NH linking, password stripping and the
 * settings audit — against an in-memory store, with the ticket services
 * mocked (no FreshService, no mail).
 */

// ---------------------------------------------------------------- in-memory store
const db = {};
let seq = 1000;
const reset = () => {
  for (const k of ['settings', 'changes', 'families', 'members', 'events', 'tickets', 'leaves']) db[k] = [];
  db.technicians = [
    { id: 1, name: 'Vahid Haeri', email: 'vahid@x.ca', photoUrl: null, workspaceId: 1, isActive: true },
    { id: 2, name: 'Muhammad Shahidullah', email: 'ms@x.ca', photoUrl: null, workspaceId: 1, isActive: true },
    { id: 3, name: 'Gaby Tonnova', email: 'gt@x.ca', photoUrl: null, workspaceId: 1, isActive: true },
    { id: 4, name: 'Adrian Lo', email: 'al@x.ca', photoUrl: null, workspaceId: 1, isActive: true },
  ];
  db.groups = [{ id: 50, name: 'Service Desk', origin: 'freshservice', freshserviceId: 9001n, workspaceId: 1, isActive: true }];
  seq = 1000;
};
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR' || k === 'requester') return true;
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
    if ('contains' in v && !String(row[k] || '').includes(v.contains)) return false;
    if ('in' in v) return v.in.includes(row[k]);
    if ('not' in v) return row[k] !== v.not;
    if ('startsWith' in v) return String(row[k] || '').startsWith(v.startsWith);
    if ('gte' in v) return new Date(row[k]) >= new Date(v.gte);
    return true;
  }
  return row[k] === v;
});
const table = (name, { pk = 'id' } = {}) => ({
  findUnique: jest.fn(async ({ where }) => {
    if (where.familyId_ticketId) return db[name].find((r) => r.familyId === where.familyId_ticketId.familyId && r.ticketId === where.familyId_ticketId.ticketId) || null;
    return db[name].find((r) => matches(r, where)) || null;
  }),
  findFirst: jest.fn(async ({ where = {}, orderBy } = {}) => {
    const rows = db[name].filter((r) => matches(r, where));
    if (orderBy?.id === 'desc') rows.reverse();
    return rows[0] || null;
  }),
  findMany: jest.fn(async ({ where = {} } = {}) => db[name].filter((r) => matches(r, where))),
  create: jest.fn(async ({ data }) => {
    const row = { [pk]: data[pk] ?? seq++, createdAt: new Date(), ...data };
    db[name].push(row);
    return row;
  }),
  createMany: jest.fn(async ({ data }) => { for (const d of data) db[name].push({ id: seq++, createdAt: new Date(), ...d }); return { count: data.length }; }),
  update: jest.fn(async ({ where, data }) => {
    const row = db[name].find((r) => matches(r, where));
    Object.assign(row, data);
    return row;
  }),
  upsert: jest.fn(async ({ where, create, update }) => {
    const key = where.familyId_ticketId
      ? (r) => r.familyId === where.familyId_ticketId.familyId && r.ticketId === where.familyId_ticketId.ticketId
      : (r) => matches(r, where);
    const row = db[name].find(key);
    if (row) { Object.assign(row, update); return row; }
    const fresh = { id: seq++, createdAt: new Date(), ...create };
    db[name].push(fresh);
    return fresh;
  }),
});

const prismaMock = {
  hrLifecycleSettings: table('settings', { pk: 'workspaceId' }),
  hrLifecycleSettingsChange: table('changes'),
  hrLifecycleFamily: table('families'),
  hrLifecycleFamilyMember: table('members'),
  hrLifecycleEvent: table('events'),
  ticket: {
    findFirst: jest.fn(async ({ where }) => {
      const t = db.tickets.find((r) => r.id === where.id && r.workspaceId === where.workspaceId);
      return t ? { ...t, assignedTech: db.technicians.find((x) => x.id === t.assignedTechId) || null } : null;
    }),
    findMany: jest.fn(async ({ where }) => db.tickets.filter((r) => matches(r, where)).map((t) => ({ ...t, assignedTech: db.technicians.find((x) => x.id === t.assignedTechId) || null }))),
  },
  technician: { findMany: jest.fn(async () => db.technicians) },
  requester: { findMany: jest.fn(async () => db.requesters || []) },
  technicianLeave: { findMany: jest.fn(async ({ where }) => db.leaves.filter((l) => where.technicianId.in.includes(l.technicianId))) },
  group: {
    findMany: jest.fn(async () => db.groups),
    findFirst: jest.fn(async ({ where }) => db.groups.find((g) => g.id === where.id) || null),
  },
  workspace: { findUnique: jest.fn(async () => ({ defaultTimezone: 'America/Los_Angeles' })) },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
};

// ---------------------------------------------------------------- ticket services
let native = 5000;
const ticketById = (id) => db.tickets.find((t) => t.id === id);
const ticketSvc = {
  createTicket: jest.fn(async (ws, input) => {
    const t = {
      id: seq++, workspaceId: ws, origin: 'ticketpulse', nativeNumber: native++, freshserviceTicketId: null, subject: input.subject,
      description: input.description, descriptionText: null, status: 'Open', priority: input.priority, dueBy: input.dueBy ? new Date(input.dueBy) : null,
      createdAt: new Date(), assignedTechId: input.assignedTechId || null, requesterId: input.requesterId || null, parkedUntil: null, requester: { email: 'humanresources@bgcengineering.ca' },
    };
    db.tickets.push(t);
    return { ...t, displayRef: `TP-${t.nativeNumber}` };
  }),
  assignTicket: jest.fn(async (id, ws, techId) => { ticketById(id).assignedTechId = techId; }),
  updateFsTicket: jest.fn(async (id, ws, input) => {
    const t = ticketById(id);
    if (input.assignedTechId !== undefined) t.assignedTechId = input.assignedTechId;
    if (input.dueBy !== undefined) t.dueBy = new Date(input.dueBy);
    if (input.status !== undefined) t.status = input.status;
  }),
  updateTicketFields: jest.fn(async (id, ws, input) => { ticketById(id).dueBy = new Date(input.dueBy); }),
  changeStatus: jest.fn(async (id, ws, status) => { ticketById(id).status = status; }),
  addPrivateNote: jest.fn(async () => ({})),
};
const linkSvc = { setParent: jest.fn(async () => ({})), link: jest.fn(async () => ({})) };
const parkSvc = {
  hrSuggestion: jest.fn(async () => ({ usable: true, until: '2026-10-19T15:00:00.000Z', wakeDate: '2026-10-19', reason: 'Leave starts Oct 21 (from the HR notice)' })),
  park: jest.fn(async (id, _ws, input) => { ticketById(id).parkedUntil = new Date(input.until); return {}; }),
  unpark: jest.fn(async (id) => { ticketById(id).parkedUntil = null; return { unparked: true }; }),
  // The real lead-time rule on a Monday–Friday calendar.
  hrWakeFor: jest.fn(async (_ws, kind, iso) => {
    const wakeDate = hrWakeDate(kind, iso);
    const until = new Date(`${wakeDate}T15:00:00.000Z`);
    const started = until.getTime() <= Date.now() + 3600e3;
    return { wakeDate, until: until.toISOString(), started, usable: !started && until.getTime() <= Date.now() + 184 * 86400e3 };
  }),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketSvc }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: linkSvc }));
jest.unstable_mockModule('../src/services/ticketParkService.js', () => ({ default: parkSvc }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { baseStatusOf: jest.fn(async (_ws, s) => ({ Open: 'Open', Pending: 'Pending', Resolved: 'Resolved', Closed: 'Closed' }[s] ?? null)) },
}));

const { default: hr, dueInstant } = await import('../src/services/hrLifecycleService.js');
const { hrWakeDate } = await import('../src/utils/hrNoticeDates.js');

// ---------------------------------------------------------------- fixtures
const HR = 'humanresources@bgcengineering.ca';
const BAMBOO = 'notifications@app.bamboohr.com';
const PROFILE = 'Bamboo Profile : https://bgcengineering.bamboohr.com/employees/employee.php?id=1234&page=2096';
const day = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);

function fsNotice({ subject, text, sender = HR, origin = 'freshservice', createdAt = new Date() }) {
  const t = {
    id: seq++, workspaceId: 1, origin, nativeNumber: null, freshserviceTicketId: BigInt(240000 + seq), subject, description: null, descriptionText: text,
    status: 'Open', priority: 2, dueBy: null, createdAt, assignedTechId: null, requesterId: 77, parkedUntil: null, requester: { email: sender },
  };
  db.tickets.push(t);
  return t;
}

const departure = (name, last, extra = '') => fsNotice({
  subject: `Departure Notification: ${name} from the Calgary office will be departing`,
  text: `Hello, Name: ${name} Office: Calgary Departure Date: ${last} ${extra} ${PROFILE}`,
});

async function setMode(mode, extra = {}) {
  await hr.updateSettings(1, { mode, ...extra }, { email: 'vahid@x.ca', name: 'Vahid Haeri' });
}

beforeEach(async () => {
  reset();
  jest.clearAllMocks();
  delete process.env.HR_LIFECYCLE_WORKSPACE_IDS;
});

// ---------------------------------------------------------------- settings

describe('settings', () => {
  test('defaults: off, seeded from today\'s routing, five / three / two children', async () => {
    const s = await hr.getSettings(1);
    expect(s.mode).toBe('off');
    expect(s.persisted).toBe(false);
    expect(s.parentAssigneeTechId).toBe(1); // Vahid
    expect(s.templates.offboarding_standard.map((i) => i.title)).toEqual(['Laptop', 'Phone', 'iPad', 'Disable Account', 'Decommissioning Account']);
    expect(s.templates.offboarding_standard.find((i) => i.key === 'decommission_account')).toMatchObject({ dueOffsetDays: 7, assigneeTechId: 2 });
    expect(s.templates.offboarding_standard.find((i) => i.key === 'laptop').assigneeTechId).toBeNull(); // blank → AI routing
    expect(s.templates.offboarding_after_fact.map((i) => i.key)).toEqual(['laptop', 'phone', 'ipad']);
    expect(s.templates.onboarding.map((i) => i.title)).toEqual(['Laptop', 'Workstation']);
  });

  test('every change is audited: who, when, field, before → after', async () => {
    await setMode('observe');
    const list = hr.getSettings(1).then((s) => s.templates.offboarding_standard);
    const items = (await list).map((i) => (i.key === 'laptop' ? { ...i, dueOffsetDays: 1, assigneeTechId: 4 } : i));
    const { changes } = await hr.updateSettings(1, { templates: { offboarding_standard: items } }, { email: 'kim@x.ca', name: 'Kim Lee' });
    expect(changes).toEqual(expect.arrayContaining([
      { field: 'templates.offboarding_standard[laptop].dueOffsetDays', before: 0, after: 1 },
      { field: 'templates.offboarding_standard[laptop].assigneeTechId', before: null, after: 4 },
    ]));
    const audit = await hr.listSettingsChanges(1);
    expect(audit.find((r) => r.field === 'mode')).toMatchObject({ before: 'off', after: 'observe', changedBy: 'vahid@x.ca', changedByName: 'Vahid Haeri' });
    expect(audit.find((r) => r.field === 'templates.offboarding_standard[laptop].assigneeTechId')).toMatchObject({ changedBy: 'kim@x.ca', before: null, after: 4 });
  });

  test('removing a child and saving nothing new are both handled; bad input is refused', async () => {
    await setMode('live');
    const s = await hr.getSettings(1);
    const { changes } = await hr.updateSettings(1, { templates: { offboarding_after_fact: s.templates.offboarding_after_fact.filter((i) => i.key !== 'ipad') } }, { email: 'a@x.ca' });
    expect(changes).toEqual([{ field: 'templates.offboarding_after_fact[ipad]', before: expect.objectContaining({ title: 'iPad' }), after: null }]);
    expect((await hr.updateSettings(1, { mode: 'live' }, { email: 'a@x.ca' })).changes).toEqual([]);
    await expect(hr.updateSettings(1, { mode: 'on' })).rejects.toThrow(/Mode must be one of/);
    await expect(hr.updateSettings(1, { parentAssigneeTechId: 999 })).rejects.toThrow(/active technician/);
    await expect(hr.updateSettings(1, { templates: { onboarding: [{ title: 'Laptop' }, { title: 'Laptop' }] } })).rejects.toThrow(/listed twice/);
    await expect(hr.updateSettings(1, { templates: { onboarding: [{ title: 'Laptop', dueOffsetDays: 400 }] } })).rejects.toThrow(/between -30 and 90/);
  });
});

// ---------------------------------------------------------------- off / observe

describe('modes', () => {
  test('off (the default): nothing happens, not even an event', async () => {
    const t = departure('Jamie Gill', day(10));
    expect(await hr.onTicketCreated(t.id, 1)).toBeNull();
    expect(db.events).toHaveLength(0);
    expect(ticketSvc.createTicket).not.toHaveBeenCalled();
  });

  test('a workspace outside HR_LIFECYCLE_WORKSPACE_IDS never reads anything', async () => {
    await setMode('live');
    process.env.HR_LIFECYCLE_WORKSPACE_IDS = '3';
    const t = departure('Jamie Gill', day(10));
    expect(await hr.onTicketCreated(t.id, 1)).toBeNull();
    expect(db.events).toHaveLength(0);
  });

  test('observe: one event with the would-be family, no ticket touched, no family row', async () => {
    await setMode('observe');
    const t = departure('Jamie Gill', day(10));
    const ev = await hr.onTicketCreated(t.id, 1);
    expect(ev).toMatchObject({ mode: 'observe', outcome: 'recorded', decision: 'create_family', noticeType: 'departure', person: 'Jamie Gill' });
    expect(ev.details.plan.children.map((c) => c.title)).toEqual(['Laptop', 'Phone', 'iPad', 'Disable Account', 'Decommissioning Account']);
    expect(ev.summary).toMatch(/^Would: Jamie Gill: offboarding family with 5 children/);
    expect(db.families).toHaveLength(0);
    expect(db.members).toHaveLength(0);
    for (const fn of Object.values(ticketSvc)) expect(fn).not.toHaveBeenCalled();
    expect(linkSvc.setParent).not.toHaveBeenCalled();
    // The same ticket is not recorded twice.
    expect(await hr.onTicketCreated(t.id, 1)).toBeNull();
    expect(db.events).toHaveLength(1);
  });

  // 2 Oct 2026: Shadow has no real families, so follow-ups used to read
  // "no open family". They now find the family Shadow recorded.
  test('shadow: NH tickets, date changes and cancellations act on the family Shadow recorded', async () => {
    await setMode('observe');
    const hire = fsNotice({ subject: 'New Hire: Isabela Sousa', sender: BAMBOO, text: `Start Date: ${day(10)} Employee #: 2371 Position: Engineer Location: Montreal` });
    await hr.onTicketCreated(hire.id, 1);
    const nh = fsNotice({ subject: `NH Laptop - Montreal - CA - isousa - ${day(10)}`, sender: 'isousa@bgcengineering.ca', text: `Start Date: ${day(10)} Username: isousa Full Name: Isabela Sousa ID: 2371 Password: Secret1!` });
    const link = await hr.onTicketCreated(nh.id, 1);
    expect(link).toMatchObject({ decision: 'link_nh', outcome: 'recorded' });
    expect(link.summary).toMatch(/would be linked to the onboarding family.*Shadow recorded/);
    expect(link.summary).not.toMatch(/Secret1/);

    const dep = departure('Jamie Gill', day(10));
    await hr.onTicketCreated(dep.id, 1);
    const change = fsNotice({ subject: "Departure Notification: Jamie Gill's departure date has changed", text: `The departure date has changed from ${day(10)} to ${day(20)} ${PROFILE}` });
    const moved = await hr.onTicketCreated(change.id, 1);
    expect(moved).toMatchObject({ decision: 'move_dates', outcome: 'recorded' });
    expect(moved.summary).toMatch(/would move 6 open tickets/);
    const cancel = fsNotice({ subject: 'Departure Notification: Jamie Gill will no longer be departing', text: `Jamie Gill will no longer be departing ${PROFILE}` });
    const closed = await hr.onTicketCreated(cancel.id, 1);
    expect(closed).toMatchObject({ decision: 'cancel_family', outcome: 'recorded' });
    expect(closed.summary).toMatch(/would close the parent and 5 children/);
    expect(db.families).toHaveLength(0);
    for (const fn of Object.values(ticketSvc)) expect(fn).not.toHaveBeenCalled();
  });

  test('shadow families are listed under People with the children Live would create, linked NH and a cancellation', async () => {
    await setMode('observe');
    const hire = fsNotice({ subject: 'New Hire: Isabela Sousa', sender: BAMBOO, text: `Start Date: ${day(10)} Employee #: 2371 Position: Engineer Location: Montreal` });
    await hr.onTicketCreated(hire.id, 1);
    const nh = fsNotice({ subject: `NH Laptop - Montreal - CA - isousa - ${day(10)}`, sender: 'isousa@x.ca', text: `Start Date: ${day(10)} Username: isousa Full Name: Isabela Sousa ID: 2371` });
    await hr.onTicketCreated(nh.id, 1);
    const dep = departure('Jamie Gill', day(10));
    await hr.onTicketCreated(dep.id, 1);
    await hr.onTicketCreated(fsNotice({ subject: 'Departure Notification: Jamie Gill will no longer be departing', text: `Jamie Gill will no longer be departing ${PROFILE}` }).id, 1);

    const open = await hr.listFamilies(1, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ shadow: true, kind: 'onboarding', personName: 'Isabela Sousa', status: 'open', linked: 1, progress: { done: 0, total: 2 } });
    expect(open[0].plannedChildren.map((c) => c.title)).toEqual(['Laptop', 'Workstation']);
    expect(open[0].parent).toMatchObject({ id: hire.id });
    const all = await hr.listFamilies(1, {});
    expect(all.find((f) => f.personName === 'Jamie Gill')).toMatchObject({ shadow: true, status: 'cancelled', progress: { total: 5 } });
    expect(await hr.listFamilies(1, { status: 'closed' })).toEqual([]);
    expect(db.families).toHaveLength(0);
  });

  test('shadow: a follow-up for someone Shadow never saw still says "no open family"', async () => {
    await setMode('observe');
    const nh = fsNotice({ subject: `NH Workstation - Perth - AU - nobody - ${day(5)}`, sender: 'nobody@x.ca', text: `Start Date: ${day(5)} Username: nobody Full Name: No Body ID: 9999` });
    expect(await hr.onTicketCreated(nh.id, 1)).toMatchObject({ decision: 'no_family' });
  });

  test('old tickets (history backfill) are ignored', async () => {
    await setMode('live');
    const t = departure('Old Person', '2024-01-10');
    t.createdAt = new Date('2024-01-02T10:00:00Z');
    expect(await hr.onTicketCreated(t.id, 1)).toBeNull();
    expect(db.events).toHaveLength(0);
  });

  test('the hook never throws', async () => {
    await setMode('live');
    prismaMock.ticket.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(hr.onTicketCreated(123, 1)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------- family creation

describe('live: family creation', () => {
  test('standard departure: parent assigned + due, 5 TP-born children linked, due + assignee per child', async () => {
    await setMode('live');
    const last = day(10);
    const parent = departure('Jamie Gill', last);
    const ev = await hr.onTicketCreated(parent.id, 1);
    expect(ev).toMatchObject({ mode: 'live', outcome: 'done', decision: 'create_family' });

    // Parent (FS-born): assigned to the parent assignee and due on the last day, via the FS write-back path.
    expect(ticketSvc.updateFsTicket).toHaveBeenCalledWith(parent.id, 1, { assignedTechId: 1 }, expect.objectContaining({ name: 'Ticket Pulse (Onboarding)' }));
    expect(ticketSvc.updateFsTicket).toHaveBeenCalledWith(parent.id, 1, { dueBy: dueInstant(last) }, expect.anything());

    expect(ticketSvc.createTicket).toHaveBeenCalledTimes(5);
    const inputs = ticketSvc.createTicket.mock.calls.map((c) => c[1]);
    expect(inputs.map((i) => i.subject)).toEqual([
      'Laptop', 'Phone', 'iPad', 'Disable Account', 'Decommissioning Account',
    ].map((k) => `Child Ticket - ${k} - ${parent.subject}`));
    const byTitle = Object.fromEntries(inputs.map((i) => [i.subject.split(' - ')[1], i]));
    expect(byTitle['Decommissioning Account']).toMatchObject({ assignedTechId: 2, dueBy: dueInstant(new Date(new Date(`${last}T00:00:00Z`).getTime() + 7 * 86400e3).toISOString().slice(0, 10)), runAiTriage: false, notifyRequester: false, requesterId: 77 });
    expect(byTitle.Laptop).toMatchObject({ dueBy: dueInstant(last), runAiTriage: true });
    expect(byTitle.Laptop.assignedTechId).toBeUndefined();
    expect(linkSvc.setParent).toHaveBeenCalledTimes(5);
    expect(linkSvc.setParent.mock.calls.every((c) => c[2].parentTicketId === parent.id)).toBe(true);

    expect(db.families).toHaveLength(1);
    expect(db.families[0]).toMatchObject({ kind: 'offboarding', parentTicketId: parent.id, employeeId: '1234', personKey: 'jamie gill', afterTheFact: false, template: 'offboarding_standard', status: 'open' });
    expect(db.members.filter((m) => m.role === 'child')).toHaveLength(5);
    // A summary note on the parent lists the children.
    const parentNote = ticketSvc.addPrivateNote.mock.calls.find((c) => c[0] === parent.id)[2].bodyHtml;
    expect(parentNote).toMatch(/Offboarding organised by Ticket Pulse/);
    expect(parentNote).toMatch(/TP-5000/);
  });

  test('after the fact by date: the notice arrives after the last day → 3 children, due from today', async () => {
    await setMode('live');
    const parent = departure('Kai Lo', day(-3));
    const ev = await hr.onTicketCreated(parent.id, 1);
    expect(ev.decision).toBe('create_family_after_the_fact');
    expect(ticketSvc.createTicket.mock.calls.map((c) => c[1].subject.split(' - ')[1])).toEqual(['Laptop', 'Phone', 'iPad']);
    expect(db.families[0]).toMatchObject({ afterTheFact: true, template: 'offboarding_after_fact' });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
    expect(ticketSvc.createTicket.mock.calls[0][1].dueBy).toBe(dueInstant(today));
  });

  test('after the fact by "effective immediately", even with a future date', async () => {
    await setMode('live');
    const parent = departure('Ren Wu', day(5), 'This is effective immediately.');
    expect((await hr.onTicketCreated(parent.id, 1)).decision).toBe('create_family_after_the_fact');
    expect(ticketSvc.createTicket).toHaveBeenCalledTimes(3);
  });

  test('onboarding: the BambooHR notice is the parent of Laptop + Workstation, due on the start date', async () => {
    await setMode('live');
    const start = day(20);
    const [y, m, d] = start.split('-');
    const parent = fsNotice({
      subject: 'New Hire: Teddi Hern',
      sender: BAMBOO,
      text: `New Team Member Start Date: ${start} Employee #: 2374 Position: Geologist Employee Status: FTR Location: Calgary Reports To: Maria Cruz View Employee Record`,
    });
    expect(y && m && d).toBeTruthy();
    const ev = await hr.onTicketCreated(parent.id, 1);
    expect(ev.decision).toBe('create_family');
    expect(ticketSvc.createTicket.mock.calls.map((c) => [c[1].subject, c[1].dueBy])).toEqual([
      ['Child Ticket - Laptop - New Hire: Teddi Hern', dueInstant(start)],
      ['Child Ticket - Workstation - New Hire: Teddi Hern', dueInstant(start)],
    ]);
    expect(db.families[0]).toMatchObject({ kind: 'onboarding', employeeId: '2374', template: 'onboarding' });
  });

  test('a re-sent departure for the same person links to the open family, no new children', async () => {
    await setMode('live');
    const first = departure('Jamie Gill', day(10));
    await hr.onTicketCreated(first.id, 1);
    ticketSvc.createTicket.mockClear();
    const again = fsNotice({ subject: `Copy of ${first.subject}`, text: first.descriptionText });
    const ev = await hr.onTicketCreated(again.id, 1);
    expect(ev.decision).toBe('duplicate_linked');
    expect(ticketSvc.createTicket).not.toHaveBeenCalled();
    expect(linkSvc.link).toHaveBeenCalledWith(first.id, 1, { relatedTicketId: again.id, kind: 'related_to' }, expect.anything());
  });

  test('child descriptions never carry a password from the notice', async () => {
    await setMode('live');
    const parent = departure('Jamie Gill', day(10), 'Temporary password: Spring2026!');
    await hr.onTicketCreated(parent.id, 1);
    for (const call of ticketSvc.createTicket.mock.calls) {
      expect(call[1].description).not.toMatch(/Spring2026|password/i);
      expect(call[1].description).toMatch(/Jamie Gill/);
    }
  });
});

// ---------------------------------------------------------------- changes

async function liveFamily(name = 'Jamie Gill', last = day(10)) {
  await setMode('live');
  const parent = departure(name, last);
  await hr.onTicketCreated(parent.id, 1);
  jest.clearAllMocks();
  return { parent, last, children: db.members.filter((m) => m.role === 'child').map((m) => ticketById(m.ticketId)) };
}

describe('live: date changes and cancellations', () => {
  test('departure date change moves the parent and every OPEN child, with a note on each', async () => {
    const { parent, children } = await liveFamily();
    children[2].status = 'Closed'; // iPad already returned
    const to = day(15);
    const notice = fsNotice({ subject: 'Departure Notification: Jamie Gill departure date has changed', text: `The departure date has changed from ${day(10)} to ${to} for Jamie Gill in the Calgary office. ${PROFILE}` });
    const ev = await hr.onTicketCreated(notice.id, 1);
    expect(ev).toMatchObject({ decision: 'move_dates', outcome: 'done' });
    // Parent (FS-born) through the FS path, children (TP-born) through updateTicketFields.
    expect(ticketSvc.updateFsTicket).toHaveBeenCalledWith(parent.id, 1, { dueBy: dueInstant(to) }, expect.anything());
    const moved = ticketSvc.updateTicketFields.mock.calls.map((c) => [c[0], c[2].dueBy]);
    expect(moved).toHaveLength(4);
    const decom = children.find((t) => t.subject.includes('Decommissioning'));
    const plus7 = new Date(new Date(`${to}T00:00:00Z`).getTime() + 7 * 86400e3).toISOString().slice(0, 10);
    expect(moved).toContainEqual([decom.id, dueInstant(plus7)]);
    expect(moved.find((c) => c[0] === children[2].id)).toBeUndefined();
    // Notes: parent + 4 open children + the change notice itself.
    const noted = new Set(ticketSvc.addPrivateNote.mock.calls.map((c) => c[0]));
    expect(noted).toEqual(new Set([parent.id, notice.id, ...children.filter((t) => t.status !== 'Closed').map((t) => t.id)]));
    expect(dbDate(db.families[0].effectiveDate)).toBe(to);
    expect(linkSvc.link).toHaveBeenCalledWith(parent.id, 1, { relatedTicketId: notice.id, kind: 'related_to' }, expect.anything());
  });

  test('a change notice with no open family is recorded and noted, nothing else', async () => {
    await setMode('live');
    const notice = fsNotice({ subject: 'Departure Notification: Nobody Here departure date has changed', text: 'The departure date has changed from 2026-10-01 to 2026-10-08 for Nobody Here in the Calgary office.' });
    const ev = await hr.onTicketCreated(notice.id, 1);
    expect(ev).toMatchObject({ decision: 'no_family', outcome: 'skipped' });
    expect(ticketSvc.updateTicketFields).not.toHaveBeenCalled();
    expect(ticketSvc.addPrivateNote).toHaveBeenCalledWith(notice.id, 1, expect.objectContaining({ bodyHtml: expect.stringMatching(/no open offboarding family/) }), expect.anything());
  });

  test('cancellation closes every open child, then the parent, with a note quoting the notice; closed stay closed', async () => {
    const { parent, children } = await liveFamily();
    children[0].status = 'Closed';
    const notice = fsNotice({ subject: 'Departure Notification: Jamie Gill will no longer be departing', text: 'Jamie Gill will no longer be departing. Please make any necessary changes as required.' });
    const ev = await hr.onTicketCreated(notice.id, 1);
    expect(ev).toMatchObject({ decision: 'cancel_family', outcome: 'done' });
    const closedNative = ticketSvc.changeStatus.mock.calls.map((c) => c[0]);
    expect(closedNative).toHaveLength(4);
    expect(closedNative).not.toContain(children[0].id);
    // The parent closes last (FS-born → FS path).
    const fsClose = ticketSvc.updateFsTicket.mock.calls.find((c) => c[2].status === 'Closed');
    expect(fsClose[0]).toBe(parent.id);
    expect(ticketSvc.updateFsTicket.mock.invocationCallOrder[ticketSvc.updateFsTicket.mock.calls.indexOf(fsClose)])
      .toBeGreaterThan(Math.max(...ticketSvc.changeStatus.mock.invocationCallOrder));
    const note = ticketSvc.addPrivateNote.mock.calls.find((c) => c[0] === children[1].id)[2].bodyHtml;
    expect(note).toMatch(/cancelled/);
    expect(note).toMatch(/will no longer be departing/);
    expect(db.families[0].status).toBe('cancelled');
  });

  test('switch to after the fact closes the extra children (Disable + Decommission) with a note', async () => {
    const { parent } = await liveFamily();
    const out = await hr.switchToAfterTheFact(db.families[0].id, 1, { email: 'vahid@x.ca', name: 'Vahid Haeri' });
    expect(out.closed.map((c) => c.title)).toEqual(['Disable Account', 'Decommissioning Account']);
    expect(db.families[0]).toMatchObject({ afterTheFact: true, template: 'offboarding_after_fact' });
    expect(ticketSvc.addPrivateNote).toHaveBeenCalledWith(parent.id, 1, expect.objectContaining({ bodyHtml: expect.stringMatching(/Switched to after the fact/) }), expect.anything());
    expect(db.events.at(-1)).toMatchObject({ mode: 'manual', decision: 'switch_after_the_fact', actor: 'vahid@x.ca' });
    await expect(hr.switchToAfterTheFact(db.families[0].id, 1, {})).rejects.toThrow(/already after the fact/);
  });
});

// ---------------------------------------------------------------- NH automation

describe('live: NH automation tickets', () => {
  test('an NH Laptop ticket for a person with an open onboarding family is linked, never a new child, and its password is never quoted', async () => {
    await setMode('live');
    const parent = fsNotice({ subject: 'New Hire: Jane Doe', sender: BAMBOO, text: `Start Date: ${day(14)} Employee #: 2249 Position: Engineer Employee Status: FTR Location: Brisbane Reports To: Kim Lee` });
    await hr.onTicketCreated(parent.id, 1);
    jest.clearAllMocks();
    const nh = fsNotice({ subject: `NH Laptop - Brisbane - AU - jdoe - ${day(14)}`, sender: 'jdoe@bgcengineering.ca', text: `Start Date: ${day(14)} Username: jdoe Full Name: Jane D. ID: 2249 Email: jdoe@x.ca Password: Hunter2!x Location: Brisbane - AU` });
    const ev = await hr.onTicketCreated(nh.id, 1);
    expect(ev).toMatchObject({ decision: 'link_nh', outcome: 'done' });
    expect(ticketSvc.createTicket).not.toHaveBeenCalled();
    expect(linkSvc.link).toHaveBeenCalledWith(parent.id, 1, { relatedTicketId: nh.id, kind: 'related_to' }, expect.anything());
    expect(db.members.find((m) => m.ticketId === nh.id)).toMatchObject({ role: 'linked', templateKey: 'nh_laptop' });
    const all = JSON.stringify([ticketSvc.addPrivateNote.mock.calls, db.events]);
    expect(all).not.toMatch(/Hunter2/);
  });
});

// ---------------------------------------------------------------- leave

describe('live: the notice is the ticket (leave / transfer)', () => {
  test('a leave notice is assigned per settings, due on the leave start and parked', async () => {
    await setMode('live', { leave: { assigneeTechId: 4, park: true } });
    const start = day(20);
    const t = fsNotice({ subject: 'On Leave Notification: Vic Camp', text: `New Leave Records Employee Number Location Leave Type Expected Leave Date Expected Return Date 583 Vancouver Parental Leave ${start} 2027-10-12 Removed Leave Records` });
    const ev = await hr.onTicketCreated(t.id, 1);
    expect(ev).toMatchObject({ decision: 'notice_is_ticket', outcome: 'done' });
    expect(ticketSvc.updateFsTicket).toHaveBeenCalledWith(t.id, 1, { assignedTechId: 4 }, expect.anything());
    expect(ticketSvc.updateFsTicket).toHaveBeenCalledWith(t.id, 1, { dueBy: dueInstant(start) }, expect.anything());
    expect(parkSvc.park).toHaveBeenCalledWith(t.id, 1, expect.objectContaining({ kind: 'until_date' }), expect.anything(), { source: 'suggested_hr' });
    expect(ticketSvc.createTicket).not.toHaveBeenCalled();
    expect(db.families).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- reads

test('families list shows progress n/m and the parent card', async () => {
  const { children } = await liveFamily();
  children[0].status = 'Closed';
  const [f] = await hr.listFamilies(1);
  expect(f).toMatchObject({ personName: 'Jamie Gill', kind: 'offboarding', status: 'open', progress: { done: 1, total: 5 } });
  expect(f.parent.ref).toMatch(/^#\d+$/);
  const detail = await hr.getFamily(f.id, 1);
  expect(detail.members).toHaveLength(5);
  expect(detail.members[0]).toMatchObject({ role: 'child', key: 'laptop', closed: true });
});

function dbDate(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

// ---------------------------------------------------------------- several people per child

const departureOf = (name, last, empId) => fsNotice({
  subject: `Departure Notification: ${name} from the Calgary office will be departing`,
  text: `Hello, Name: ${name} Office: Calgary Departure Date: ${last} Bamboo Profile : https://bgcengineering.bamboohr.com/employees/employee.php?id=${empId}&page=2096`,
});

describe('several people on one child', () => {
  const sharePhone = async () => {
    const list = (await hr.getSettings(1)).templates.offboarding_standard;
    return hr.updateSettings(1, {
      mode: 'live',
      templates: { offboarding_standard: list.map((i) => (i.key === 'phone' ? { ...i, assigneeTechId: 3, assigneeTechIds: [3, 4] } : i)) },
    }, { email: 'vahid@x.ca', name: 'Vahid Haeri' });
  };
  const phoneOwner = (parent) => ticketSvc.createTicket.mock.calls.map((c) => c[1]).find((i) => i.subject === `Child Ticket - Phone - ${parent.subject}`).assignedTechId;

  test('the list is saved, audited as one change, and bounded', async () => {
    const { settings, changes } = await sharePhone();
    expect(settings.templates.offboarding_standard.find((i) => i.key === 'phone')).toMatchObject({ assigneeTechId: 3, assigneeTechIds: [3, 4] });
    expect(changes).toEqual(expect.arrayContaining([{ field: 'templates.offboarding_standard[phone].assigneeTechIds', before: [3], after: [3, 4] }]));
    expect(changes.some((c) => c.field.endsWith('[phone].assigneeTechId'))).toBe(false);
    const list = settings.templates.offboarding_standard;
    await expect(hr.updateSettings(1, { templates: { offboarding_standard: list.map((i) => (i.key === 'phone' ? { ...i, assigneeTechIds: [3, 999] } : i)) } })).rejects.toThrow(/active technician/);
    await expect(hr.updateSettings(1, { templates: { offboarding_standard: list.map((i) => (i.key === 'phone' ? { ...i, assigneeTechIds: [3, 4, 1, 2, 3, 4, 1, 2] } : i)) } })).resolves.toBeTruthy(); // repeats collapse
  });

  test('a page that only knows the single field still changes the person', async () => {
    const list = (await hr.getSettings(1)).templates.offboarding_standard; // phone: [3]
    const { settings } = await hr.updateSettings(1, { templates: { offboarding_standard: list.map((i) => (i.key === 'phone' ? { ...i, assigneeTechId: 4 } : i)) } });
    expect(settings.templates.offboarding_standard.find((i) => i.key === 'phone')).toMatchObject({ assigneeTechId: 4, assigneeTechIds: [4] });
  });

  test('they take turns, one ticket each time', async () => {
    await sharePhone();
    const owners = [];
    for (const [i, name] of ['Ann One', 'Bob Two', 'Cy Three'].entries()) {
      const parent = departureOf(name, day(10), 3000 + i);
      await hr.onTicketCreated(parent.id, 1);
      owners.push(phoneOwner(parent));
    }
    expect(owners).toEqual([3, 4, 3]);
    expect(ticketSvc.createTicket.mock.calls.filter((c) => /Child Ticket - Phone/.test(c[1].subject))).toHaveLength(3);
  });

  test('someone off today is skipped; if everyone is off the turn stands', async () => {
    await sharePhone();
    db.leaves.push({ technicianId: 3, isFullDay: true });
    const a = departureOf('Ann One', day(10), 3001);
    await hr.onTicketCreated(a.id, 1);
    expect(phoneOwner(a)).toBe(4);
    db.leaves.push({ technicianId: 4, isFullDay: true });
    const b = departureOf('Bob Two', day(10), 3002);
    await hr.onTicketCreated(b.id, 1);
    expect(phoneOwner(b)).toBe(3);
  });
});

// ---------------------------------------------------------------- organise now

describe('organise now: existing tickets are taken in, only the missing ones created', () => {
  const fsChild = (parent, title, status = 'Open', sep = ' - ') => {
    const t = fsNotice({ subject: `Child Ticket - ${title}${sep}${parent.subject}`, text: 'Please take the necessary steps' });
    t.status = status;
    return t;
  };

  test('a departure FreshService already organised: its children join, the gaps are filled, the owner stays', async () => {
    await setMode('live');
    const parent = departure('Matt Lin', day(8));
    parent.assignedTechId = 4;
    const laptop = fsChild(parent, 'Laptop');
    const phone = fsChild(parent, 'Phone', 'Pending', '- '); // FreshService's own spacing
    const disable = fsChild(parent, 'Disable Account', 'Closed');
    fsChild(departureOf('Somebody Else', day(8), 4321), 'Laptop');
    jest.clearAllMocks();

    const r = await hr.organise(parent.id, 1, { email: 'vahid@x.ca', name: 'Vahid Haeri' });
    expect(r).toMatchObject({ outcome: 'done', warnings: [] });
    expect(ticketSvc.createTicket.mock.calls.map((c) => c[1].subject)).toEqual([
      `Child Ticket - iPad - ${parent.subject}`, `Child Ticket - Decommissioning Account - ${parent.subject}`,
    ]);
    const fam = db.families.find((f) => f.parentTicketId === parent.id);
    const members = db.members.filter((m) => m.familyId === fam.id);
    expect(members.map((m) => [m.templateKey, m.role]).sort()).toEqual([
      ['decommission_account', 'child'], ['disable_account', 'child'], ['ipad', 'child'], ['laptop', 'child'], ['phone', 'child'],
    ]);
    expect(members.filter((m) => [laptop.id, phone.id, disable.id].includes(m.ticketId))).toHaveLength(3);
    // The notice already had an owner: not reassigned. Its due date was blank: set.
    expect(ticketSvc.updateFsTicket.mock.calls.some((c) => c[0] === parent.id && c[2].assignedTechId !== undefined)).toBe(false);
    expect(ticketSvc.updateFsTicket).toHaveBeenCalledWith(parent.id, 1, { dueBy: dueInstant(day(8)) }, expect.anything());
    const note = ticketSvc.addPrivateNote.mock.calls.find((c) => c[0] === parent.id)[2].bodyHtml;
    expect(note).toMatch(/Laptop \(already existed\)/);
    expect(note).toMatch(/Disable Account \(already existed, closed\)/);
    const ev = db.events.at(-1);
    expect(ev).toMatchObject({ mode: 'live', decision: 'create_family', outcome: 'done', actor: 'vahid@x.ca' });
    expect(ev.details.adopted).toHaveLength(3);
    expect(ev.summary).toMatch(/3 existing tickets taken in/);

    await expect(hr.organise(parent.id, 1)).rejects.toThrow(/already has a family/);
    // A later date change moves the taken-in children too.
    jest.clearAllMocks();
    const change = fsNotice({ subject: 'Departure Notification: Matt Lin departure date has changed', text: `The departure date has changed from ${day(8)} to ${day(12)} for Matt Lin in the Calgary office. ${PROFILE}` });
    const moved = await hr.onTicketCreated(change.id, 1);
    expect(moved.decision).toBe('move_dates');
    expect(ticketSvc.updateFsTicket).toHaveBeenCalledWith(laptop.id, 1, { dueBy: dueInstant(day(12)) }, expect.anything());
    expect(ticketSvc.updateFsTicket.mock.calls.some((c) => c[0] === disable.id)).toBe(false); // closed stays closed
  });

  test('a new hire whose NH Laptop ticket exists: it is the Laptop child, only Workstation is created, no password travels', async () => {
    await setMode('live');
    const parent = fsNotice({ subject: 'New Hire: Jane Doe', sender: BAMBOO, text: `Start Date: ${day(14)} Employee #: 2249 Position: Engineer Employee Status: FTR Location: Brisbane Reports To: Kim Lee` });
    const nh = fsNotice({ subject: `NH Laptop - Brisbane - AU - jdoe - ${day(14)}`, sender: 'jdoe@bgcengineering.ca', text: `Start Date: ${day(14)} Username: jdoe Full Name: Jane D. ID: 2249 Email: jdoe@x.ca Password: Hunter2!` });
    fsNotice({ subject: `NH Laptop - Brisbane - AU - other - ${day(14)}`, sender: 'o@bgcengineering.ca', text: 'Full Name: Other Person ID: 7777 Email: o@x.ca' });
    jest.clearAllMocks();
    const r = await hr.organise(parent.id, 1, { email: 'vahid@x.ca' });
    expect(r.outcome).toBe('done');
    expect(ticketSvc.createTicket.mock.calls.map((c) => c[1].subject)).toEqual(['Child Ticket - Workstation - New Hire: Jane Doe']);
    expect(db.members.find((m) => m.ticketId === nh.id)).toMatchObject({ role: 'child', templateKey: 'laptop' });
    expect(linkSvc.link).toHaveBeenCalledWith(parent.id, 1, { relatedTicketId: nh.id, kind: 'related_to' }, expect.anything());
    expect(ticketSvc.addPrivateNote.mock.calls.some((c) => c[0] === nh.id)).toBe(false);
    expect(JSON.stringify([ticketSvc.addPrivateNote.mock.calls, ticketSvc.createTicket.mock.calls, db.events])).not.toMatch(/Hunter2/);
  });

  test('refused in Shadow, and for anything that is not a departure or new-hire notice', async () => {
    await setMode('observe');
    const parent = departure('Matt Lin', day(8));
    await expect(hr.organise(parent.id, 1)).rejects.toThrow(/Live first/);
    await setMode('live');
    const leave = fsNotice({ subject: 'On Leave Notification: Pat Kim', text: `Expected Leave Date: ${day(5)} Expected Return Date: ${day(40)}` });
    await expect(hr.organise(leave.id, 1)).rejects.toThrow(/Only a departure or new-hire notice/);
    await expect(hr.organise(999999, 1)).rejects.toThrow(/not found/i);
    expect(ticketSvc.createTicket).not.toHaveBeenCalled();
  });

  test('candidates: open notices with no family, with what would be taken in and created; People stops listing Shadow once Live', async () => {
    await setMode('observe');
    const shadowed = departure('Matt Lin', day(8));
    await hr.onTicketCreated(shadowed.id, 1);
    expect((await hr.listFamilies(1)).some((f) => f.shadow)).toBe(true);
    await setMode('live');
    expect(await hr.listFamilies(1)).toEqual([]);

    fsChild(shadowed, 'Laptop');
    const hire = fsNotice({ subject: 'New Hire: Jane Doe', sender: BAMBOO, text: `Start Date: ${day(14)} Employee #: 2249 Position: Engineer Employee Status: FTR Location: Brisbane Reports To: Kim Lee` });
    const closed = departureOf('Gone Already', day(-30), 3101);
    closed.status = 'Closed';
    const organised = departureOf('Has Family', day(9), 3102);
    await hr.onTicketCreated(organised.id, 1);
    jest.clearAllMocks();

    const list = await hr.candidates(1);
    expect(list.map((c) => c.personName).sort()).toEqual(['Jane Doe', 'Matt Lin']);
    const matt = list.find((c) => c.personName === 'Matt Lin');
    expect(matt).toMatchObject({ ticketId: shadowed.id, kind: 'offboarding', effectiveDate: day(8) });
    expect(matt.existing.map((x) => x.title)).toEqual(['Laptop']);
    expect(matt.toCreate.map((x) => x.title)).toEqual(['Phone', 'iPad', 'Disable Account', 'Decommissioning Account']);
    expect(list.find((c) => c.ticketId === hire.id).toCreate.map((x) => x.title)).toEqual(['Laptop', 'Workstation']);
    // Reads only.
    expect(ticketSvc.createTicket).not.toHaveBeenCalled();
    expect(ticketSvc.addPrivateNote).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- new hires by office

describe('new hires by office', () => {
  const hire = (name, office, empId, start = day(20)) => fsNotice({
    subject: `New Hire: ${name}`,
    sender: BAMBOO,
    text: `New Team Member Start Date: ${start} Employee #: ${empId} Position: Geologist Employee Status: FTR Location: ${office} Reports To: Maria Cruz View Employee Record`,
  });
  const ROUTING = {
    offices: [
      { label: 'Vancouver and vicinity', match: ['Vancouver', 'Kamloops'], assigneeTechIds: [3, 4] },
      { label: 'Calgary', match: 'Calgary, Edmonton', assigneeTechIds: [2] },
    ],
    fallbackTechIds: [1],
  };
  const owners = (parent) => ticketSvc.createTicket.mock.calls.map((c) => c[1]).filter((i) => i.subject.endsWith(parent.subject)).map((i) => [i.assignedTechId, i.runAiTriage]);

  test('seeded from the team by name; saved lists are validated and audited', async () => {
    const seeded = (await hr.getSettings(1)).officeRouting;
    expect(seeded.offices.map((o) => o.key)).toEqual(['vancouver', 'toronto', 'calgary', 'ottawa', 'halifax']);
    expect(seeded.offices.find((o) => o.key === 'calgary').match).toEqual(['Calgary', 'Edmonton']);
    expect(seeded.offices.find((o) => o.key === 'toronto').match).toEqual(['Toronto', 'Kingston']);
    expect(seeded.offices[0]).toMatchObject({ label: 'Vancouver and vicinity', assigneeTechIds: [4] }); // only Adrian Lo exists in this team
    expect(seeded.fallbackTechIds).toEqual([4]);

    const { settings, changes } = await hr.updateSettings(1, { officeRouting: ROUTING }, { email: 'vahid@x.ca', name: 'Vahid Haeri' });
    expect(settings.officeRouting.offices.map((o) => [o.key, o.match, o.assigneeTechIds])).toEqual([
      ['vancouver_and_vicinity', ['Vancouver', 'Kamloops'], [3, 4]], ['calgary', ['Calgary', 'Edmonton'], [2]],
    ]);
    expect(changes.map((c) => c.field)).toEqual(expect.arrayContaining(['officeRouting[vancouver]', 'officeRouting[calgary].label', 'officeRouting[calgary].assigneeTechIds', 'officeRouting.fallbackTechIds']));
    // The lists survive a save of something else.
    await hr.updateSettings(1, { mode: 'observe' });
    expect((await hr.getSettings(1)).officeRouting.fallbackTechIds).toEqual([1]);

    await expect(hr.updateSettings(1, { officeRouting: { offices: [{ label: 'X', match: [], assigneeTechIds: [] }] } })).rejects.toThrow(/at least one office name/);
    await expect(hr.updateSettings(1, { officeRouting: { offices: [{ label: 'X', match: ['x'], assigneeTechIds: [999] }] } })).rejects.toThrow(/active technician/);
    await expect(hr.updateSettings(1, { officeRouting: { offices: 'nope' } })).rejects.toThrow(/must be a list/);
  });

  test('both children of a hire go to ONE person of the office, in turn; other offices are fair grab; no AI run', async () => {
    await hr.updateSettings(1, { mode: 'live', officeRouting: ROUTING });
    const a = hire('Ann One', 'Vancouver', 3001);
    const b = hire('Bob Two', 'Vancouver - Software', 3002);
    const c = hire('Cy Three', 'Kamloops', 3003);
    const d = hire('Di Four', 'Edmonton', 3004);
    const e = hire('Ed Five', 'Brisbane', 3005);
    for (const t of [a, b, c, d, e]) await hr.onTicketCreated(t.id, 1);
    expect(owners(a)).toEqual([[3, false], [3, false]]);
    expect(owners(b)).toEqual([[4, false], [4, false]]);
    expect(owners(c)).toEqual([[3, false], [3, false]]);
    expect(owners(d)).toEqual([[2, false], [2, false]]);
    expect(owners(e)).toEqual([[1, false], [1, false]]);
  });

  test('a child with its own default assignee keeps it; an office with nobody listed falls back to AI routing', async () => {
    const list = (await hr.getSettings(1)).templates.onboarding;
    await hr.updateSettings(1, {
      mode: 'live',
      officeRouting: { offices: [{ label: 'Vancouver', match: ['Vancouver'], assigneeTechIds: [3] }, { label: 'Toronto', match: ['Toronto'], assigneeTechIds: [] }], fallbackTechIds: [] },
      templates: { onboarding: list.map((i) => (i.key === 'workstation' ? { ...i, assigneeTechId: 2, assigneeTechIds: [2] } : i)) },
    });
    const a = hire('Ann One', 'Vancouver', 3001);
    const t = hire('Tor Onto', 'Toronto', 3002);
    await hr.onTicketCreated(a.id, 1);
    await hr.onTicketCreated(t.id, 1);
    expect(owners(a)).toEqual([[3, false], [2, false]]);
    expect(owners(t)).toEqual([[undefined, true], [2, false]]);
  });

  test('reassign by office: children held outside the list move to one list person; a list member who already holds one is kept', async () => {
    await hr.updateSettings(1, { mode: 'live', officeRouting: { offices: [], fallbackTechIds: [] } });
    const a = hire('Ann One', 'Vancouver', 3001);
    await hr.onTicketCreated(a.id, 1); // no lists yet: AI routing
    const fam = db.families.at(-1);
    const kids = db.members.filter((m) => m.familyId === fam.id).map((m) => ticketById(m.ticketId));
    kids[0].assignedTechId = 2; // somebody outside the office
    kids[1].assignedTechId = 4; // already an office person
    await hr.updateSettings(1, { officeRouting: ROUTING });
    jest.clearAllMocks();

    const r = await hr.rerouteFamily(fam.id, 1, { email: 'vahid@x.ca', name: 'Vahid Haeri' });
    expect(r).toMatchObject({ assignee: { id: 4, name: 'Adrian Lo' }, office: 'Vancouver and vicinity', warnings: [] });
    expect(r.moved.map((m) => m.ticketId)).toEqual([kids[0].id]);
    expect(kids.map((k) => k.assignedTechId)).toEqual([4, 4]);
    expect(ticketSvc.assignTicket).toHaveBeenCalledTimes(1);
    expect(ticketSvc.addPrivateNote.mock.calls[0][2].bodyHtml).toMatch(/assigned to Adrian Lo by office \(Vancouver and vicinity\), by Vahid Haeri/);
    expect(db.events.at(-1)).toMatchObject({ mode: 'manual', decision: 'reroute_office', outcome: 'done', actor: 'vahid@x.ca' });

    // Nothing left to move; a departure is refused.
    expect((await hr.rerouteFamily(fam.id, 1)).moved).toEqual([]);
    const dep = departureOf('Matt Lin', day(8), 4444);
    await hr.onTicketCreated(dep.id, 1);
    await expect(hr.rerouteFamily(db.families.at(-1).id, 1)).rejects.toThrow(/Only a new hire/);
  });
});

describe('new hires by office: the edges', () => {
  const hire = (name, office, empId) => fsNotice({
    subject: `New Hire: ${name}`,
    sender: BAMBOO,
    text: `New Team Member Start Date: ${day(20)} Employee #: ${empId} Position: Geologist Employee Status: FTR Location: ${office} Reports To: Maria Cruz View Employee Record`,
  });
  const owners = (parent) => ticketSvc.createTicket.mock.calls.map((c) => c[1]).filter((i) => i.subject.endsWith(parent.subject)).map((i) => i.assignedTechId);

  test('the office team first; when every one of them is off today, anyone else', async () => {
    await hr.updateSettings(1, { mode: 'live', officeRouting: { offices: [{ label: 'Calgary and Edmonton', match: ['Calgary', 'Edmonton'], assigneeTechIds: [2] }], fallbackTechIds: [2, 3, 4] } });
    const a = hire('Ann One', 'Edmonton', 3001);
    await hr.onTicketCreated(a.id, 1);
    expect(owners(a)).toEqual([2, 2]);
    db.leaves.push({ technicianId: 2, isFullDay: true });
    const b = hire('Bob Two', 'Edmonton', 3002);
    await hr.onTicketCreated(b.id, 1);
    expect(owners(b)).toEqual([3, 3]); // not 2 (off), the next of the others
  });

  test('reassign by office hands a hire to whoever holds the fewest open new-hire tickets', async () => {
    await hr.updateSettings(1, { mode: 'live', officeRouting: { offices: [], fallbackTechIds: [] } });
    const fams = [];
    for (const [i, name] of ['Ann One', 'Bob Two', 'Cy Three', 'Di Four'].entries()) {
      const t = hire(name, 'Vancouver', 3001 + i);
      await hr.onTicketCreated(t.id, 1);
      const fam = db.families.at(-1);
      fams.push(fam);
      for (const m of db.members.filter((x) => x.familyId === fam.id)) ticketById(m.ticketId).assignedTechId = 1; // all with somebody outside
    }
    await hr.updateSettings(1, { officeRouting: { offices: [{ label: 'Vancouver', match: ['Vancouver'], assigneeTechIds: [3, 4] }], fallbackTechIds: [] } });
    const got = [];
    for (const f of fams) got.push((await hr.rerouteFamily(f.id, 1)).assignee.id);
    expect(got).toEqual([3, 4, 3, 4]);
  });

  test('the People list says who holds the children and carries the e-mail of the person for their photo', async () => {
    await hr.updateSettings(1, { mode: 'live', officeRouting: { offices: [{ label: 'Vancouver', match: ['Vancouver'], assigneeTechIds: [4] }], fallbackTechIds: [] } });
    db.requesters = [{ name: 'ann one', email: 'aone@bgcengineering.ca' }, { name: 'Ann One', email: 'ann@gmail.com' }];
    const a = hire('Ann One', 'Vancouver', 3001);
    await hr.onTicketCreated(a.id, 1);
    const [row] = await hr.listFamilies(1, { status: 'open' });
    expect(row).toMatchObject({ personName: 'Ann One', personEmail: 'aone@bgcengineering.ca', assignees: [{ id: 4, name: 'Adrian Lo' }] });
    expect(JSON.stringify(row)).not.toMatch(/photoUrl":"/);
    db.requesters = [];
  });
});

// ---------------------------------------------------------------- parks follow the date

describe('parking: asleep until the lead time, and the parks follow a date change', () => {
  const hire = (name, empId, start) => fsNotice({
    subject: `New Hire: ${name}`,
    sender: BAMBOO,
    text: `New Team Member Start Date: ${start} Employee #: ${empId} Position: Geologist Employee Status: FTR Location: Calgary Reports To: Maria Cruz View Employee Record`,
  });
  const wakeAt = (kind, iso) => new Date(`${hrWakeDate(kind, iso)}T15:00:00.000Z`).getTime();
  const kidsOf = (parent) => db.members.filter((m) => m.familyId === db.families.find((f) => f.parentTicketId === parent.id).id && m.role === 'child').map((m) => ticketById(m.ticketId));

  test('a new hire: the children and the notice are parked until 14 days before the start', async () => {
    await setMode('live');
    const a = hire('Ann One', 3001, day(60));
    await hr.onTicketCreated(a.id, 1);
    const kids = kidsOf(a);
    expect(kids).toHaveLength(2);
    for (const t of [...kids, a]) expect(new Date(t.parkedUntil).getTime()).toBe(wakeAt('new_hire', day(60)));
    expect(parkSvc.park).toHaveBeenCalledWith(kids[0].id, 1, expect.objectContaining({ kind: 'until_date', reason: expect.stringMatching(/^Starts .+ — onboarding/) }), expect.objectContaining({ name: 'Ticket Pulse (HR notice)' }), { source: 'suggested_hr' });
  });

  test('a start inside the lead time, and an after-the-fact departure, are not parked', async () => {
    await setMode('live');
    const soon = hire('Bob Two', 3002, day(5));
    await hr.onTicketCreated(soon.id, 1);
    const gone = departureOf('Cy Three', day(-2), 3003);
    await hr.onTicketCreated(gone.id, 1);
    expect(parkSvc.park).not.toHaveBeenCalled();
    expect(kidsOf(soon).every((t) => !t.parkedUntil)).toBe(true);
  });

  test('HR moves the start later: due dates and parks move together, the note says so', async () => {
    await setMode('live');
    const a = hire('Ann One', 3001, day(60));
    await hr.onTicketCreated(a.id, 1);
    const kids = kidsOf(a);
    kids[1].parkedUntil = null; // somebody woke the Workstation ticket to start early
    jest.clearAllMocks();
    const change = fsNotice({ subject: 'New Hire Notification: Ann One start date has changed', text: `The start date has changed from ${day(60)} to ${day(120)} for Ann One in the Calgary office.` });
    const ev = await hr.onTicketCreated(change.id, 1);
    expect(ev).toMatchObject({ decision: 'move_dates', outcome: 'done' });
    // Parked tickets follow; the awake one sleeps again because the new wake is months away.
    for (const t of [...kids, a]) expect(new Date(t.parkedUntil).getTime()).toBe(wakeAt('new_hire', day(120)));
    const note = ticketSvc.addPrivateNote.mock.calls.find((c) => c[0] === kids[0].id)[2].bodyHtml;
    expect(note).toMatch(/Due date now .+\. Parked until /);
  });

  test('HR moves the start to next week: parked tickets wake, an awake one is left alone', async () => {
    await setMode('live');
    const a = hire('Ann One', 3001, day(60));
    await hr.onTicketCreated(a.id, 1);
    const kids = kidsOf(a);
    kids[1].parkedUntil = null;
    jest.clearAllMocks();
    const change = fsNotice({ subject: 'New Hire Notification: Ann One start date has changed', text: `The start date has changed from ${day(60)} to ${day(6)} for Ann One in the Calgary office.` });
    await hr.onTicketCreated(change.id, 1);
    expect(parkSvc.unpark).toHaveBeenCalledWith(kids[0].id, 1, expect.objectContaining({ reopen: true }), expect.anything());
    expect(parkSvc.unpark.mock.calls.some((c) => c[0] === kids[1].id)).toBe(false);
    expect(kids.every((t) => !t.parkedUntil)).toBe(true);
    expect(parkSvc.park).not.toHaveBeenCalled();
    expect(ticketSvc.addPrivateNote.mock.calls.find((c) => c[0] === kids[0].id)[2].bodyHtml).toMatch(/Woken: the work is due to start/);
  });

  test('a departure: children sleep until the Monday of the last week; a later last day moves them', async () => {
    await setMode('live');
    const d = departureOf('Dee Four', day(40), 3004);
    await hr.onTicketCreated(d.id, 1);
    const kids = kidsOf(d);
    expect(new Date(kids[0].parkedUntil).getTime()).toBe(wakeAt('departure', day(40)));
    const change = fsNotice({ subject: 'Departure Notification: Dee Four departure date has changed', text: `The departure date has changed from ${day(40)} to ${day(75)} for Dee Four in the Calgary office. Bamboo Profile : https://bgcengineering.bamboohr.com/employees/employee.php?id=3004&page=2096` });
    await hr.onTicketCreated(change.id, 1);
    expect(new Date(kids[0].parkedUntil).getTime()).toBe(wakeAt('departure', day(75)));
  });

  test('park a family by hand: only its open, awake children', async () => {
    await setMode('live');
    const a = hire('Ann One', 3001, day(60));
    await hr.onTicketCreated(a.id, 1);
    const kids = kidsOf(a);
    kids[0].parkedUntil = null;
    kids[1].status = 'Closed';
    jest.clearAllMocks();
    const r = await hr.parkFamily(db.families.at(-1).id, 1, { email: 'vahid@x.ca', name: 'Vahid Haeri' });
    expect(r.parked.map((x) => x.ticketId)).toEqual([kids[0].id]);
    expect(parkSvc.park).toHaveBeenCalledTimes(1);
    expect(db.events.at(-1)).toMatchObject({ mode: 'manual', decision: 'park_family', actor: 'vahid@x.ca' });
  });
});
