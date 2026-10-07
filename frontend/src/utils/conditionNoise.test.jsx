/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { conditionGroupPatch, noiseState, skipNoisePatch, visibleConditionGroup } from './conditionNoise';
import SkipNoiseSwitch from '../components/settings/SkipNoiseSwitch';

// QA 10-06 #2: "Skip noise tickets" is the condition step's own switch. The
// old shapes (a noise row, or the default raw rule) read through it.

afterEach(cleanup);

const NOISE_RULE = { '!=': [{ var: 'ticket.isNoise' }, true] };
const NOISE_ROW = { field: 'ticket.isNoise', operator: 'is_false', value: null };
const URGENT = { field: 'ticket.priorityLabel', operator: 'is', value: 'Urgent' };

describe('noise state', () => {
  test('the switch, an old noise row, or the default raw rule all read as on', () => {
    expect(noiseState({ skipNoise: true }).on).toBe(true);
    expect(noiseState({ conditionGroup: { logic: 'all', conditions: [NOISE_ROW, URGENT] } }).on).toBe(true);
    expect(noiseState({ rule: NOISE_RULE }).on).toBe(true);
    expect(noiseState({ rule: NOISE_RULE, conditionGroup: { logic: 'all', conditions: [URGENT] } }).on).toBe(false);
    expect(noiseState({ conditionGroup: { logic: 'any', conditions: [NOISE_ROW, URGENT] } }).on).toBe(false);
  });

  test('an old noise row is shown on the switch, not in the conditions', () => {
    const data = { conditionGroup: { logic: 'all', conditions: [NOISE_ROW, URGENT] } };
    expect(visibleConditionGroup(data).conditions).toEqual([URGENT]);
  });

  test('editing conditions keeps the noise check, on the switch', () => {
    expect(conditionGroupPatch({ rule: NOISE_RULE }, { logic: 'all', conditions: [URGENT] }))
      .toEqual({ conditionGroup: { logic: 'all', conditions: [URGENT] }, skipNoise: true });
    expect(conditionGroupPatch({ conditionGroup: { logic: 'all', conditions: [NOISE_ROW] } }, { logic: 'any', conditions: [URGENT] }))
      .toEqual({ conditionGroup: { logic: 'any', conditions: [URGENT] }, skipNoise: true });
    expect(conditionGroupPatch({ rule: true }, { logic: 'all', conditions: [URGENT] })).toEqual({ conditionGroup: { logic: 'all', conditions: [URGENT] } });
  });

  test('turning the switch off removes the old shapes too', () => {
    expect(skipNoisePatch({ conditionGroup: { logic: 'all', conditions: [NOISE_ROW, URGENT] } }, false))
      .toEqual({ skipNoise: false, conditionGroup: { logic: 'all', conditions: [URGENT] } });
    expect(skipNoisePatch({ rule: NOISE_RULE }, false)).toEqual({ skipNoise: false, conditionGroup: { logic: 'all', conditions: [] } });
    expect(skipNoisePatch({ skipNoise: true }, false)).toEqual({ skipNoise: false });
    expect(skipNoisePatch({}, true)).toEqual({ skipNoise: true });
  });
});

describe('SkipNoiseSwitch', () => {
  test('says what happens either way and reports the change', () => {
    const onPatch = vi.fn();
    const { rerender } = render(<SkipNoiseSwitch data={{ rule: NOISE_RULE }} onPatch={onPatch} />);
    const sw = screen.getByRole('switch', { name: 'Skip noise tickets' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('skip-noise-switch')).toHaveTextContent('stop here');
    fireEvent.click(sw);
    expect(onPatch).toHaveBeenCalledWith({ skipNoise: false, conditionGroup: { logic: 'all', conditions: [] } });
    rerender(<SkipNoiseSwitch data={{ skipNoise: false }} onPatch={onPatch} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('skip-noise-switch')).toHaveTextContent('not stopped here');
  });
});
