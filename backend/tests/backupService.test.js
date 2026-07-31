import { jest } from '@jest/globals';
import zlib from 'node:zlib';

/** Backup & Restore (BACKUP_RESTORE_PLAN Phase 2/3) — module export/diff/apply
 *  semantics, set-diff for trusted domains, replace-mode deletions, and the
 *  export-only guarantee for TP-native ticket data. Blob + fs I/O are mocked. */

const prismaMock = {
  workspace: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  noiseRule: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  slaPolicy: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  ticketMacro: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  customFieldDefinition: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  competencyCategory: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  businessHour: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  notificationWorkflow: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  ticket: { findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  ticketTag: { findMany: jest.fn() },
  ticketTagLink: { findMany: jest.fn() },
  ticketLink: { findMany: jest.fn() },
  backupSnapshot: {
    create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), delete: jest.fn(),
  },
  backupSchedule: {
    findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(),
  },
  $transaction: jest.fn((fn) => fn(prismaMock)),
};

const fsMock = {
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  createReadStream: jest.fn(),
  unlinkSync: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
jest.unstable_mockModule('node:fs', () => ({ default: fsMock }));
jest.unstable_mockModule('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
}));

const { default: backupService, MODULES } = await import('../src/services/backupService.js');

const NOISE_RECORDS = [
  {
    id: 5, workspaceId: 1, name: 'Spam blast', pattern: 'spam', description: null,
    category: 'General', isEnabled: true, matchCount: 12, dedupWindowDays: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'),
  },
  {
    id: 6, workspaceId: 1, name: 'Backup report', pattern: 'veeam', description: 'Nightly job noise',
    category: 'Automated', isEnabled: true, matchCount: 3, dedupWindowDays: 7,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  prismaMock.$transaction.mockImplementation((fn) => fn(prismaMock));
  for (const delegate of [
    'noiseRule', 'slaPolicy', 'ticketMacro', 'customFieldDefinition', 'ticketTypeDefinition',
    'competencyCategory', 'businessHour', 'notificationWorkflow',
    'ticket', 'ticketThreadEntry', 'ticketTag', 'ticketTagLink', 'ticketLink',
  ]) {
    prismaMock[delegate].findMany.mockResolvedValue([]);
  }
  prismaMock.noiseRule.create.mockImplementation(async ({ data }) => ({ id: 99, ...data }));
  prismaMock.noiseRule.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  prismaMock.noiseRule.delete.mockResolvedValue({});
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', internalDomains: [] });
});

describe('noiseRules module', () => {
  test('export strips DB ids/workspaceId/counters down to portable fields', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue(NOISE_RECORDS);

    const rows = await MODULES.noiseRules.export(1);

    expect(prismaMock.noiseRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 1 } }),
    );
    expect(rows).toEqual([
      { name: 'Spam blast', pattern: 'spam', description: null, category: 'General', isEnabled: true, dedupWindowDays: null },
      { name: 'Backup report', pattern: 'veeam', description: 'Nightly job noise', category: 'Automated', isEnabled: true, dedupWindowDays: 7 },
    ]);
  });

  test('diff buckets rows into create/update/skip by name', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue(NOISE_RECORDS);

    const diff = await MODULES.noiseRules.diff(1, [
      // identical to existing → skip
      { name: 'Spam blast', pattern: 'spam', description: null, category: 'General', isEnabled: true, dedupWindowDays: null },
      // same key, changed field → update
      { name: 'Backup report', pattern: 'veeam|commvault', description: 'Nightly job noise', category: 'Automated', isEnabled: true, dedupWindowDays: 7 },
      // unknown key → create
      { name: 'Scanner', pattern: 'scan-to-email', description: null, category: 'General', isEnabled: false, dedupWindowDays: null },
    ]);

    expect(diff.skip).toEqual([{ key: 'Spam blast' }]);
    expect(diff.update.map((e) => e.key)).toEqual(['Backup report']);
    expect(diff.create.map((e) => e.key)).toEqual(['Scanner']);
    expect(diff.conflicts).toEqual([]);
  });

  test('apply merge upserts (create + update + skip) and never deletes', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue(NOISE_RECORDS);

    const counts = await MODULES.noiseRules.apply(1, [
      { name: 'Spam blast', pattern: 'spam', description: null, category: 'General', isEnabled: true, dedupWindowDays: null },
      { name: 'Backup report', pattern: 'veeam|commvault', description: 'Nightly job noise', category: 'Automated', isEnabled: true, dedupWindowDays: 7 },
      { name: 'Scanner', pattern: 'scan-to-email', description: null, category: 'General', isEnabled: false, dedupWindowDays: null },
    ], 'merge');

    expect(counts).toEqual({ created: 1, updated: 1, skipped: 1, deleted: 0, conflicts: 0 });
    expect(prismaMock.noiseRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: 1, name: 'Scanner', pattern: 'scan-to-email', isEnabled: false }),
    });
    expect(prismaMock.noiseRule.update).toHaveBeenCalledWith({
      where: { id: 6 },
      data: expect.objectContaining({ pattern: 'veeam|commvault' }),
    });
    expect(prismaMock.noiseRule.delete).not.toHaveBeenCalled();
  });

  test('apply replace deletes rows absent from the snapshot, then upserts', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue(NOISE_RECORDS);

    const counts = await MODULES.noiseRules.apply(1, [
      { name: 'Spam blast', pattern: 'spam', description: null, category: 'General', isEnabled: true, dedupWindowDays: null },
    ], 'replace');

    // "Backup report" is not in the snapshot → deleted; "Spam blast" unchanged → skipped.
    expect(prismaMock.noiseRule.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.noiseRule.delete).toHaveBeenCalledWith({ where: { id: 6 } });
    expect(counts).toEqual({ created: 0, updated: 0, skipped: 1, deleted: 1, conflicts: 0 });
  });
});

describe('trustedDomains module', () => {
  test('diff treats domains as a case/order-insensitive set', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['BGCengineering.ca', 'bgc.ca'] });

    const same = await MODULES.trustedDomains.diff(1, [
      { key: 'internalDomains', domains: ['bgc.ca', 'bgcengineering.ca'] },
    ]);
    expect(same.skip).toEqual([{ key: 'internalDomains' }]);
    expect(same.update).toEqual([]);

    const changed = await MODULES.trustedDomains.diff(1, [
      { key: 'internalDomains', domains: ['bgcengineering.ca', 'newco.com'] },
    ]);
    expect(changed.skip).toEqual([]);
    expect(changed.update).toEqual([
      { key: 'internalDomains', row: { key: 'internalDomains', domains: ['bgcengineering.ca', 'newco.com'] } },
    ]);
  });

  test('apply writes the normalized set to Workspace.internalDomains', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['bgc.ca'] });

    const counts = await MODULES.trustedDomains.apply(1, [
      { key: 'internalDomains', domains: ['NewCo.com', 'bgc.ca', 'newco.com'] },
    ], 'merge');

    expect(counts).toEqual({ created: 0, updated: 1, skipped: 0, deleted: 0, conflicts: 0 });
    expect(prismaMock.workspace.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { internalDomains: ['bgc.ca', 'newco.com'] },
    });
  });

  test('apply skips (no write) when the set already matches', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['bgc.ca', 'newco.com'] });

    const counts = await MODULES.trustedDomains.apply(1, [
      { key: 'internalDomains', domains: ['NEWCO.com', 'bgc.ca'] },
    ], 'replace');

    expect(counts.skipped).toBe(1);
    expect(prismaMock.workspace.update).not.toHaveBeenCalled();
  });
});

describe('tier config_data modules are export-only', () => {
  test.each(['nativeTickets', 'nativeThreads', 'ticketTags', 'ticketTagLinks', 'ticketLinks'])(
    '%s: diff reports not-restorable and apply refuses',
    async (name) => {
      const mod = MODULES[name];
      expect(mod.restorable).toBe(false);

      const diff = await mod.diff(1, []);
      expect(diff.restorable).toBe(false);
      expect(diff).toMatchObject({ create: [], update: [], skip: [], conflicts: [] });

      await expect(mod.apply(1, [], 'merge')).rejects.toThrow(/export-only/);
    },
  );

  test('applyRestore rejects a config_data module before touching anything', async () => {
    const bundle = {
      manifest: { formatVersion: 1, scope: 'workspace', tier: 'config_data', workspaceId: 1 },
      modules: { nativeTickets: [] },
    };
    prismaMock.backupSnapshot.findUnique.mockResolvedValue({
      id: 7, scope: 'workspace', workspaceId: 1, tier: 'config_data',
      status: 'completed', blobName: 'local:ws-1-2026-07-31-7.json.gz',
    });
    fsMock.readFileSync.mockReturnValue(zlib.gzipSync(Buffer.from(JSON.stringify(bundle))));

    await expect(backupService.applyRestore(7, {
      targetWorkspaceId: 1,
      modules: ['nativeTickets'],
      mode: 'merge',
    })).rejects.toThrow(/export-only/);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe('createSnapshot (local fallback, no Azure connection string)', () => {
  test('gathers config modules, gzips locally, and completes the row', async () => {
    const createdAt = new Date('2026-07-31T09:00:00Z');
    prismaMock.backupSnapshot.create.mockResolvedValue({
      id: 42, scope: 'workspace', workspaceId: 1, tier: 'config', status: 'running', createdAt,
    });
    prismaMock.backupSnapshot.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
    prismaMock.noiseRule.findMany.mockResolvedValue([NOISE_RECORDS[0]]);
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', internalDomains: ['bgc.ca'] });

    const snapshot = await backupService.createSnapshot({
      scope: 'workspace', workspaceId: 1, tier: 'config', trigger: 'manual', actorEmail: 'admin@bgc.ca',
    });

    expect(snapshot.status).toBe('completed');
    expect(snapshot.blobName).toBe('local:ws-1-2026-07-31-42.json.gz');
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);

    // The written artifact must be a gzipped {manifest, modules} JSON bundle.
    const written = fsMock.writeFileSync.mock.calls[0][1];
    const bundle = JSON.parse(zlib.gunzipSync(written).toString('utf8'));
    expect(bundle.manifest).toMatchObject({
      formatVersion: 1, scope: 'workspace', tier: 'config', workspaceId: 1, workspaceName: 'IT',
    });
    expect(bundle.manifest.counts.noiseRules).toBe(1);
    expect(bundle.modules.noiseRules).toEqual([
      { name: 'Spam blast', pattern: 'spam', description: null, category: 'General', isEnabled: true, dedupWindowDays: null },
    ]);
    // Data modules are excluded from the config tier entirely.
    expect(bundle.modules.nativeTickets).toBeUndefined();
    expect(snapshot.sizeBytes).toBe(written.length);
  });

  test('a failing export marks the snapshot row failed with the error message', async () => {
    prismaMock.backupSnapshot.create.mockResolvedValue({
      id: 43, scope: 'workspace', workspaceId: 1, tier: 'config', status: 'running', createdAt: new Date(),
    });
    prismaMock.backupSnapshot.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
    prismaMock.noiseRule.findMany.mockRejectedValue(new Error('db exploded'));

    const snapshot = await backupService.createSnapshot({ scope: 'workspace', workspaceId: 1 });

    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('db exploded');
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('dryRunRestore', () => {
  test('returns per-module counts and {key, action} items without writing', async () => {
    const bundle = {
      manifest: { formatVersion: 1, scope: 'workspace', tier: 'config', workspaceId: 2 },
      modules: {
        noiseRules: [
          { name: 'Spam blast', pattern: 'spam', description: null, category: 'General', isEnabled: true, dedupWindowDays: null },
          { name: 'Scanner', pattern: 'scan', description: null, category: 'General', isEnabled: true, dedupWindowDays: null },
        ],
      },
    };
    prismaMock.backupSnapshot.findUnique.mockResolvedValue({
      id: 9, scope: 'workspace', workspaceId: 2, tier: 'config',
      status: 'completed', blobName: 'local:ws-2-2026-07-31-9.json.gz',
    });
    fsMock.readFileSync.mockReturnValue(zlib.gzipSync(Buffer.from(JSON.stringify(bundle))));
    prismaMock.noiseRule.findMany.mockResolvedValue([NOISE_RECORDS[0]]); // target ws already has "Spam blast"

    const result = await backupService.dryRunRestore(9, { targetWorkspaceId: 1, modules: ['noiseRules'] });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]).toMatchObject({
      module: 'noiseRules',
      restorable: true,
      counts: { create: 1, update: 0, skip: 1, conflicts: 0 },
    });
    expect(result.modules[0].items).toEqual(expect.arrayContaining([
      { key: 'Scanner', action: 'create' },
      { key: 'Spam blast', action: 'skip' },
    ]));
    expect(prismaMock.noiseRule.create).not.toHaveBeenCalled();
    expect(prismaMock.noiseRule.update).not.toHaveBeenCalled();
  });
});
