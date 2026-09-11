/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { safeWorkspacePath } from './WorkspaceContext';

/**
 * QA 09-10 #2 — "Whenever the user switches to another workspace, don't try to
 * find that exact ticket number. Instead, just land on the tickets page."
 *
 * Every switch used to end in window.location.reload(), which reloads the
 * CURRENT url. On /tickets/1263 that is a deep link into the workspace you just
 * left, so the new workspace showed "ticket not found" instead of a queue.
 */

describe('record routes drop to their list', () => {
  test('a ticket lands on the tickets page — the reported case', () => {
    expect(safeWorkspacePath('/tickets/1263')).toBe('/tickets');
  });

  test('any ticket id shape, including TP refs and nested segments', () => {
    expect(safeWorkspacePath('/tickets/TP-1263')).toBe('/tickets');
    expect(safeWorkspacePath('/tickets/1263/')).toBe('/tickets');
    expect(safeWorkspacePath('/tickets/1263/anything')).toBe('/tickets');
  });

  test('a technician page lands on the dashboard', () => {
    expect(safeWorkspacePath('/technician/42')).toBe('/dashboard');
  });

  test('an assignment run lands on the assignments queue', () => {
    expect(safeWorkspacePath('/assignments/run/24101')).toBe('/assignments');
  });
});

describe('workspace-neutral routes stay put', () => {
  test.each([
    '/tickets',
    '/dashboard',
    '/analytics',
    '/analytics/category-map',
    '/settings',
    '/assignments',
    '/timeline',
    '/my-competencies',
    '/',
  ])('%s is unchanged', (path) => {
    expect(safeWorkspacePath(path)).toBe(path);
  });

  test('a settings hash route is not treated as a record id', () => {
    // The hash never reaches pathname, but guard the shape anyway.
    expect(safeWorkspacePath('/settings')).toBe('/settings');
  });
});

describe('it never throws', () => {
  test.each([undefined, null, '', 0])('%p falls back to the root', (input) => {
    expect(safeWorkspacePath(input)).toBe('/');
  });
});
