import { jest } from '@jest/globals';

/** Auto-help P0 scaffolding: 'auto_help' is a system park kind, refused on agent/API paths. */
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { validatePark, PARK_KINDS, PARK_KIND_LABELS, SYSTEM_PARK_KINDS, AUTO_HELP_PARK_KIND } = await import('../src/services/ticketParkService.js');

const until = new Date(Date.now() + 3 * 86400e3).toISOString();

test('auto_help is labelled but not an agent-selectable kind', () => {
  expect(AUTO_HELP_PARK_KIND).toBe('auto_help');
  expect(PARK_KIND_LABELS.auto_help).toBe('Auto-help waiting');
  expect(PARK_KINDS).not.toContain('auto_help');
  expect(SYSTEM_PARK_KINDS).toContain('auto_help');
});

test('validatePark refuses auto_help unless system kinds are allowed', () => {
  expect(() => validatePark({ kind: 'auto_help', until, reason: 'Waiting on requester' })).toThrow(/kind must be one of/);
  expect(validatePark({ kind: 'auto_help', until, reason: 'Waiting on requester' }, { allowSystemKinds: true }).kind).toBe('auto_help');
});
