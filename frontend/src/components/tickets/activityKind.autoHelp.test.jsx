/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ActorKindChip } from './activityKind.jsx';

afterEach(cleanup);

describe('Auto-help history label', () => {
  test('is plain text with an icon, not a pill', () => {
    render(<ActorKindChip kind="auto_help" />);
    const label = screen.getByTestId('actor-kind-chip');
    expect(label).toHaveTextContent('Auto-help');
    expect(label.querySelector('svg')).not.toBeNull();
    expect(label.className).not.toMatch(/rounded-full|border|bg-/);
  });

  test('other kinds are plain coloured words too — no pills (QA 11-05 #9)', () => {
    render(<ActorKindChip kind="workflow" />);
    const label = screen.getByTestId('actor-kind-chip');
    expect(label).toHaveTextContent('Workflow');
    expect(label.className).not.toMatch(/rounded-full|border|bg-/);
    expect(label.className).toMatch(/text-amber-700/);
  });
});
