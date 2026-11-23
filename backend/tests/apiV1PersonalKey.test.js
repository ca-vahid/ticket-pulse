import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Personal API keys (4.4.05) on the v1 routes: replies and notes go through
 * the app's own ticketService path AS the person (with `via`), a trailing copy
 * of their signature is dropped with warnings[], the ticket list is the
 * person's in-app list, the routes a personal key may never use answer 403,
 * and /me + /me/guide describe the key. The same calls with an integration
 * key are pinned unchanged.
 */
const ticketServiceMock = {
  getTicket: jest.fn(),
  listTickets: jest.fn(),
  addReply: jest.fn(),
  addPrivateNote: jest.fn(),
  createTicket: jest.fn(),
  updateTicketFields: jest.fn(),
  changeStatus: jest.fn(),
  assignTicket: jest.fn(),
};
const prismaMock = {
  ticket: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn().mockResolvedValue({ id: 1, name: 'IT', slug: 'it' }) },
};
const signatureMock = { getEnabledSignatureForSend: jest.fn() };
const machineSenderMock = { machineSenderMatch: jest.fn() };
const personalSvcMock = { buildGuide: jest.fn() };
const fsBornMock = { isFreshServiceBorn: jest.fn(), changeFsBornStatus: jest.fn() };

const PERSONAL_ACTOR = {
  email: 'dana.fox@example.com', name: 'Dana Fox', role: 'agent', workspaceRole: null, technicianId: 12, kind: 'agent',
  trustedIntake: false, defaultSource: null, via: { kind: 'personal_key', keyId: 31, keyName: 'Laptop script' },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 1;
    if (req.headers['x-test-kind'] === 'personal') {
      req.apiKey = {
        id: null, personalKeyId: 31, keyPrefix: 'tpu_AbCdEfGh', name: 'Laptop script', mode: 'live', oauthClientId: null,
        scopes: ['tickets:read', 'tickets:write', 'conversations:read', 'conversations:write'],
        trustedIntake: false, defaultSource: null, structureOwnTicketsOnly: false, fsStatusWrite: false,
        readExcludeCategoryIds: [], readPrivateNotes: true,
        personal: { keyId: 31, actor: req.headers['x-test-member'] ? { ...PERSONAL_ACTOR, kind: 'member', role: 'viewer', workspaceRole: 'viewer' } : PERSONAL_ACTOR, abilities: ['read', 'reply', 'update'], keyScopes: ['tickets:read', 'tickets:write', 'conversations:read', 'conversations:write'], expiresAt: '2027-02-20T00:00:00.000Z', readOnly: false, workspaceRole: null },
      };
    } else {
      req.apiKey = { id: 7, name: 'Power App', keyPrefix: 'tp_live_integrat', mode: 'live', scopes: ['*'], oauthClientId: null, trustedIntake: false, defaultSource: null, fsStatusWrite: false, readExcludeCategoryIds: [], readPrivateNotes: true };
    }
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: { listForWorkspace: jest.fn() } }));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({ verifyClientCredentials: jest.fn(), issueAccessToken: jest.fn() }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({ default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) } }));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({ withIdempotency: (_req, _res, next) => next() }));
jest.unstable_mockModule('../src/services/userSignatureService.js', () => signatureMock);
jest.unstable_mockModule('../src/services/machineSenderService.js', () => machineSenderMock);
jest.unstable_mockModule('../src/services/personalApiKeyService.js', () => ({ default: personalSvcMock, PERSONAL_KEY_RATE_LIMIT: 60 }));
jest.unstable_mockModule('../src/services/fsBornStatusService.js', () => ({ default: fsBornMock }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tickets.example.com' }));
const mergeMock = { merge: jest.fn().mockResolvedValue({ merged: true }), mergeMany: jest.fn().mockResolvedValue({ results: [] }) };
const linkMock = { setParent: jest.fn().mockResolvedValue({}), removeParent: jest.fn().mockResolvedValue({}), addChild: jest.fn().mockResolvedValue({}) };
const splitMock = { split: jest.fn().mockResolvedValue({ id: 9 }) };
const refsMock = { MAX_REFERENCES_PER_CALL: 50, normalizeReference: jest.fn((r) => r), addReferences: jest.fn().mockResolvedValue({}), listReferences: jest.fn().mockResolvedValue([]) };
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: mergeMock }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: linkMock }));
jest.unstable_mockModule('../src/services/ticketSplitService.js', () => ({ default: splitMock }));
jest.unstable_mockModule('../src/services/ticketStructureGuard.js', () => ({ assertClientMayStructure: jest.fn() }));
jest.unstable_mockModule('../src/services/ticketExternalReferenceService.js', () => ({ default: refsMock }));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  return app;
}

const personal = (r) => r.set('x-test-kind', 'personal');
const SIGNATURE = { html: '<p><strong>Dana Fox</strong><br>IT Service Desk</p>', text: 'Dana Fox\nIT Service Desk' };
const TICKET = { id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 77, displayRef: 'TP-77', subject: 'Printer', status: 'Open', priority: 2, requester: { name: 'Sam Okafor', email: 'sam.okafor@example.com' }, ccEmails: [], customFields: {}, thread: [] };

beforeEach(() => {
  jest.clearAllMocks();
  ticketServiceMock.addReply.mockResolvedValue({ entry: { id: 9001 }, email: { sent: true } });
  ticketServiceMock.addPrivateNote.mockResolvedValue({ entry: { id: 9002, actorName: 'Dana Fox' } });
  ticketServiceMock.getTicket.mockResolvedValue(TICKET);
  ticketServiceMock.listTickets.mockResolvedValue({ items: [TICKET], nextCursor: null, pageSize: 25, total: 1 });
  prismaMock.ticket.findFirst.mockResolvedValue({ requester: { email: 'sam.okafor@example.com', unattended: false } });
  signatureMock.getEnabledSignatureForSend.mockResolvedValue(SIGNATURE);
  machineSenderMock.machineSenderMatch.mockResolvedValue(null);
  fsBornMock.isFreshServiceBorn.mockResolvedValue(false);
});

describe('replies with a personal key', () => {
  test('go through ticketService.addReply AS the person, with via; signature looked up by their e-mail', async () => {
    const res = await personal(request(buildApp()).post('/api/v1/tickets/501/replies')).send({ body: '<p>Hi Sam,</p><p>Fixed.</p>' }).expect(201);
    expect(ticketServiceMock.addReply).toHaveBeenCalledWith(501, 1, { bodyText: null, bodyHtml: '<p>Hi Sam,</p><p>Fixed.</p>' }, PERSONAL_ACTOR);
    expect(signatureMock.getEnabledSignatureForSend).toHaveBeenCalledWith(1, 'dana.fox@example.com');
    expect(res.body).toEqual({ success: true, data: { entryId: 9001, emailed: true }, warnings: [] });
  });

  test('a trailing copy of their own signature is dropped and signature_removed is returned', async () => {
    const res = await personal(request(buildApp()).post('/api/v1/tickets/501/replies'))
      .send({ body: '<p>Hi Sam,</p><p>Fixed.</p><p><strong>Dana Fox</strong><br>IT Service Desk</p>' }).expect(201);
    expect(ticketServiceMock.addReply.mock.calls[0][2]).toEqual({ bodyText: null, bodyHtml: '<p>Hi Sam,</p><p>Fixed.</p>' });
    expect(res.body.warnings).toEqual(['signature_removed']);
  });

  test('a plain-text body ending with the signature loses only that copy', async () => {
    const res = await personal(request(buildApp()).post('/api/v1/tickets/501/replies'))
      .send({ body: 'Hi Sam,\n\nFixed, please try again.\n\nDana Fox\nIT Service Desk' }).expect(201);
    expect(ticketServiceMock.addReply.mock.calls[0][2]).toEqual({ bodyText: 'Hi Sam,\n\nFixed, please try again.', bodyHtml: null });
    expect(res.body.warnings).toEqual(['signature_removed']);
  });

  test('requesters who don\'t read replies are warned about, never blocked', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ requester: { email: 'alerts@example.com', unattended: true } });
    let res = await personal(request(buildApp()).post('/api/v1/tickets/501/replies')).send({ body: 'Noted.' }).expect(201);
    expect(res.body.warnings).toEqual(['requester_unattended']);
    prismaMock.ticket.findFirst.mockResolvedValue({ requester: { email: 'no-reply@example.com', unattended: false } });
    machineSenderMock.machineSenderMatch.mockResolvedValue('no-reply@');
    res = await personal(request(buildApp()).post('/api/v1/tickets/501/replies')).send({ body: 'Noted.' }).expect(201);
    expect(res.body.warnings).toEqual(['requester_automated']);
    expect(ticketServiceMock.addReply).toHaveBeenCalledTimes(2);
  });

  test('notes go out as the person too, with an empty warnings list', async () => {
    const res = await personal(request(buildApp()).post('/api/v1/tickets/501/notes')).send({ body: 'Queue resumed.' }).expect(201);
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledWith(501, 1, expect.objectContaining({ bodyText: 'Queue resumed.' }), PERSONAL_ACTOR);
    expect(res.body.warnings).toEqual([]);
  });
});

describe('integration keys are unchanged (pin)', () => {
  test('a reply keeps the apikey: actor, no signature lookup, no warnings', async () => {
    const res = await request(buildApp()).post('/api/v1/tickets/501/replies').send({ body: '<p>Fixed.</p><p><strong>Dana Fox</strong><br>IT Service Desk</p>' }).expect(201);
    expect(ticketServiceMock.addReply).toHaveBeenCalledWith(501, 1, { bodyText: null, bodyHtml: '<p>Fixed.</p><p><strong>Dana Fox</strong><br>IT Service Desk</p>' }, {
      email: 'apikey:tp_live_integrat', name: 'Power App', role: 'api', technicianId: null, trustedIntake: false, defaultSource: null,
    });
    expect(signatureMock.getEnabledSignatureForSend).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, data: { entryId: 9001, emailed: true } });
  });

  test('a note keeps its old response shape', async () => {
    const res = await request(buildApp()).post('/api/v1/tickets/501/notes').send({ body: 'x' }).expect(201);
    expect(res.body).toEqual({ success: true, data: { entryId: 9002, author: 'Dana Fox' } });
  });

  test('/me keeps its old shape', async () => {
    const res = await request(buildApp()).get('/api/v1/me').expect(200);
    expect(res.body.data).toEqual({ authType: 'api_key', key: { name: 'Power App', prefix: 'tp_live_integrat', mode: 'live', scopes: ['*'] }, workspace: { id: 1, name: 'IT', slug: 'it' }, rateLimit: { perMinute: 120 } });
  });
});

describe('visibility: the person\'s in-app list', () => {
  test('GET /tickets with a personal key: no credential exclusion, and the person as actor (AI suggestions hidden as in the app)', async () => {
    await personal(request(buildApp()).get('/api/v1/tickets?status=Open')).expect(200);
    await request(buildApp()).get('/api/v1/tickets?status=Open').expect(200);
    const [personalCall, integrationCall] = ticketServiceMock.listTickets.mock.calls;
    expect(personalCall[1]).not.toHaveProperty('excludeCategoryIds');
    expect(personalCall[1]).toEqual(integrationCall[1]); // the same query
    expect(personalCall[2]).toEqual({ actor: PERSONAL_ACTOR });
    // integration keys: unchanged, two arguments only
    expect(integrationCall).toHaveLength(2);
  });

  test('GET /search/tickets passes the person as actor too', async () => {
    await personal(request(buildApp()).get('/api/v1/search/tickets?query=printer')).expect(200);
    expect(ticketServiceMock.listTickets.mock.calls[0][2]).toEqual({ actor: PERSONAL_ACTOR });
    await request(buildApp()).get('/api/v1/search/tickets?query=printer').expect(200);
    expect(ticketServiceMock.listTickets.mock.calls[1]).toHaveLength(2);
  });

  test('the full conversation (private notes included) is readable, as in the app', async () => {
    ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET, thread: [{ id: 1, eventType: 'reply', bodyText: 'hi', isPrivate: false }, { id: 2, eventType: 'note', bodyText: 'internal', isPrivate: true }] });
    const res = await personal(request(buildApp()).get('/api/v1/tickets/501/conversations')).expect(200);
    expect(res.body.data.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('routes a personal key never uses', () => {
  test('creating tickets and recording monitoring alerts are 403 personal_key_not_allowed_here', async () => {
    let res = await personal(request(buildApp()).post('/api/v1/tickets')).send({ subject: 'x', requesterEmail: 'eli.park@example.com' }).expect(403);
    expect(res.body.code).toBe('personal_key_not_allowed_here');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    res = await personal(request(buildApp()).post('/api/v1/alert-occurrences')).send({ fingerprint: 'f', title: 't', requesterEmail: 'eli.park@example.com' }).expect(403);
    expect(res.body.code).toBe('personal_key_not_allowed_here');
  });

  test('split is refused for every personal key (it creates a ticket); integration keys still split', async () => {
    for (const member of [false, true]) {
      const r = personal(request(buildApp()).post('/api/v1/tickets/501/split'));
      if (member) r.set('x-test-member', '1');
      expect((await r.send({ subject: 'Part two' }).expect(403)).body.code).toBe('personal_key_not_allowed_here');
    }
    expect(splitMock.split).not.toHaveBeenCalled();
    await request(buildApp()).post('/api/v1/tickets/501/split').send({ subject: 'Part two' }).expect(201);
    expect(splitMock.split).toHaveBeenCalledTimes(1);
  });

  test('an agent\'s personal key may not merge, re-parent or add children (403 coordinator_required), as in the app', async () => {
    const calls = [
      ['post', '/api/v1/tickets/501/merge', { target: 502 }],
      ['post', '/api/v1/tickets/501/merge-many', { sources: [502] }],
      ['put', '/api/v1/tickets/501/parent', { parent: 502 }],
      ['delete', '/api/v1/tickets/501/parent', {}],
      ['post', '/api/v1/tickets/501/children', { child: 502 }],
    ];
    for (const [method, path, payload] of calls) {
      const res = await personal(request(buildApp())[method](path)).send(payload).expect(403);
      expect(res.body.code).toBe('coordinator_required');
    }
    expect(mergeMock.merge).not.toHaveBeenCalled();
    expect(mergeMock.mergeMany).not.toHaveBeenCalled();
    expect(linkMock.setParent).not.toHaveBeenCalled();
    expect(linkMock.removeParent).not.toHaveBeenCalled();
    expect(linkMock.addChild).not.toHaveBeenCalled();
  });

  test('a member\'s personal key may, as in the app, and runs as the person; integration keys are not gated', async () => {
    await personal(request(buildApp()).put('/api/v1/tickets/501/parent')).set('x-test-member', '1').send({ parent: 502 }).expect(200);
    expect(linkMock.setParent).toHaveBeenCalledWith(501, 1, { parentTicketId: 502 }, expect.objectContaining({ email: 'dana.fox@example.com', kind: 'member' }));
    await personal(request(buildApp()).post('/api/v1/tickets/501/merge')).set('x-test-member', '1').send({ target: 502 }).expect(200);
    await request(buildApp()).post('/api/v1/tickets/501/merge').send({ target: 502 }).expect(200);
    expect(mergeMock.merge).toHaveBeenCalledTimes(2);
  });

  test('external references are refused for personal keys (alert routing relies on them)', async () => {
    const res = await personal(request(buildApp()).post('/api/v1/tickets/501/references')).send({ reference: { system: 'sentinel', id: 'abc' } }).expect(403);
    expect(res.body.code).toBe('personal_key_not_allowed_here');
    expect(refsMock.addReferences).not.toHaveBeenCalled();
  });

  test('PATCH may not re-point the requester by e-mail or name (that could create one)', async () => {
    const res = await personal(request(buildApp()).patch('/api/v1/tickets/501')).send({ requesterEmail: 'new.person@example.com' }).expect(403);
    expect(res.body.code).toBe('personal_key_not_allowed_here');
    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('PATCH status/priority runs as the person', async () => {
    await personal(request(buildApp()).patch('/api/v1/tickets/501')).send({ priority: 3, status: 'Resolved' }).expect(200);
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(501, 1, { priority: 3 }, PERSONAL_ACTOR);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(501, 1, 'Resolved', PERSONAL_ACTOR, expect.any(Object));
  });

  test('a FreshService-born ticket\'s status is refused, as in the app', async () => {
    fsBornMock.isFreshServiceBorn.mockResolvedValue(true);
    const res = await personal(request(buildApp()).patch('/api/v1/tickets/501')).send({ status: 'Resolved' }).expect(403);
    expect(res.body.code).toBe('fs_status_write_not_enabled');
    expect(fsBornMock.changeFsBornStatus).not.toHaveBeenCalled();
  });
});

describe('/me and /me/guide with a personal key', () => {
  test('/me says who the key acts as and what it can do', async () => {
    const res = await personal(request(buildApp()).get('/api/v1/me')).expect(200);
    expect(res.body.data).toEqual({
      authType: 'personal_key',
      key: { name: 'Laptop script', prefix: 'tpu_AbCdEfGh', scopes: ['tickets:read', 'tickets:write', 'conversations:read', 'conversations:write'], abilities: ['read', 'reply', 'update'], expiresAt: '2027-02-20T00:00:00.000Z' },
      actsAs: { name: 'Dana Fox', email: 'dana.fox@example.com', technicianId: 12, role: 'agent' },
      workspace: { id: 1, name: 'IT', slug: 'it' },
      rateLimit: { perMinute: 60 },
    });
  });

  test('/me/guide returns the guide for this key; other credentials get 403 personal_key_required', async () => {
    personalSvcMock.buildGuide.mockResolvedValue({ markdown: '# guide', filename: 'ticket-pulse-api-guide.md' });
    const res = await personal(request(buildApp()).get('/api/v1/me/guide')).expect(200);
    expect(res.body.data).toEqual({ markdown: '# guide', filename: 'ticket-pulse-api-guide.md' });
    expect(personalSvcMock.buildGuide).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 1,
      baseUrl: 'https://tickets.example.com',
      access: { email: 'dana.fox@example.com', technician: { name: 'Dana Fox' }, readOnly: false },
      key: expect.objectContaining({ name: 'Laptop script', keyPrefix: 'tpu_AbCdEfGh' }),
    }));
    const refused = await request(buildApp()).get('/api/v1/me/guide').expect(403);
    expect(refused.body.code).toBe('personal_key_required');
  });
});
