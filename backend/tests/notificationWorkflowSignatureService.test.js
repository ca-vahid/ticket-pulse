import { jest } from '@jest/globals';

const prismaMock = {
  $transaction: jest.fn((callback) => callback(prismaMock)),
  notificationEmailBlock: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  notificationEmailSignature: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

const {
  MAX_SIGNATURE_HTML_BYTES,
  applyWorkspaceEmailBranding,
  getWorkspaceSignature,
  listWorkspaceEmailBlocks,
  sanitizeSignatureHtml,
  setDefaultWorkspaceEmailBlock,
  upsertWorkspaceSignature,
} = await import('../src/services/notificationWorkflowSignatureService.js');

describe('notification workflow email branding blocks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock));
    prismaMock.notificationEmailBlock.findMany.mockResolvedValue([]);
    prismaMock.notificationEmailBlock.findFirst.mockResolvedValue(null);
    prismaMock.notificationEmailBlock.create.mockImplementation(({ data }) => Promise.resolve({
      id: 100,
      createdAt: new Date('2026-06-02T00:00:00.000Z'),
      updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      ...data,
    }));
    prismaMock.notificationEmailBlock.update.mockImplementation(({ where, data }) => Promise.resolve({
      id: where.id,
      workspaceId: 1,
      type: 'footer',
      name: 'Default footer',
      enabled: true,
      isDefault: false,
      html: '<p>Footer</p>',
      text: 'Footer',
      ...data,
    }));
    prismaMock.notificationEmailBlock.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
    prismaMock.notificationEmailSignature.upsert.mockImplementation(({ create, update }) => Promise.resolve({
      id: 5,
      workspaceId: create.workspaceId,
      ...create,
      ...update,
    }));
  });

  test('sanitizes unsafe HTML and rejects oversized blocks', () => {
    const sanitized = sanitizeSignatureHtml('<div>IT</div><script>alert(1)</script><img src="javascript:alert(1)">');

    expect(sanitized).toContain('IT');
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('javascript:');
    expect(() => sanitizeSignatureHtml('x'.repeat(MAX_SIGNATURE_HTML_BYTES + 1))).toThrow(/exceeds/);
  });

  test('lists workspace-scoped blocks grouped by type', async () => {
    prismaMock.notificationEmailBlock.findMany.mockResolvedValue([
      { id: 2, workspaceId: 9, type: 'footer', name: 'Footer', enabled: true, isDefault: true, html: '<p>F</p>', text: 'F' },
      { id: 1, workspaceId: 9, type: 'header', name: 'Header', enabled: true, isDefault: false, html: '<p>H</p>', text: 'H' },
    ]);

    const result = await listWorkspaceEmailBlocks(9);

    expect(prismaMock.notificationEmailBlock.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 9 },
    }));
    expect(result.headers.map((block) => block.name)).toEqual(['Header']);
    expect(result.footers.map((block) => block.name)).toEqual(['Footer']);
  });

  test('sets exactly one default block for a workspace and type', async () => {
    prismaMock.notificationEmailBlock.findFirst.mockResolvedValue({
      id: 22,
      workspaceId: 7,
      type: 'footer',
      name: 'Alternate footer',
      enabled: true,
      isDefault: false,
      html: '<p>Alt</p>',
      text: 'Alt',
    });

    const result = await setDefaultWorkspaceEmailBlock(7, 22, { email: 'admin@example.com' });

    expect(prismaMock.notificationEmailBlock.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 7,
        type: 'footer',
        isDefault: true,
        id: { not: 22 },
      },
      data: { isDefault: false },
    });
    expect(prismaMock.notificationEmailBlock.update).toHaveBeenCalledWith({
      where: { id: 22 },
      data: {
        isDefault: true,
        enabled: true,
        updatedBy: 'admin@example.com',
      },
    });
    expect(result.isDefault).toBe(true);
  });

  test('legacy signature API maps to the default footer block', async () => {
    prismaMock.notificationEmailBlock.findFirst.mockResolvedValue({
      id: 12,
      workspaceId: 3,
      type: 'footer',
      name: 'Default footer',
      enabled: true,
      isDefault: true,
      html: '<p>Footer</p>',
      text: 'Footer',
      updatedBy: 'admin@example.com',
      updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    });

    const signature = await getWorkspaceSignature(3);

    expect(signature).toEqual(expect.objectContaining({
      enabled: true,
      html: '<p>Footer</p>',
      text: 'Footer',
      blockId: 12,
      blockName: 'Default footer',
    }));
  });

  test('legacy signature upsert writes the default footer block and legacy row', async () => {
    const result = await upsertWorkspaceSignature(4, { enabled: true, html: '<p>IT</p>' }, { email: 'admin@example.com' });

    expect(prismaMock.notificationEmailSignature.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 4 },
      create: expect.objectContaining({ workspaceId: 4, enabled: true, html: '<p>IT</p>', text: 'IT' }),
      update: expect.objectContaining({ enabled: true, html: '<p>IT</p>', text: 'IT' }),
    }));
    expect(prismaMock.notificationEmailBlock.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: 4,
        type: 'footer',
        name: 'Default footer',
        enabled: true,
        isDefault: true,
        html: '<p>IT</p>',
        text: 'IT',
        updatedBy: 'admin@example.com',
      }),
    }));
    expect(result).toEqual(expect.objectContaining({ workspaceId: 4, type: 'footer' }));
  });

  test('applies selected header before body and default footer after body', async () => {
    prismaMock.notificationEmailBlock.findFirst.mockImplementation(({ where }) => {
      if (where.id === 31) {
        return Promise.resolve({
          id: 31,
          workspaceId: 1,
          type: 'header',
          name: 'Header',
          enabled: true,
          isDefault: false,
          html: '<p>Header</p>',
          text: 'Header',
        });
      }
      if (where.type === 'footer' && where.isDefault) {
        return Promise.resolve({
          id: 41,
          workspaceId: 1,
          type: 'footer',
          name: 'Default footer',
          enabled: true,
          isDefault: true,
          html: '<p>Footer</p>',
          text: 'Footer',
        });
      }
      return Promise.resolve(null);
    });

    const result = await applyWorkspaceEmailBranding({
      workspaceId: 1,
      email: { subject: 'Subject', html: '<p>Body</p>', text: 'Body' },
      nodeData: {
        includeHeader: true,
        headerBlockId: 31,
        includeFooter: true,
        footerBlockId: null,
      },
    });

    expect(result.html).toBe('<p>Header</p>\n<p>Body</p>\n<p>Footer</p>');
    expect(result.text).toBe('Header\n\nBody\n\nFooter');
    expect(result.headerApplied).toBe(true);
    expect(result.footerApplied).toBe(true);
    expect(result.branding.header.blockName).toBe('Header');
    expect(result.branding.footer.blockName).toBe('Default footer');
  });

  test('missing selected footer falls back to default and records warning', async () => {
    prismaMock.notificationEmailBlock.findFirst.mockImplementation(({ where }) => {
      if (where.id === 999) return Promise.resolve(null);
      if (where.type === 'footer' && where.isDefault) {
        return Promise.resolve({
          id: 41,
          workspaceId: 1,
          type: 'footer',
          name: 'Default footer',
          enabled: true,
          isDefault: true,
          html: '<p>Footer</p>',
          text: 'Footer',
        });
      }
      return Promise.resolve(null);
    });

    const result = await applyWorkspaceEmailBranding({
      workspaceId: 1,
      email: { html: '<p>Body</p>', text: 'Body' },
      nodeData: {
        includeFooter: true,
        footerBlockId: 999,
      },
    });

    expect(result.footerApplied).toBe(true);
    expect(result.footerBlockName).toBe('Default footer');
    expect(result.branding.footer.fallback).toBe(true);
    expect(result.brandingWarnings[0]).toMatch(/not found/i);
  });
});
