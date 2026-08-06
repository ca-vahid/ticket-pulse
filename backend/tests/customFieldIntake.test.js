import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// FR 08-05 #1 (Phase 1a) — customFieldService.setValuesAtCreate: create-time
// intake that validates known keys, auto-provisions unknown ones
// (source:'api', inferred type), normalizes key spellings, enforces the
// intake caps, and NEVER throws for a bad entry — everything unusable comes
// back in the `rejected` list.

const prismaMock = {
  customFieldDefinition: {
    findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(),
  },
  ticket: { findFirst: jest.fn(), update: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  default: customFieldService, normalizeFieldKey, prettifyKeyLabel, inferFieldType,
} = await import('../src/services/customFieldService.js');

let nextId = 1000;
function armProvisioning(existing = []) {
  prismaMock.customFieldDefinition.findMany.mockResolvedValue(existing);
  prismaMock.customFieldDefinition.create.mockImplementation(({ data }) => Promise.resolve({ id: nextId++, isActive: true, ...data }));
}

describe('normalizeFieldKey', () => {
  test('camelCase, spaces, hyphens, dots → snake_case', () => {
    expect(normalizeFieldKey('clientName')).toBe('client_name');
    expect(normalizeFieldKey('Client Name')).toBe('client_name');
    expect(normalizeFieldKey('client-name')).toBe('client_name');
    expect(normalizeFieldKey('client.name')).toBe('client_name');
    expect(normalizeFieldKey('sharePointItemLink')).toBe('share_point_item_link');
    expect(normalizeFieldKey('PONumber')).toBe('po_number');
    expect(normalizeFieldKey('  spaced  out  ')).toBe('spaced_out');
    expect(normalizeFieldKey('already_snake')).toBe('already_snake');
  });
});

describe('inferFieldType / prettifyKeyLabel', () => {
  test('type inference: boolean, finite number, ISO date, else text', () => {
    expect(inferFieldType(true)).toBe('boolean');
    expect(inferFieldType(42.5)).toBe('number');
    expect(inferFieldType(Infinity)).toBe('text');
    expect(inferFieldType('2026-08-05')).toBe('date');
    expect(inferFieldType('2026-08-05T14:30:00Z')).toBe('date');
    expect(inferFieldType('1260')).toBe('text'); // numeric STRING stays text
    expect(inferFieldType('March 5')).toBe('text');
    expect(inferFieldType('https://example.com')).toBe('text');
  });

  test('labels prettify from the key', () => {
    expect(prettifyKeyLabel('client_name')).toBe('Client Name');
    expect(prettifyKeyLabel('po_number')).toBe('Po Number');
  });
});

describe('setValuesAtCreate — auto-provisioning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    armProvisioning([]);
  });

  test('unknown keys provision definitions with inferred type, source api, prettified label', async () => {
    const result = await customFieldService.setValuesAtCreate(1, {
      clientName: 'ACME Inc',
      seatCount: 4,
      isRush: true,
      neededBy: '2026-09-01',
    }, { autoProvision: true });

    expect(result.rejected).toEqual([]);
    expect(result.provisioned).toEqual(['client_name', 'seat_count', 'is_rush', 'needed_by']);
    expect(result.values).toEqual({
      client_name: 'ACME Inc',
      seat_count: 4,
      is_rush: true,
      needed_by: new Date('2026-09-01').toISOString(),
    });
    expect(prismaMock.customFieldDefinition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: 1, key: 'client_name', label: 'Client Name', type: 'text', source: 'api',
      }),
    }));
    expect(prismaMock.customFieldDefinition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ key: 'seat_count', type: 'number' }),
    }));
    expect(prismaMock.customFieldDefinition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ key: 'is_rush', type: 'boolean' }),
    }));
    expect(prismaMock.customFieldDefinition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ key: 'needed_by', type: 'date' }),
    }));
  });

  test('sortOrder continues after the workspace max', async () => {
    armProvisioning([
      { id: 1, workspaceId: 1, key: 'existing', label: 'Existing', type: 'text', options: [], sortOrder: 7, isActive: true },
    ]);
    await customFieldService.setValuesAtCreate(1, { newField: 'x' }, { autoProvision: true });
    expect(prismaMock.customFieldDefinition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ key: 'new_field', sortOrder: 8 }),
    }));
  });

  test('case/spelling variants dedupe against EXISTING definitions (no re-provision)', async () => {
    armProvisioning([
      { id: 1, workspaceId: 1, key: 'client_name', label: 'Client Name', type: 'text', options: [], sortOrder: 0, isActive: true },
    ]);
    const result = await customFieldService.setValuesAtCreate(1, { clientName: 'ACME' }, { autoProvision: true });
    expect(result.provisioned).toEqual([]);
    expect(result.values).toEqual({ client_name: 'ACME' });
    expect(prismaMock.customFieldDefinition.create).not.toHaveBeenCalled();
  });

  test('two spellings of the same key collapse — last occurrence wins, one definition', async () => {
    const result = await customFieldService.setValuesAtCreate(1, {
      clientName: 'First', client_name: 'Second',
    }, { autoProvision: true });
    expect(result.values).toEqual({ client_name: 'Second' });
    expect(prismaMock.customFieldDefinition.create).toHaveBeenCalledTimes(1);
  });

  test('known keys use the existing definition validation (bad select value → rejected, not thrown)', async () => {
    armProvisioning([
      { id: 1, workspaceId: 1, key: 'region', label: 'Region', type: 'select', options: ['Quebec', 'Chile'], sortOrder: 0, isActive: true },
    ]);
    const result = await customFieldService.setValuesAtCreate(1, { region: 'Mars' }, { autoProvision: true });
    expect(result.values).toEqual({});
    expect(result.rejected).toEqual([{ key: 'region', reason: expect.stringMatching(/must be one of/i) }]);
  });

  test('invalid-after-normalization keys land in rejected (returned, not thrown)', async () => {
    const result = await customFieldService.setValuesAtCreate(1, {
      '9starts_with_digit': 'x', 'é': 'y', '': 'z', ok_key: 'kept',
    }, { autoProvision: true });
    expect(result.values).toEqual({ ok_key: 'kept' });
    expect(result.rejected).toEqual(expect.arrayContaining([
      { key: '9starts_with_digit', reason: 'invalid_key' },
      { key: 'é', reason: 'invalid_key' },
      { key: '', reason: 'invalid_key' },
    ]));
  });

  test('null values clear/skip storage but never reject', async () => {
    const result = await customFieldService.setValuesAtCreate(1, { empty_one: null, kept: 'v' }, { autoProvision: true });
    expect(result.values).toEqual({ kept: 'v' });
    expect(result.rejected).toEqual([]);
  });

  test('autoProvision:false rejects unknown keys instead of provisioning', async () => {
    const result = await customFieldService.setValuesAtCreate(1, { mystery: 'x' }, { autoProvision: false });
    expect(result.values).toEqual({});
    expect(result.rejected).toEqual([{ key: 'mystery', reason: 'unknown_field' }]);
    expect(prismaMock.customFieldDefinition.create).not.toHaveBeenCalled();
  });
});

describe('setValuesAtCreate — caps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    armProvisioning([]);
  });

  test('more than 40 keys → the overflow is rejected (too_many_keys)', async () => {
    const values = Object.fromEntries(Array.from({ length: 43 }, (_, i) => [`field_${i + 1}`, 'v']));
    const result = await customFieldService.setValuesAtCreate(1, values, { autoProvision: true });
    expect(Object.keys(result.values)).toHaveLength(40);
    expect(result.rejected.filter((r) => r.reason === 'too_many_keys')).toHaveLength(3);
  });

  test('values over 2000 chars stringified are rejected', async () => {
    const result = await customFieldService.setValuesAtCreate(1, {
      huge: 'x'.repeat(2001), fine: 'x'.repeat(2000),
    }, { autoProvision: true });
    expect(result.values).toEqual({ fine: 'x'.repeat(2000) });
    expect(result.rejected).toEqual([{ key: 'huge', reason: 'value_too_long' }]);
  });

  test('the 200-definitions-per-workspace cap blocks further provisioning', async () => {
    armProvisioning(Array.from({ length: 200 }, (_, i) => ({
      id: i + 1, workspaceId: 1, key: `def_${i + 1}`, label: `Def ${i + 1}`, type: 'text', options: [], sortOrder: i, isActive: true,
    })));
    const result = await customFieldService.setValuesAtCreate(1, { def_1: 'known ok', brand_new: 'x' }, { autoProvision: true });
    expect(result.values).toEqual({ def_1: 'known ok' });
    expect(result.rejected).toEqual([{ key: 'brand_new', reason: 'definition_cap_reached' }]);
    expect(prismaMock.customFieldDefinition.create).not.toHaveBeenCalled();
  });

  test('non-object input still throws (caller bug, not sender data)', async () => {
    await expect(customFieldService.setValuesAtCreate(1, ['nope'])).rejects.toThrow(/must be an object/i);
  });
});

describe('setValuesAtCreate — workspace isolation', () => {
  test('definitions are looked up per workspace; ws1 defs are invisible to ws2', async () => {
    jest.clearAllMocks();
    // ws2 has no definitions even though ws1 owns client_name — ws2 provisions its own.
    prismaMock.customFieldDefinition.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.workspaceId === 1
        ? [{ id: 1, workspaceId: 1, key: 'client_name', label: 'Client Name', type: 'text', options: [], sortOrder: 0, isActive: true }]
        : [],
    ));
    prismaMock.customFieldDefinition.create.mockImplementation(({ data }) => Promise.resolve({ id: 77, isActive: true, ...data }));

    const result = await customFieldService.setValuesAtCreate(2, { clientName: 'ACME' }, { autoProvision: true });
    expect(prismaMock.customFieldDefinition.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 2 }),
    }));
    expect(result.provisioned).toEqual(['client_name']);
    expect(prismaMock.customFieldDefinition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: 2, key: 'client_name' }),
    }));
  });
});

describe('migration ↔ model sync (custom_field_definitions.source)', () => {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  test('the Phase 1a migration adds the source column idempotently', () => {
    const sql = fs.readFileSync(
      path.join(backendRoot, 'prisma/migrations/20260805120000_custom_field_source/migration.sql'), 'utf8',
    );
    expect(sql).toMatch(/ALTER TABLE "custom_field_definitions"/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "source" VARCHAR\(10\) NOT NULL DEFAULT 'manual'/);
  });

  test('the Prisma model carries the matching source field', () => {
    const schema = fs.readFileSync(path.join(backendRoot, 'prisma/schema.prisma'), 'utf8');
    const model = schema.split('model CustomFieldDefinition {')[1].split('\n}')[0];
    expect(model).toMatch(/source\s+String\s+@default\("manual"\)\s+@db\.VarChar\(10\)/);
  });
});

// Phase 1c — updateDefinition gained `type` so admins can curate
// API-provisioned definitions (the intake inference only sees the FIRST
// value; a numeric-looking id lands as number but should be text).
describe('updateDefinition — type curation (Phase 1c)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.customFieldDefinition.update = jest.fn(({ data }) => Promise.resolve({ id: 9, ...data }));
  });

  const arm = (definition) => prismaMock.customFieldDefinition.findFirst.mockResolvedValue(definition);

  test('changes the type (number → text) and clears stale options', async () => {
    arm({ id: 9, workspaceId: 2, key: 'power_app_record_id', label: 'Power App Record Id', type: 'number', options: [], isActive: true });
    await customFieldService.updateDefinition(2, 9, { type: 'text' });
    expect(prismaMock.customFieldDefinition.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { type: 'text', options: [] },
    });
  });

  test('switching to select demands options (existing or supplied)', async () => {
    arm({ id: 9, workspaceId: 2, key: 'region', label: 'Region', type: 'text', options: [], isActive: true });
    await expect(customFieldService.updateDefinition(2, 9, { type: 'select' })).rejects.toThrow(/at least one option/);
    await customFieldService.updateDefinition(2, 9, { type: 'select', options: ['Quebec', 'Ontario'] });
    expect(prismaMock.customFieldDefinition.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { type: 'select', options: ['Quebec', 'Ontario'] },
    });
  });

  test('rejects an unknown type', async () => {
    arm({ id: 9, workspaceId: 2, key: 'x', label: 'X', type: 'text', options: [], isActive: true });
    await expect(customFieldService.updateDefinition(2, 9, { type: 'json' })).rejects.toThrow(/Field type must be one of/);
  });

  test('label/isActive edits still pass through untouched (no type in data)', async () => {
    arm({ id: 9, workspaceId: 2, key: 'x', label: 'X', type: 'select', options: ['a'], isActive: true });
    await customFieldService.updateDefinition(2, 9, { label: ' Client ', isActive: false });
    expect(prismaMock.customFieldDefinition.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { label: 'Client', isActive: false },
    });
  });
});
