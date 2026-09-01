import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mega 08-31 Phase PA (QA #4) — POST /api/v1/tickets resubmission upsert,
// end to end through the real router + ticketService + resubmission service
// + customFieldService + the REAL idempotency middleware, over an in-memory
// ticket store standing in for prisma (so "one ticket in the DB" is a real
// assertion, and the unique (workspace_id, external_ref) index is enforced).

// ---------------------------------------------------------------- in-memory DB
const db = { tickets: new Map(), nextId: 501, nextNative: 1042, idem: new Map(), threadEntries: [], links: [] };
const CATEGORY_NAMES = { 11: 'Project Setup', 12: 'Proposal Setup', 21: 'Quebec', 22: 'Chile' };
const TAXONOMY = [
  { id: 11, workspaceId: 2, name: 'Project Setup', parentId: null, isActive: true },
  { id: 12, workspaceId: 2, name: 'Proposal Setup', parentId: null, isActive: true },
  { id: 21, workspaceId: 2, name: 'Quebec', parentId: 11, isActive: true },
  { id: 22, workspaceId: 2, name: 'Chile', parentId: 11, isActive: true },
];

function withIncludes(t) {
  if (!t) return null;
  return {
    ...t,
    requester: { id: t.requesterId, name: 'Jane Doe', email: 'jdoe@bgcengineering.ca' },
    assignedTech: t.assignedTechId ? { id: t.assignedTechId, name: 'Tech Seven', email: 't7@x', isActive: true, origin: 'local' } : null,
    internalCategory: t.internalCategoryId ? { id: t.internalCategoryId, name: CATEGORY_NAMES[t.internalCategoryId] } : null,
    internalSubcategory: t.internalSubcategoryId ? { id: t.internalSubcategoryId, name: CATEGORY_NAMES[t.internalSubcategoryId] } : null,
    internalGroup: null, group: null, tagLinks: [],
  };
}
function matchWhere(t, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'NOT') { if (matchWhere(t, v)) return false; continue; }
    if (k === 'OR') { if (!v.some((w) => matchWhere(t, w))) return false; continue; }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v && !v.in.includes(t[k])) return false;
      if ('notIn' in v && v.notIn.includes(t[k])) return false;
      if ('not' in v && t[k] === v.not) return false;
      if ('gte' in v && !(t[k] >= v.gte)) return false;
      if ('lte' in v && !(t[k] <= v.lte)) return false;
      if ('startsWith' in v && !String(t[k] ?? '').startsWith(v.startsWith)) return false;
      continue;
    }
    if (t[k] !== v) return false;
  }
  return true;
}
const all = () => [...db.tickets.values()];

let idemSeq = 1;
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: {
    create: jest.fn(async ({ data }) => {
      if (data.externalRef && all().some((x) => x.workspaceId === data.workspaceId && x.externalRef === data.externalRef)) {
        const err = new Error('Unique constraint failed on the fields: (`workspace_id`,`external_ref`)');
        err.code = 'P2002'; err.meta = { target: ['workspace_id', 'external_ref'] };
        throw err;
      }
      const t = { resolvedAt: null, closedAt: null, externalRef: null, customFields: null, ccEmails: [], internalCategoryFit: null, ...data, id: db.nextId++ };
      db.tickets.set(t.id, t);
      return withIncludes(t);
    }),
    findFirst: jest.fn(async ({ where }) => withIncludes(all().find((t) => matchWhere(t, where)) || null)),
    findUnique: jest.fn(async ({ where }) => withIncludes(db.tickets.get(where.id) || null)),
    findMany: jest.fn(async ({ where, take } = {}) => all().filter((t) => matchWhere(t, where)).slice(0, take || 100).map(withIncludes)),
    update: jest.fn(async ({ where, data }) => { const t = db.tickets.get(where.id); Object.assign(t, data); return withIncludes(t); }),
    updateMany: jest.fn(async () => ({ count: 0 })),
    count: jest.fn(async () => db.tickets.size),
  },
  ticketLink: {
    upsert: jest.fn(async ({ create }) => { db.links.push(create); return { id: db.links.length, ...create }; }),
    findMany: jest.fn(async () => []),
  },
  ticketThreadEntry: {
    findMany: jest.fn(async () => []),
    create: jest.fn(async ({ data }) => { const e = { id: 700 + db.threadEntries.length, ...data }; db.threadEntries.push(e); return e; }),
    update: jest.fn(async ({ data }) => data),
  },
  apiIdempotencyKey: {
    create: jest.fn(async ({ data }) => {
      const k = `${data.principal}|${data.idemKey}`;
      if (db.idem.has(k)) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
      const row = { id: idemSeq++, ...data }; db.idem.set(k, row); return row;
    }),
    findUnique: jest.fn(async ({ where }) => db.idem.get(`${where.principal_idemKey.principal}|${where.principal_idemKey.idemKey}`) || null),
    update: jest.fn(async ({ where, data }) => { const row = db.idem.get(`${where.principal_idemKey.principal}|${where.principal_idemKey.idemKey}`); Object.assign(row, data); return row; }),
    delete: jest.fn(async ({ where }) => { db.idem.delete(`${where.principal_idemKey.principal}|${where.principal_idemKey.idemKey}`); return {}; }),
  },
  competencyCategory: {
    findMany: jest.fn(async () => TAXONOMY),
    findFirst: jest.fn(async ({ where }) => TAXONOMY.find((t) => t.id === where.id
      && (where.parentId === null ? t.parentId === null : where.parentId === undefined || t.parentId === where.parentId)) || null),
  },
  customFieldDefinition: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  ticketTypeDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 2, name: 'Case', aliases: [], isActive: true, aiAssignable: true, isDefault: true, fsTypeValue: 'Case', sortOrder: 0 },
    ]),
  },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 2, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 2, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 2, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 2, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  $queryRaw: jest.fn(async () => [{ nextval: db.nextNative++ }]),
  $transaction: jest.fn((ops) => (typeof ops === 'function' ? ops(prismaProxy) : Promise.all(ops))),
};
// Any other model (episodes, approvals, attachments, pinned cards, priority
// events, …) answers with harmless defaults so side paths never crash.
function autoModel() {
  let n = 1;
  const fns = new Map();
  return new Proxy({}, {
    get: (_t, method) => {
      if (method === 'then') return undefined;
      if (fns.has(method)) return fns.get(method);
      const fn = jest.fn(async (args = {}) => {
        if (['findMany', 'groupBy'].includes(method)) return [];
        if (['findFirst', 'findUnique'].includes(method)) return null;
        if (method === 'count') return 0;
        if (['updateMany', 'deleteMany', 'createMany'].includes(method)) return { count: 0 };
        if (method === 'create') return { id: n++, ...(args.data || {}) };
        if (method === 'upsert') return { id: n++, ...(args.create || {}) };
        if (method === 'aggregate') return {};
        return args.data || {};
      });
      fns.set(method, fn);
      return fn;
    },
  });
}
const autoModels = new Map();
const prismaProxy = new Proxy(prismaMock, {
  get: (target, prop) => {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (!autoModels.has(prop)) autoModels.set(prop, autoModel());
    return autoModels.get(prop);
  },
});

const noiseRuleServiceMock = { evaluate: jest.fn().mockResolvedValue({ isNoise: false, ruleId: null }) };
const ticketActivityRepositoryMock = { create: jest.fn().mockResolvedValue({}), getByTicketId: jest.fn().mockResolvedValue([]) };
const lifecycleMock = { emitTicketLifecycleNotifications: jest.fn().mockResolvedValue({ status: 'completed' }) };
const requesterRepositoryMock = {
  findByEmail: jest.fn().mockResolvedValue({ id: 40, name: 'Jane Doe', email: 'jdoe@bgcengineering.ca', department: null, freshserviceId: null }),
  createNative: jest.fn(),
};
const mirrorServiceMock = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : jest.fn().mockResolvedValue({ id: 1 })) });
const runPipelineMock = jest.fn().mockResolvedValue({ id: 900 });

const authState = { scopes: ['*'], workspaceId: 2 };
const wsSettings = { externalRefCustomFieldKey: null, apiResubmissionMatchEnabled: false, apiResubmissionMatchWindowDays: 7 };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = authState.workspaceId;
    req.apiKey = { id: 5, name: 'Coreshack intake', keyPrefix: 'tp_live_x', mode: 'live', scopes: authState.scopes, oauthClientId: null };
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({
  default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) },
}));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({
  verifyClientCredentials: jest.fn(), issueAccessToken: jest.fn(), verifyAccessToken: jest.fn(), clientUsable: jest.fn(),
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: noiseRuleServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn().mockResolvedValue([]) } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: runPipelineMock } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({
  default: { dispatchWebhookEvent: jest.fn() }, dispatchWebhookEvent: jest.fn(), WEBHOOK_EVENTS: [],
}));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');
const { invalidateStatusCache } = await import('../src/services/statusService.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  return app;
}
const app = buildApp();
const post = (body, headers = {}) => request(app).post('/api/v1/tickets').set('Authorization', 'Bearer tp_live_x').set(headers).send(body);
const patch = (id, body) => request(app).patch(`/api/v1/tickets/${id}`).set('Authorization', 'Bearer tp_live_x').send(body);

const PA = {
  subject: 'Coyote Landslide',
  description: 'Created from Power Automate',
  priority: 2,
  requesterEmail: 'jdoe@bgcengineering.ca',
  requesterName: 'Jane Doe',
  runAiTriage: false,
  category: 'Project Setup',
  subcategory: 'Quebec',
  externalRef: 'sp-projectrequests-1260',
  customFields: { clientName: 'ACME Inc', clientLocation: 'Quebec', powerAppRecordId: '1260' },
};
const REVISED = { ...PA, priority: 3, description: 'Client moved the start date to October.', customFields: { ...PA.customFields, clientLocation: 'Montreal' } };

let provisionedId = 9000;
const noteCount = () => db.threadEntries.filter((e) => e.isPrivate === true).length;
const auditTypes = () => ticketActivityRepositoryMock.create.mock.calls.map(([d]) => d.activityType);

beforeEach(() => {
  jest.clearAllMocks();
  invalidateStatusCache();
  db.tickets.clear(); db.idem.clear(); db.threadEntries.length = 0; db.links.length = 0;
  db.nextId = 501; db.nextNative = 1042;
  authState.scopes = ['*']; authState.workspaceId = 2;
  Object.assign(wsSettings, { externalRefCustomFieldKey: null, apiResubmissionMatchEnabled: false, apiResubmissionMatchWindowDays: 7 });
  prismaMock.workspace.findUnique.mockImplementation(async ({ where }) => ({
    id: where.id, name: 'Project Accounting', isActive: true, nativeTicketingEnabled: true, defaultInternalGroupId: null, ...wsSettings,
  }));
  // Definitions live in-memory too so a provisioned key is known on the next call.
  const defs = [];
  prismaMock.customFieldDefinition.findMany.mockImplementation(async () => defs);
  prismaMock.customFieldDefinition.findFirst.mockImplementation(async ({ where }) => defs.find((d) => d.key === where.key) || null);
  prismaMock.customFieldDefinition.create.mockImplementation(async ({ data }) => { const d = { id: provisionedId++, isActive: true, ...data }; defs.push(d); return d; });
});

describe('POST /api/v1/tickets — externalRef resubmission upsert', () => {
  test('first POST with an externalRef → 201, ref persisted and echoed, meta.resubmitted:false', async () => {
    const res = await post(PA);
    expect(res.status).toBe(201);
    expect(res.body.resubmitted).toBeUndefined();
    expect(res.body.data.externalRef).toBe('sp-projectrequests-1260');
    expect(res.body.data.ref).toBe('TP-1042');
    expect(res.body.meta).toMatchObject({ resubmitted: false, ignoredFields: [] });
    expect(db.tickets.size).toBe(1);
    expect(all()[0].externalRef).toBe('sp-projectrequests-1260');
  });

  test('re-POST same ref with a changed body → 200 + resubmitted:true, ONE ticket, fields updated, description appended, private note + audit', async () => {
    const first = await post(PA);
    const id = first.body.data.id;
    const beforeActivity = db.tickets.get(id).lastRealActivityAt;
    ticketActivityRepositoryMock.create.mockClear();
    await new Promise((r) => setTimeout(r, 5));

    const res = await post(REVISED);
    expect(res.status).toBe(200);
    expect(res.body.resubmitted).toBe(true);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.priority).toBe(3);
    expect(res.body.meta).toMatchObject({
      resubmitted: true, ticketRef: 'TP-1042', matchedBy: 'external_ref', reopened: false,
      changedFields: ['priority', 'description', 'customFields'],
    });
    expect(db.tickets.size).toBe(1);

    const row = db.tickets.get(id);
    expect(row.status).toBe('Open');
    expect(row.assignedTechId).toBeUndefined();
    expect(row.description).toContain('Created from Power Automate');
    expect(row.description).toMatch(/<hr><p><strong>— Resubmitted .* via API key &quot;Coreshack intake&quot; —<\/strong><\/p><div>Client moved the start date to October\.<\/div>/);
    expect(row.customFields).toMatchObject({ client_name: 'ACME Inc', client_location: 'Montreal', power_app_record_id: '1260' });
    expect(row.lastRealActivityAt.getTime()).toBeGreaterThan(beforeActivity.getTime());

    // Exactly one PRIVATE note (never a reply) carrying the diff table; the audit trail says "resubmitted".
    expect(noteCount()).toBe(1);
    const note = db.threadEntries.find((e) => e.isPrivate === true);
    expect(note.eventType).toBe('note');
    expect(note.bodyHtml ?? note.content).toContain('Priority');
    expect(db.threadEntries.some((e) => e.eventType === 'reply')).toBe(false);
    expect(auditTypes()).toContain('resubmitted');
    expect(auditTypes()).not.toContain('created');
  });

  test('identical re-POST → 200, changedFields [] and NO note / audit / write', async () => {
    await post(PA);
    const writesBefore = prismaMock.ticket.update.mock.calls.length;
    jest.clearAllMocks();
    const res = await post(PA);
    expect(res.status).toBe(200);
    expect(res.body.resubmitted).toBe(true);
    expect(res.body.meta.changedFields).toEqual([]);
    expect(noteCount()).toBe(0);
    expect(auditTypes()).toEqual([]);
    expect(prismaMock.ticket.update.mock.calls.length - 0).toBe(0);
    expect(writesBefore).toBeGreaterThanOrEqual(0);
    expect(db.tickets.size).toBe(1);
  });

  test('status and assignee are never touched by a resubmission (and are reported as ignored keys)', async () => {
    const first = await post(PA);
    const row = db.tickets.get(first.body.data.id);
    row.status = 'Pending'; row.assignedTechId = 7;
    const res = await post({ ...REVISED, status: 'Open', assignedTechId: null });
    expect(res.status).toBe(200);
    expect(row.status).toBe('Pending');
    expect(row.assignedTechId).toBe(7);
    expect(res.body.meta.ignoredFields).toEqual(expect.arrayContaining(['status', 'assignedTechId']));
    expect(res.body.data.assignee).toEqual({ id: 7, name: 'Tech Seven' });
  });

  test('Resolved ticket + default reopen → reopened, resolvedAt cleared, status Open, then updated', async () => {
    const first = await post(PA);
    const row = db.tickets.get(first.body.data.id);
    row.status = 'Resolved'; row.resolvedAt = new Date(); row.resolutionTimeSeconds = 10;
    const res = await post(REVISED);
    expect(res.status).toBe(200);
    expect(res.body.meta.reopened).toBe(true);
    expect(res.body.meta.changedFields[0]).toBe('status');
    expect(row.status).toBe('Open');
    expect(row.resolvedAt).toBeNull();
    expect(row.closedAt).toBeNull();
    expect(row.priority).toBe(3);
    expect(auditTypes()).toEqual(expect.arrayContaining(['status_changed', 'resubmitted']));
    expect(db.tickets.size).toBe(1);
  });

  test('Resolved + reopenOnResubmit:false → 201 NEW ticket linked related_to the old one; ref moves to the new ticket', async () => {
    const first = await post(PA);
    const oldId = first.body.data.id;
    db.tickets.get(oldId).status = 'Resolved';
    const res = await post({ ...REVISED, reopenOnResubmit: false });
    expect(res.status).toBe(201);
    expect(res.body.data.id).not.toBe(oldId);
    expect(res.body.meta).toMatchObject({
      resubmitted: false, linkedToTicket: oldId,
      priorExternalRefTicket: { id: oldId, ref: 'TP-1042', status: 'Resolved', reason: 'reopen_declined' },
    });
    expect(db.tickets.get(oldId).status).toBe('Resolved');
    expect(db.tickets.get(oldId).externalRef).toBeNull();
    expect(db.tickets.get(res.body.data.id).externalRef).toBe('sp-projectrequests-1260');
    expect(res.body.data.externalRef).toBe('sp-projectrequests-1260');
    expect(db.links).toEqual([expect.objectContaining({ ticketId: res.body.data.id, relatedTicketId: oldId, kind: 'related_to' })]);
    expect(db.tickets.size).toBe(2);
  });

  test('Closed ticket → never reopened: 201 new linked ticket (reason closed); the next resubmission lands on the new one', async () => {
    const first = await post(PA);
    const oldId = first.body.data.id;
    db.tickets.get(oldId).status = 'Closed'; db.tickets.get(oldId).closedAt = new Date();
    const res = await post(REVISED);
    expect(res.status).toBe(201);
    expect(res.body.meta.priorExternalRefTicket).toMatchObject({ id: oldId, reason: 'closed' });
    expect(db.tickets.get(oldId).status).toBe('Closed');
    expect(db.links[0]).toMatchObject({ kind: 'related_to', relatedTicketId: oldId });
    const again = await post({ ...REVISED, priority: 4 });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(res.body.data.id);
    expect(db.tickets.size).toBe(2);
  });

  test('same externalRef in two workspaces → two independent tickets', async () => {
    const a = await post(PA);
    authState.workspaceId = 3;
    const b = await post(PA);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(db.tickets.size).toBe(2);
    expect(all().map((t) => t.workspaceId).sort()).toEqual([2, 3]);
    expect(all().every((t) => t.externalRef === 'sp-projectrequests-1260')).toBe(true);
  });

  test('concurrent double-POST with the same ref → one ticket (loser rides the P2002 → resubmission path)', async () => {
    const [r1, r2] = await Promise.all([post(PA), post({ ...PA, priority: 3 })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(db.tickets.size).toBe(1);
    const resub = [r1, r2].find((r) => r.status === 200);
    expect(resub.body.resubmitted).toBe(true);
    expect(resub.body.meta.matchedBy).toBe('external_ref');
    expect(resub.body.data.id).toBe([r1, r2].find((r) => r.status === 201).body.data.id);
  });

  test('externalRef validation: >200 chars → 400; blank → treated as absent (plain create)', async () => {
    const tooLong = await post({ ...PA, externalRef: 'x'.repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(db.tickets.size).toBe(0);
    const blank = await post({ ...PA, externalRef: '   ' });
    expect(blank.status).toBe(201);
    expect(blank.body.data.externalRef).toBeNull();
  });

  test('Idempotency-Key stays orthogonal: a retry of the resubmit replays the cached 200 without re-applying', async () => {
    await post(PA);
    const first = await post(REVISED, { 'Idempotency-Key': 'run-2' });
    expect(first.status).toBe(200);
    expect(first.body.resubmitted).toBe(true);
    // the middleware finalizes the cache on res 'finish' — let it settle
    await new Promise((r) => setImmediate(r));
    const notesAfterFirst = noteCount();
    const replay = await post(REVISED, { 'Idempotency-Key': 'run-2' });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(noteCount()).toBe(notesAfterFirst);
    // …and the documented mistake: the SAME key with a DIFFERENT body is a 422
    // before any resubmission logic runs.
    const wrong = await post({ ...REVISED, priority: 4 }, { 'Idempotency-Key': 'run-2' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('idempotency_key_reused');
    expect(db.tickets.get(all()[0].id).priority).toBe(3);
  });

  test('AI re-triage: classification_only queued only when content changed and the ticket is unassigned', async () => {
    const first = await post({ ...PA, runAiTriage: true });
    runPipelineMock.mockClear();
    const res = await post({ ...REVISED, runAiTriage: true });
    expect(res.status).toBe(200);
    expect(res.body.meta.aiRetriage).toEqual({ queued: true, mode: 'classify' });
    expect(runPipelineMock).toHaveBeenCalledWith(first.body.data.id, 2, 'classification_only');

    // Assigned + human-set category → skipped even with content change.
    const row = db.tickets.get(first.body.data.id);
    row.assignedTechId = 7; row.internalCategoryFit = null;
    runPipelineMock.mockClear();
    const res2 = await post({ ...REVISED, description: 'Yet another revision', runAiTriage: true });
    expect(res2.status).toBe(200);
    expect(res2.body.meta.aiRetriage).toEqual({ queued: false });
    expect(runPipelineMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/tickets — custom-field bridge (workspace externalRefCustomFieldKey)', () => {
  const NO_REF = Object.fromEntries(Object.entries(PA).filter(([k]) => k !== 'externalRef'));

  test('ws key power_app_record_id: the real Power Apps payload (no externalRef) gets ref pa-1260; re-POST → 200 matchedBy custom_field_key', async () => {
    wsSettings.externalRefCustomFieldKey = 'power_app_record_id';
    const first = await post(NO_REF);
    expect(first.status).toBe(201);
    expect(first.body.data.externalRef).toBe('pa-1260');
    expect(first.body.meta.provisionedCustomFields).toEqual(expect.arrayContaining(['power_app_record_id']));

    const second = await post({ ...NO_REF, priority: 3 });
    expect(second.status).toBe(200);
    expect(second.body.resubmitted).toBe(true);
    expect(second.body.meta.matchedBy).toBe('custom_field_key');
    expect(second.body.meta.changedFields).toEqual(['priority']);
    expect(db.tickets.size).toBe(1);
  });

  test('bridge off (no key) → the same payload twice creates two tickets (today’s behaviour, unchanged)', async () => {
    await post(NO_REF);
    const second = await post({ ...NO_REF, priority: 3 });
    expect(second.status).toBe(201);
    expect(db.tickets.size).toBe(2);
    expect(all().every((t) => t.externalRef === null)).toBe(true);
  });
});

describe('POST /api/v1/tickets — deprecated heuristic at the route level', () => {
  const NO_REF = Object.fromEntries(Object.entries(PA).filter(([k]) => k !== 'externalRef'));

  test('flag on, one earlier API ticket by the same requester/subject/key → 200 subject_heuristic', async () => {
    wsSettings.apiResubmissionMatchEnabled = true;
    const first = await post(NO_REF);
    // The heuristic checks the create audit's principal — replay what _audit recorded.
    prismaProxy.ticketActivity.findMany.mockResolvedValueOnce([{ ticketId: first.body.data.id, details: { actorEmail: 'apikey:tp_live_x' } }]);
    const second = await post({ ...NO_REF, priority: 3 });
    expect(second.status).toBe(200);
    expect(second.body.meta.matchedBy).toBe('subject_heuristic');
    expect(db.tickets.size).toBe(1);
  });

  test('two candidates → creates normally and flags meta.resubmissionAmbiguous with the refs', async () => {
    wsSettings.apiResubmissionMatchEnabled = true;
    const a = await post(NO_REF);
    prismaProxy.ticketActivity.findMany.mockResolvedValue([]); // nothing owned yet → plain create
    const b = await post(NO_REF);
    expect(b.status).toBe(201);
    prismaProxy.ticketActivity.findMany.mockResolvedValue([
      { ticketId: a.body.data.id, details: { actorEmail: 'apikey:tp_live_x' } },
      { ticketId: b.body.data.id, details: { actorEmail: 'apikey:tp_live_x' } },
    ]);
    const c = await post({ ...NO_REF, priority: 3 });
    expect(c.status).toBe(201);
    expect(c.body.meta.resubmissionAmbiguous).toBe(true);
    expect(c.body.meta.resubmissionCandidates.sort()).toEqual([a.body.data.ref, b.body.data.ref].sort());
    expect(db.tickets.size).toBe(3);
    prismaProxy.ticketActivity.findMany.mockResolvedValue([]);
  });
});

describe('PATCH /api/v1/tickets/:id — externalRef set-once', () => {
  test('attach a ref to a ticket created without one; same value is a no-op; different value → 409; taken ref → 409', async () => {
    const noRef = Object.fromEntries(Object.entries(PA).filter(([k]) => k !== 'externalRef'));
    const a = await post(noRef);
    const b = await post({ ...noRef, externalRef: 'sp-projectrequests-2' });
    const set = await patch(a.body.data.id, { externalRef: 'sp-projectrequests-1' });
    expect(set.status).toBe(200);
    expect(set.body.data.externalRef).toBe('sp-projectrequests-1');
    expect(auditTypes()).toContain('fields_updated');

    const same = await patch(a.body.data.id, { externalRef: 'sp-projectrequests-1' });
    expect(same.status).toBe(200);

    const different = await patch(a.body.data.id, { externalRef: 'sp-projectrequests-9' });
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('external_ref_immutable');
    expect(db.tickets.get(a.body.data.id).externalRef).toBe('sp-projectrequests-1');

    db.tickets.get(a.body.data.id).externalRef = null;
    const taken = await patch(a.body.data.id, { externalRef: 'sp-projectrequests-2' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('external_ref_taken');
    expect(db.tickets.get(b.body.data.id).externalRef).toBe('sp-projectrequests-2');
  });
});
