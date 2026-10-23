/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Send } from 'lucide-react';

// QA 10-22 #8: "Phone Ticket Closed" runs in addition to "Ticket resolved or
// closed", so it is not one of its variants; and variant rows are not greyed.
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

import WorkflowListPage, { workflowKind } from './WorkflowListPage';
import { groupWorkflowsByStage, runsInAddition } from '../../utils/workflowStages';

afterEach(cleanup);

const CLOSURE = [
  { id: 10, name: 'Ticket resolved or closed', triggerType: 'ticket.resolved_closed', isDefaultVariant: true, routingMode: 'exclusive', isEnabled: true, mockModeEnabled: true, publishedVersion: 24, runs: [] },
  { id: 11, name: 'Phone Ticket Closed', triggerType: 'ticket.resolved_closed', routingMode: 'additive', routingRule: null, isEnabled: true, publishedVersion: 9, runs: [] },
  { id: 12, name: 'Ticket resolved or closed variant', triggerType: 'ticket.resolved_closed', routingMode: 'exclusive', routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] }, isEnabled: true, mockModeEnabled: true, publishedVersion: 21, runs: [] },
];
const LABELS = { 'ticket.resolved_closed': 'Resolved or closed' };

describe('QA 10-22 #8: workflows that run in addition stand alone', () => {
  test('runsInAddition: only a non-default, non-manual additive workflow', () => {
    expect(runsInAddition(CLOSURE[1])).toBe(true);
    expect(runsInAddition(CLOSURE[2])).toBe(false);
    expect(runsInAddition({ ...CLOSURE[1], isDefaultVariant: true })).toBe(false);
    expect(runsInAddition({ ...CLOSURE[1], triggerType: 'manual' })).toBe(false);
    expect(runsInAddition(null)).toBe(false);
  });

  test('grouping: the replacing variant is nested, the additive one follows at the top level', () => {
    const [{ triggers }] = groupWorkflowsByStage(CLOSURE, LABELS);
    expect(triggers[0].workflows.map((w) => w.id)).toEqual([10, 12, 11]);
    expect([...triggers[0].nested]).toEqual([12]);
    expect([...triggers[0].lastNested]).toEqual([12]);
    expect(triggers[0].families[0].alongside.map((w) => w.id)).toEqual([11]);
  });

  test('kind column: "Runs in addition" (or routed, in addition)', () => {
    expect(workflowKind(CLOSURE[1])).toBe('Runs in addition');
    expect(workflowKind({ ...CLOSURE[1], routingRule: { field: 'x' } })).toBe('Routed · in addition');
    expect(workflowKind(CLOSURE[2])).toBe('Routed');
  });

  test('on the page: Phone Ticket Closed is not indented, and no row is tinted grey', () => {
    render(<WorkflowListPage workflows={CLOSURE} onOpen={vi.fn()} eventLabels={LABELS} getVisuals={() => ({ icon: Send })} />);
    const rows = screen.getAllByTestId('workflow-list-row');
    const byName = (name) => rows.find((r) => within(r).getByRole('link').textContent.startsWith(name));
    expect(byName('Phone Ticket Closed')).not.toHaveAttribute('data-variant');
    expect(byName('Ticket resolved or closed variant')).toHaveAttribute('data-variant', 'true');
    for (const row of rows) expect(row.className).not.toMatch(/bg-muted/);
    expect(within(byName('Phone Ticket Closed')).getAllByText('Runs in addition').length).toBeGreaterThan(0);
  });
});
