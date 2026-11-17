// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import RunEscalationLine from '../RunEscalationLine';

const run = (escalation) => ({
  reboundFrom: { reason: { code: 'escalate', escalation: { fromTechName: 'Alex Doe', scope: 'Security / Alert Triage' } } },
  recommendation: { escalation },
});

afterEach(cleanup);

describe('RunEscalationLine', () => {
  test('best available: says who got it', () => {
    render(<RunEscalationLine run={run({ outcome: 'best_available', chosenTechName: 'Dana Fox' })} />);
    expect(screen.getByTestId('run-escalation-line').textContent).toContain('Nobody more advanced is at work - gave it to Dana Fox.');
  });

  test('nobody at work: your call', () => {
    render(<RunEscalationLine run={run({ outcome: 'none_higher' })} />);
    expect(screen.getByTestId('run-escalation-line').textContent).toContain('your call');
  });

  test('not an escalation: renders nothing', () => {
    const { container } = render(<RunEscalationLine run={{ reboundFrom: { reason: { code: 'other' } } }} />);
    expect(container.firstChild).toBeNull();
  });
});
