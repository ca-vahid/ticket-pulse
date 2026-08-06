import { jest } from '@jest/globals';

/**
 * Backup taxonomy module under per-parent name uniqueness: the natural key is
 * parentName+NUL+name, so snapshots with same-named subs under different
 * parents export, diff, and restore without collapsing. Legacy rows missing
 * the parentName property match by bare name only when unambiguous.
 */

const prismaMock = {
  competencyCategory: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  backupSnapshot: { findMany: jest.fn() },
  backupSchedule: { findMany: jest.fn() },
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

const { MODULES } = await import('../src/services/backupService.js');

const base = { description: null, isActive: true, isSystemSuggested: false, source: 'manual', sortOrder: 0 };
const TARGET_RECORDS = [
  { id: 1, name: 'Project Setup', parentId: null, parent: null, ...base },
  { id: 2, name: 'Accounting', parentId: null, parent: null, ...base },
  { id: 3, name: 'Quebec', parentId: 1, parent: { name: 'Project Setup' }, ...base },
  { id: 4, name: 'Quebec', parentId: 2, parent: { name: 'Accounting' }, ...base },
];

beforeEach(() => {
  for (const fn of Object.values(prismaMock.competencyCategory)) fn.mockReset();
  prismaMock.$transaction.mockImplementation((fn) => fn(prismaMock));
});

describe('taxonomy export/diff with per-parent duplicate names', () => {
  test('export keeps both same-named subs, parents first', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue(TARGET_RECORDS);
    const rows = await MODULES.taxonomy.export(1);
    expect(rows.map((row) => [row.name, row.parentName])).toEqual([
      ['Project Setup', null], ['Accounting', null],
      ['Quebec', 'Project Setup'], ['Quebec', 'Accounting'],
    ]);
  });

  test('round-trip diff of the own export is all skips', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue(TARGET_RECORDS);
    const rows = await MODULES.taxonomy.export(1);
    prismaMock.competencyCategory.findMany.mockResolvedValue(TARGET_RECORDS);
    const diff = await MODULES.taxonomy.diff(1, rows);
    expect(diff.skip).toHaveLength(4);
    expect(diff.create).toEqual([]);
    expect(diff.update).toEqual([]);
    expect(diff.conflicts).toEqual([]);
    expect(diff.remove).toEqual([]);
  });

  test('same-named subs under different parents are distinct diff keys (no in-snapshot dup conflict)', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([]);
    const diff = await MODULES.taxonomy.diff(1, [
      { name: 'Project Setup', parentName: null, ...base },
      { name: 'Accounting', parentName: null, ...base },
      { name: 'Quebec', parentName: 'Project Setup', ...base },
      { name: 'Quebec', parentName: 'Accounting', ...base },
    ]);
    expect(diff.create).toHaveLength(4);
    expect(diff.conflicts).toEqual([]);
  });
});

describe('taxonomy apply', () => {
  test('restores per-parent duplicates into an empty workspace, resolving each parent', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([]);
    let nextId = 100;
    const created = [];
    prismaMock.competencyCategory.create.mockImplementation(async ({ data }) => {
      const row = { id: nextId++, ...data };
      created.push(row);
      return row;
    });

    const counts = await MODULES.taxonomy.apply(1, [
      { name: 'Project Setup', parentName: null, ...base },
      { name: 'Accounting', parentName: null, ...base },
      { name: 'Quebec', parentName: 'Project Setup', ...base },
      { name: 'Quebec', parentName: 'Accounting', ...base },
    ], 'merge');

    expect(counts).toMatchObject({ created: 4, conflicts: 0 });
    const projectSetup = created.find((row) => row.name === 'Project Setup');
    const accounting = created.find((row) => row.name === 'Accounting');
    const quebecs = created.filter((row) => row.name === 'Quebec');
    expect(quebecs.map((row) => row.parentId).sort()).toEqual([projectSetup.id, accounting.id].sort());
  });

  test('replace mode deletes rows absent from the snapshot by compound key', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue(TARGET_RECORDS);
    prismaMock.competencyCategory.delete.mockResolvedValue({});

    const counts = await MODULES.taxonomy.apply(1, [
      { name: 'Project Setup', parentName: null, ...base },
      { name: 'Accounting', parentName: null, ...base },
      { name: 'Quebec', parentName: 'Project Setup', ...base },
      // Accounting > Quebec missing → doomed under replace
    ], 'replace');

    expect(prismaMock.competencyCategory.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.competencyCategory.delete).toHaveBeenCalledWith({ where: { id: 4 } });
    expect(counts.deleted).toBe(1);
    expect(counts.skipped).toBe(3);
  });

  test('legacy row without parentName matches by bare name when unambiguous', async () => {
    const target = [
      TARGET_RECORDS[0],
      { id: 3, name: 'Quebec', parentId: 1, parent: { name: 'Project Setup' }, ...base },
    ];
    prismaMock.competencyCategory.findMany.mockResolvedValue(target);
    prismaMock.competencyCategory.update.mockResolvedValue({});

    const counts = await MODULES.taxonomy.apply(1, [
      { name: 'Quebec', description: 'updated from legacy snapshot', isActive: true, isSystemSuggested: false, source: 'manual', sortOrder: 0 },
    ], 'merge');

    expect(counts).toMatchObject({ updated: 1, conflicts: 0, created: 0 });
    expect(prismaMock.competencyCategory.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: expect.objectContaining({ description: 'updated from legacy snapshot', parentId: 1 }),
    });
  });

  test('legacy row with an ambiguous bare name is a conflict, never a guess', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue(TARGET_RECORDS);

    const counts = await MODULES.taxonomy.apply(1, [
      { name: 'Quebec', description: 'legacy', isActive: true, isSystemSuggested: false, source: 'manual', sortOrder: 0 },
    ], 'merge');

    expect(counts).toMatchObject({ conflicts: 1, created: 0, updated: 0 });
    expect(prismaMock.competencyCategory.create).not.toHaveBeenCalled();
    expect(prismaMock.competencyCategory.update).not.toHaveBeenCalled();
  });
});
