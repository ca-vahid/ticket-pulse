import { jest } from '@jest/globals';

/**
 * Mega 08-15 Phase D — per-user email signatures.
 *
 * CRUD keyed (workspaceId, ownerEmail), sanitization through the shared
 * permissive email allowlist (tables/img/data-images survive; scripts die),
 * the append helper's separators, and mass-apply template substitution.
 */

const prismaMock = {
  userEmailSignature: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
  },
  technician: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
};
const azureAdServiceMock = {
  isConfigured: jest.fn().mockReturnValue(false),
  getUserProfile: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureAdServiceMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  getSignature,
  saveSignature,
  getEnabledSignatureForSend,
  appendSignatureToEmail,
  applySignatureTemplate,
  massApplySignatureTemplate,
  listWorkspaceSignatures,
  resolveSignatureWorkspaceId,
} = await import('../src/services/userSignatureService.js');
const { ValidationError } = await import('../src/utils/errors.js');

beforeEach(() => {
  jest.clearAllMocks();
  azureAdServiceMock.isConfigured.mockReturnValue(false);
  prismaMock.userEmailSignature.upsert.mockImplementation(({ create, update, where }) => Promise.resolve({
    id: 7,
    workspaceId: where.workspaceId_ownerEmail.workspaceId,
    ownerEmail: where.workspaceId_ownerEmail.ownerEmail,
    ...create,
    ...update,
    updatedAt: new Date('2026-08-15T10:00:00Z'),
  }));
});

describe('userSignatureService CRUD + sanitize', () => {
  test('getSignature returns an empty default when no row exists', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
    const sig = await getSignature(1, 'Agent@Example.com');
    expect(sig).toMatchObject({ workspaceId: 1, ownerEmail: 'agent@example.com', exists: false, enabled: false, html: '' });
  });

  test('saveSignature sanitizes html (script/onerror out, table + inline style kept) and derives text', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
    const dirty = '<table style="border-collapse:collapse"><tr><td style="color:#0a58ca">Ana Agent</td></tr></table>'
      + '<script>alert(1)</script><img src="https://cdn.example/logo.png" onerror="alert(2)">';
    const saved = await saveSignature(1, 'agent@example.com', { html: dirty });
    expect(saved.html).toContain('<table');
    expect(saved.html).toContain('color:#0a58ca');
    expect(saved.html).not.toContain('<script');
    expect(saved.html).not.toContain('onerror');
    expect(saved.text).toContain('Ana Agent');
    expect(saved.enabled).toBe(true);
    expect(prismaMock.userEmailSignature.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_ownerEmail: { workspaceId: 1, ownerEmail: 'agent@example.com' } },
    }));
  });

  test('saveSignature keeps data:image sources (pasted logos) within the 512KB budget', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
    const html = '<p>Sig</p><img src="data:image/png;base64,iVBORw0KGgo=">';
    const saved = await saveSignature(1, 'agent@example.com', { html });
    expect(saved.html).toContain('data:image/png;base64');
  });

  test('saveSignature rejects oversize html', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
    const big = `<p>${'x'.repeat(600 * 1024)}</p>`;
    await expect(saveSignature(1, 'agent@example.com', { html: big })).rejects.toThrow(/512 KB/);
  });

  test('enabled-only toggle preserves the stored html', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue({
      id: 7, workspaceId: 1, ownerEmail: 'agent@example.com', enabled: true, html: '<p>Keep me</p>', text: 'Keep me',
    });
    const saved = await saveSignature(1, 'agent@example.com', { enabled: false }, 'admin@example.com');
    expect(saved.enabled).toBe(false);
    expect(saved.html).toBe('<p>Keep me</p>');
    expect(prismaMock.userEmailSignature.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ enabled: false, html: '<p>Keep me</p>', updatedBy: 'admin@example.com' }),
    }));
  });

  test('invalid owner email is rejected', async () => {
    await expect(getSignature(1, 'not-an-email')).rejects.toThrow(ValidationError);
  });
});

describe('getEnabledSignatureForSend', () => {
  test('returns html+text for an enabled signature with content', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue({
      enabled: true, html: '<p>— Ana</p>', text: '— Ana',
    });
    await expect(getEnabledSignatureForSend(1, 'Agent@Example.com')).resolves.toEqual({ html: '<p>— Ana</p>', text: '— Ana' });
    expect(prismaMock.userEmailSignature.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_ownerEmail: { workspaceId: 1, ownerEmail: 'agent@example.com' } },
    });
  });

  test('returns null when disabled, empty, missing, or on lookup error (never throws)', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue({ enabled: false, html: '<p>x</p>' });
    await expect(getEnabledSignatureForSend(1, 'a@b.co')).resolves.toBeNull();
    prismaMock.userEmailSignature.findUnique.mockResolvedValue({ enabled: true, html: '  ', text: '' });
    await expect(getEnabledSignatureForSend(1, 'a@b.co')).resolves.toBeNull();
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
    await expect(getEnabledSignatureForSend(1, 'a@b.co')).resolves.toBeNull();
    prismaMock.userEmailSignature.findUnique.mockRejectedValue(new Error('db down'));
    await expect(getEnabledSignatureForSend(1, 'a@b.co')).resolves.toBeNull();
    await expect(getEnabledSignatureForSend(1, null)).resolves.toBeNull();
  });
});

describe('appendSignatureToEmail', () => {
  test('appends html with a blank-line separator and text with the "-- " delimiter', () => {
    const out = appendSignatureToEmail(
      { html: '<p>Fixed it!</p>', text: 'Fixed it!' },
      { html: '<p><strong>Ana</strong></p>', text: 'Ana' },
    );
    expect(out.html).toBe('<p>Fixed it!</p><br><br><p><strong>Ana</strong></p>');
    expect(out.text).toBe('Fixed it!\n\n-- \nAna');
  });

  test('no-op for an empty signature; base preserved', () => {
    const email = { html: '<p>Hi</p>', text: 'Hi' };
    expect(appendSignatureToEmail(email, { html: '', text: '' })).toEqual(email);
    expect(appendSignatureToEmail(email, null)).toEqual(email);
  });

  test('signature-only when the base body is empty; text derived from html when missing', () => {
    const out = appendSignatureToEmail({ html: '', text: '' }, { html: '<p>Ana</p>' });
    expect(out.html).toBe('<p>Ana</p>');
    expect(out.text).toBe('Ana');
  });
});

describe('template substitution + mass apply', () => {
  test('applySignatureTemplate replaces {{name}}/{{title}}/{{email}} (whitespace tolerant)', () => {
    const out = applySignatureTemplate(
      '<p>{{ name }} — {{TITLE}} · {{email}}</p>',
      { name: 'Ana Agent', title: 'IT Analyst', email: 'ana@bgc.ca' },
    );
    expect(out).toBe('<p>Ana Agent — IT Analyst · ana@bgc.ca</p>');
  });

  test('preview substitutes per member WITHOUT writing', async () => {
    prismaMock.technician.findMany.mockResolvedValue([
      { id: 11, name: 'Ana Agent', email: 'ana@bgc.ca' },
      { id: 12, name: 'No Email', email: null },
    ]);
    const result = await massApplySignatureTemplate(1, {
      template: '<p><strong>{{name}}</strong><br>{{email}}</p>',
      technicianIds: [11, 12],
      preview: true,
    });
    expect(result.preview).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].html).toContain('<strong>Ana Agent</strong>');
    expect(result.results[0].html).toContain('ana@bgc.ca');
    expect(result.skipped).toEqual([{ technicianId: 12, name: 'No Email', reason: 'No email on file' }]);
    expect(prismaMock.userEmailSignature.upsert).not.toHaveBeenCalled();
  });

  test('apply upserts an ENABLED signature per selected member, title from Entra when configured', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 11, name: 'Ana Agent', email: 'ana@bgc.ca' }]);
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
    azureAdServiceMock.isConfigured.mockReturnValue(true);
    azureAdServiceMock.getUserProfile.mockResolvedValue({ jobTitle: 'IT Analyst' });

    const result = await massApplySignatureTemplate(1, {
      template: '<p>{{name}} — {{title}}</p>',
      technicianIds: [11],
    }, { email: 'admin@bgc.ca' });

    expect(result.applied).toBe(1);
    expect(prismaMock.userEmailSignature.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_ownerEmail: { workspaceId: 1, ownerEmail: 'ana@bgc.ca' } },
      create: expect.objectContaining({
        enabled: true,
        html: expect.stringContaining('Ana Agent — IT Analyst'),
        updatedBy: 'admin@bgc.ca',
      }),
    }));
  });

  test('rejects an empty template or empty selection', async () => {
    await expect(massApplySignatureTemplate(1, { template: '  ', technicianIds: [1] })).rejects.toThrow(ValidationError);
    await expect(massApplySignatureTemplate(1, { template: '<p>x</p>', technicianIds: [] })).rejects.toThrow(ValidationError);
  });
});

describe('workspace joins + resolution', () => {
  test('listWorkspaceSignatures joins technicians with signature rows and keeps orphan owners', async () => {
    prismaMock.technician.findMany.mockResolvedValue([
      { id: 11, name: 'Ana Agent', email: 'ana@bgc.ca', photoUrl: null, isActive: true, origin: 'freshservice' },
      { id: 12, name: 'Ben Local', email: 'ben@bgc.ca', photoUrl: null, isActive: true, origin: 'local' },
    ]);
    prismaMock.userEmailSignature.findMany.mockResolvedValue([
      { id: 1, workspaceId: 1, ownerEmail: 'ana@bgc.ca', enabled: true, html: '<p>Ana</p>', text: 'Ana' },
      { id: 2, workspaceId: 1, ownerEmail: 'coordinator@bgc.ca', enabled: true, html: '<p>Coo</p>', text: 'Coo' },
    ]);
    const { members } = await listWorkspaceSignatures(1);
    expect(members).toHaveLength(3);
    expect(members[0]).toMatchObject({ technicianId: 11, signature: expect.objectContaining({ enabled: true }) });
    expect(members[1]).toMatchObject({ technicianId: 12, signature: null });
    expect(members[2]).toMatchObject({ technicianId: null, email: 'coordinator@bgc.ca' });
  });

  test('resolveSignatureWorkspaceId prefers the explicit id, falls back to the technician profile', async () => {
    await expect(resolveSignatureWorkspaceId('a@b.co', '3')).resolves.toBe(3);
    prismaMock.technician.findFirst.mockResolvedValue({ workspaceId: 2 });
    await expect(resolveSignatureWorkspaceId('a@b.co')).resolves.toBe(2);
    prismaMock.technician.findFirst.mockResolvedValue(null);
    await expect(resolveSignatureWorkspaceId('a@b.co')).rejects.toThrow(/workspaceId is required/);
  });
});
