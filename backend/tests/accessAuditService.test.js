import { jest, describe, expect, test, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * Access history + new-credential alerts (20 Nov 2026). An IT member was made
 * admin for 1 h 40 min, created a broad API key, and was put back; the only
 * trace was a rotating server log line.
 */

const prismaMock = {
  accessAuditEvent: { create: jest.fn(), findMany: jest.fn() },
  workspace: { findUnique: jest.fn().mockResolvedValue({ name: 'IT' }) },
};
const mailMock = { deliverTransactionalEmail: jest.fn().mockResolvedValue({ sent: true }) };
const recipientsMock = { reportRecipients: jest.fn().mockResolvedValue(['admin1@bgc.ca', 'super@bgc.ca']) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => mailMock);
jest.unstable_mockModule('../src/services/reportRecipients.js', () => recipientsMock);
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://ticketpulse.example' }));

const svc = await import('../src/services/accessAuditService.js');
const { ACTIONS } = svc;
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const KEY = { id: 11, name: 'Mo_TicketPulse_API', keyPrefix: 'tp_live_1tUh19a3', scopes: ['tickets:read', 'tickets:write'], ipAllowlist: [], expiresAt: null, key: 'tp_live_SECRET_must_not_leak' };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.accessAuditEvent.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
});

describe('recording', () => {
  test('a role change is stored with actor, target, old and new role (lower-cased e-mails)', async () => {
    await svc.recordAccessEvent({ workspaceId: 1, actorEmail: 'SXU@bgc.ca', action: ACTIONS.ROLE_CHANGED, targetEmail: 'MO@bgc.ca', oldValue: 'reviewer', newValue: 'admin' });
    expect(prismaMock.accessAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ workspaceId: 1, actorEmail: 'sxu@bgc.ca', action: 'role_changed', targetEmail: 'mo@bgc.ca', oldValue: 'reviewer', newValue: 'admin' }) });
  });

  test('a storage failure never throws (auditing must not break the change)', async () => {
    prismaMock.accessAuditEvent.create.mockRejectedValue(new Error('relation does not exist'));
    await expect(svc.recordAccessEvent({ workspaceId: 1, action: ACTIONS.ROLE_GRANTED })).resolves.toBeNull();
  });
});

describe('credential events', () => {
  test('a new API key is recorded without its secret and alerts the workspace admins and super admins', async () => {
    await svc.recordCredentialEvent({ workspaceId: 1, actorEmail: 'mo@bgc.ca', action: ACTIONS.API_KEY_CREATED, credential: KEY });
    const stored = prismaMock.accessAuditEvent.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({ action: 'api_key_created', targetLabel: 'Mo_TicketPulse_API' });
    expect(JSON.stringify(stored)).not.toContain('SECRET');
    expect(recipientsMock.reportRecipients).toHaveBeenCalledWith(1);
    const mail = mailMock.deliverTransactionalEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['admin1@bgc.ca', 'super@bgc.ca']);
    expect(mail.subject).toBe('New API key in IT: "Mo_TicketPulse_API"');
    expect(mail.text).toContain('Who: mo@bgc.ca');
    expect(mail.text).toContain('IP lock: none: it works from any address');
    expect(mail.text).toContain('https://ticketpulse.example/settings#api-keys');
    expect(mail.html + mail.text).not.toContain('SECRET');
  });

  test('rotation and switching back on alert; revoke, delete and plain edits do not', async () => {
    for (const action of [ACTIONS.API_KEY_ROTATED, ACTIONS.API_KEY_ENABLED, ACTIONS.OAUTH_CLIENT_CREATED, ACTIONS.OAUTH_CLIENT_ROTATED, ACTIONS.OAUTH_CLIENT_ENABLED]) {
      jest.clearAllMocks();
      prismaMock.accessAuditEvent.create.mockResolvedValue({ id: 2 });
      await svc.recordCredentialEvent({ workspaceId: 1, actorEmail: 'a@bgc.ca', action, credential: KEY });
      expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledTimes(1);
    }
    for (const action of [ACTIONS.API_KEY_REVOKED, ACTIONS.API_KEY_DELETED, ACTIONS.API_KEY_UPDATED, ACTIONS.OAUTH_CLIENT_UPDATED, ACTIONS.OAUTH_CLIENT_REVOKED, ACTIONS.OAUTH_CLIENT_DELETED]) {
      jest.clearAllMocks();
      prismaMock.accessAuditEvent.create.mockResolvedValue({ id: 3 });
      await svc.recordCredentialEvent({ workspaceId: 1, actorEmail: 'a@bgc.ca', action, credential: KEY });
      expect(mailMock.deliverTransactionalEmail).not.toHaveBeenCalled();
    }
  });

  test('a failing mail does not fail the change', async () => {
    mailMock.deliverTransactionalEmail.mockRejectedValueOnce(new Error('graph 503'));
    await expect(svc.recordCredentialEvent({ workspaceId: 1, actorEmail: 'a@bgc.ca', action: ACTIONS.API_KEY_CREATED, credential: KEY })).resolves.toMatchObject({ id: 1 });
  });

  test('the alert names OAuth client ids, trusted intake, the IP lock and the expiry', () => {
    const { subject, text } = svc.renderCredentialAlert({
      workspaceName: 'IT', actorEmail: 'vh@bgc.ca', action: ACTIONS.OAUTH_CLIENT_ROTATED, settingsUrl: 'u',
      credential: { name: 'Simorgh' },
      details: { scopes: ['tickets:read'], ipAllowlist: ['1.2.3.4'], expiresAt: '2027-01-31T00:00:00Z', trustedIntake: true, prefix: 'tpc_abc' },
    });
    expect(subject).toBe('New OAuth client in IT: "Simorgh" (new secret)');
    expect(text).toContain('IP lock: 1.2.3.4');
    expect(text).toContain('Expires: 2027-01-31');
    expect(text).toContain('Trusted intake: yes');
    expect(text).toContain('Client id: tpc_abc');
  });
});

describe('history', () => {
  test('a workspace admin sees the workspace only; a super admin also sees app-wide events; person filters', async () => {
    prismaMock.accessAuditEvent.findMany.mockResolvedValue([]);
    await svc.listAccessEvents(1, { includeGlobal: false });
    expect(prismaMock.accessAuditEvent.findMany.mock.calls[0][0].where).toEqual({ AND: [{ workspaceId: 1 }] });
    await svc.listAccessEvents(1, { includeGlobal: true, person: 'Mo', before: 50 });
    const w = prismaMock.accessAuditEvent.findMany.mock.calls[1][0].where;
    expect(w.AND[0]).toEqual({ OR: [{ workspaceId: 1 }, { workspaceId: null }] });
    expect(w.AND[1]).toEqual({ id: { lt: 50 } });
    expect(JSON.stringify(w.AND[2])).toContain('"mo"');
  });
});

describe('wiring (source guards)', () => {
  test('every role and credential route records its change', () => {
    const ws = src('../src/routes/workspace.routes.js');
    expect(ws).toContain('ACTIONS.ROLE_CHANGED : ACTIONS.ROLE_GRANTED');
    expect(ws).toContain('ACTIONS.ACCESS_REVOKED');
    expect(ws).toContain("'/:id/access-history'");
    const t = src('../src/routes/tickets.routes.js');
    for (const a of ['API_KEY_CREATED', 'API_KEY_ROTATED', 'API_KEY_REVOKED', 'API_KEY_DELETED', 'API_KEY_UPDATED', 'OAUTH_CLIENT_CREATED', 'OAUTH_CLIENT_ROTATED', 'OAUTH_CLIENT_REVOKED', 'OAUTH_CLIENT_DELETED', 'OAUTH_CLIENT_UPDATED']) {
      expect(t).toContain(`ACTIONS.${a}`);
    }
    expect(src('../src/routes/settings.routes.js')).toContain('ACTIONS.ADMIN_LIST_CHANGED');
  });
});
