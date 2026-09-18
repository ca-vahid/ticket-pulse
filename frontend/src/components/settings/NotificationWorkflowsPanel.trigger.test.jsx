/* eslint-env node */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FR 09-11 #4 — the reopen trigger has to be visible in the builder, not just
 * emitted by the backend. The first production screenshot showed the group
 * header as the raw key "TICKET.REOPENED", because this panel keeps its own
 * label map and the new event was only added to the backend's.
 */
const src = readFileSync(
  resolve(process.cwd(), 'src/components/settings/NotificationWorkflowsPanel.jsx'),
  'utf8',
);

describe('ticket.reopened is a first-class trigger in the builder', () => {
  test('has a human label, so no group header shows the raw event key', () => {
    expect(src).toMatch(/'ticket\.reopened':\s*'Ticket reopened'/);
  });

  test('is selectable when building a new workflow', () => {
    expect(src).toMatch(/\{ value: 'ticket\.reopened', hint: '[^']+' \}/);
  });

  test('has its own icon and colour rail like every other trigger', () => {
    expect(src).toMatch(/'ticket\.reopened':\s*\{ icon: RotateCcw/);
  });

  test('and that icon is actually imported', () => {
    expect(src).toMatch(/^\s*RotateCcw,$/m);
  });

  test('every trigger offered in the picker also has a label', () => {
    // The class of bug this file exists for: a trigger added to one map and
    // not the other renders as a raw event key. Only picker entries carry a
    // `hint` — condition fields use `label` and are correctly absent here.
    const offered = [...src.matchAll(/\{ value: '([a-z]+\.[a-z_]+)', hint:/g)].map((m) => m[1]);
    expect(offered.length).toBeGreaterThan(5);
    const missing = offered.filter(
      (value) => !new RegExp(`'${value.replace(/\./g, '\\.')}': '`).test(src),
    );
    expect(missing).toEqual([]);
  });
});
