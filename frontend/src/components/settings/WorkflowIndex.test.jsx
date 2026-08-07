/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1 } }),
}));

const { default: WorkflowIndex } = await import('./WorkflowIndex.jsx');

const GroupIcon = (props) => <svg data-testid="group-icon" {...props} />;

const WORKFLOWS = [
  {
    id: 1,
    name: 'Assignment notice',
    triggerType: 'ticket.assigned',
    isDefaultVariant: true,
    isEnabled: true,
    publishedVersion: 3,
    _count: { runs: 12 },
    runs: [{ status: 'completed', startedAt: new Date().toISOString() }],
  },
  {
    id: 2,
    name: 'VIP variant with a much longer descriptive workflow name for wrapping',
    triggerType: 'ticket.assigned',
    isDefaultVariant: false,
    isEnabled: false,
    publishedVersion: 0,
    _count: { runs: 0 },
    runs: [],
  },
];

function renderIndex(overrides = {}) {
  const props = {
    workflows: WORKFLOWS,
    selectedId: 1,
    onSelect: vi.fn(),
    onToggleEnabled: vi.fn(),
    togglingId: null,
    onCreateForTrigger: vi.fn(),
    getDisplayName: (workflow) => workflow.name,
    getVisuals: () => ({ icon: GroupIcon }),
    eventLabels: { 'ticket.assigned': 'Ticket assigned' },
    isAfterHours: () => false,
    ...overrides,
  };
  render(<WorkflowIndex {...props} />);
  return props;
}

function cardFor(name) {
  return screen.getByTitle(name).closest('.group');
}

describe('WorkflowIndex sidebar cards (QA 08-02 legibility polish)', () => {
  afterEach(() => cleanup());

  test('each workflow renders as a clearly bounded card', () => {
    renderIndex();
    const card = cardFor('VIP variant with a much longer descriptive workflow name for wrapping');
    expect(card).toHaveClass('rounded-lg');
    expect(card).toHaveClass('border');
    expect(card).toHaveClass('border-slate-200');
    // Unselected cards get the hover affordances.
    expect(card.className).toContain('hover:border-slate-300');
    expect(card.className).toContain('hover:shadow-subtle');
  });

  test('the selected card carries the blue border treatment on the card itself', () => {
    renderIndex();
    const selectedCard = cardFor('Assignment notice');
    expect(selectedCard).toHaveClass('border-2');
    expect(selectedCard).toHaveClass('border-blue-500');
    expect(selectedCard.querySelector('[aria-current="true"]')).not.toBeNull();
    // Unselected sibling keeps the neutral bounded look.
    const otherCard = cardFor('VIP variant with a much longer descriptive workflow name for wrapping');
    expect(otherCard).not.toHaveClass('border-blue-500');
  });

  test('workflow names read at text-sm font-semibold and clamp to two lines', () => {
    renderIndex();
    const name = screen.getByTitle('Assignment notice');
    expect(name).toHaveClass('text-sm');
    expect(name).toHaveClass('font-semibold');
    expect(name).toHaveClass('text-slate-800');
    expect(name).toHaveClass('line-clamp-2');
  });

  test('cards in a trigger group are separated by gap-1.5', () => {
    renderIndex();
    const card = cardFor('Assignment notice');
    expect(card.parentElement).toHaveClass('gap-1.5');
  });

  test('trigger group header keeps the tinted band with a bolder label and count pill', () => {
    renderIndex();
    const label = screen.getByText('Ticket assigned');
    expect(label).toHaveClass('text-xs');
    expect(label).toHaveClass('font-bold');
    expect(label).toHaveClass('tracking-wide');
    const pill = screen.getByText('2'); // both workflows share the trigger
    expect(pill).toHaveClass('rounded-full');
  });

  test('the enabled toggle sits at the right edge, vertically centered', () => {
    renderIndex();
    const toggle = screen.getByRole('switch', { name: /Assignment notice/ });
    expect(toggle).toHaveClass('self-center');
    expect(toggle).toHaveClass('shrink-0');
  });
});

describe('WorkflowIndex routing chip (QA 08-06 #6)', () => {
  afterEach(() => cleanup());

  test('workflows with a routing rule show the amber "Routed" chip with a tooltip', () => {
    renderIndex({
      workflows: [
        WORKFLOWS[0],
        { ...WORKFLOWS[1], routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] } },
      ],
    });
    const chip = screen.getByText('Routed');
    expect(chip).toHaveClass('bg-amber-50');
    expect(chip).toHaveAttribute('title', 'Only runs when its routing rule matches');
  });

  test('rule-less workflows and default variants show no chip', () => {
    renderIndex({
      workflows: [
        // Default variant WITH a rule would still not show the chip.
        { ...WORKFLOWS[0], routingRule: { '==': [{ var: 'x' }, 'y'] } },
        { ...WORKFLOWS[1], routingRule: null },
      ],
    });
    expect(screen.queryByText('Routed')).toBeNull();
  });
});

describe('WorkflowIndex observe-only chip (QA 08-06 mock-mode visibility)', () => {
  afterEach(() => cleanup());

  test('an ENABLED workflow with mock mode on shows the prominent Observe-only chip', () => {
    renderIndex({
      workflows: [{ ...WORKFLOWS[0], mockModeEnabled: true }, WORKFLOWS[1]],
    });
    const chip = screen.getByText('Observe-only');
    // Stronger treatment than the Routed chip: amber-100 fill + amber-400 ring.
    expect(chip).toHaveClass('bg-amber-100');
    expect(chip).toHaveClass('ring-amber-400');
    expect(chip.getAttribute('title')).toMatch(/NO real actions/);
  });

  test('a DISABLED workflow with mock mode on shows no chip (nothing runs anyway)', () => {
    renderIndex({
      workflows: [WORKFLOWS[0], { ...WORKFLOWS[1], isEnabled: false, mockModeEnabled: true }],
    });
    expect(screen.queryByText('Observe-only')).toBeNull();
  });
});
