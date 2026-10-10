/* eslint-env node */
/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import UrgentResponseOps from './UrgentResponseOps';

// Analytics → Automation Ops → "Urgent response": counts by layer, live in
// normal text and Shadow in muted text. Never a person.

afterEach(cleanup);

const COUNTS = { redirected: 12, held: 3, moved: 4, toldOwnerAway: 2, teamTold: 5, coordinator: 1, onCallAssigned: 6, undone: 1 };
const ZERO = Object.fromEntries(Object.keys(COUNTS).map((k) => [k, 0]));
const row = (id) => screen.getByTestId(`urgent-ops-${id}`);

describe('UrgentResponseOps', () => {
  test('absent: renders nothing without the block', () => {
    const { container } = render(<UrgentResponseOps data={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('live counts grouped by layer, no Shadow column when there is none', () => {
    render(<UrgentResponseOps data={{ mode: 'live', live: COUNTS, shadow: ZERO }} />);
    expect(screen.getByText('Live')).toBeInTheDocument();
    const assign = screen.getByRole('region', { name: 'When assigning' });
    expect(within(assign).getByTestId('urgent-ops-redirected')).toHaveTextContent('Given to someone at work instead12');
    expect(within(assign).getByTestId('urgent-ops-held')).toHaveTextContent('3');
    const raise = screen.getByRole('region', { name: 'When it becomes urgent' });
    expect(within(raise).getByTestId('urgent-ops-moved')).toHaveTextContent('4');
    expect(within(raise).getByTestId('urgent-ops-toldOwnerAway')).toHaveTextContent('Owner away, team told2');
    expect(within(raise).getByTestId('urgent-ops-onCallAssigned')).toHaveTextContent('6');
    const clock = screen.getByRole('region', { name: 'Untouched clock' });
    expect(within(clock).getByTestId('urgent-ops-teamTold')).toHaveTextContent('5');
    expect(within(clock).getByTestId('urgent-ops-coordinator')).toHaveTextContent('1');
    expect(within(screen.getByRole('region', { name: 'Undone' })).getByTestId('urgent-ops-undone')).toHaveTextContent('1');
    expect(screen.queryByText(/^Shadow \d/)).not.toBeInTheDocument();
  });

  test('Shadow mode: live numbers stay, Shadow numbers sit beside them in muted text', () => {
    render(<UrgentResponseOps data={{ mode: 'observe', live: ZERO, shadow: COUNTS }} />);
    expect(screen.getByText('Shadow')).toBeInTheDocument();
    expect(screen.getByText(/Nothing moved and nobody was told/)).toBeInTheDocument();
    const shadow = within(row('redirected')).getByText('Shadow 12');
    expect(shadow.className).toMatch(/text-muted-foreground/);
    expect(within(row('redirected')).getByText('0').className).toMatch(/text-foreground/);
    expect(within(row('teamTold')).getByText('Shadow 5')).toBeInTheDocument();
  });

  test('when the server splits moves by layer, each layer shows its own', () => {
    render(<UrgentResponseOps data={{ mode: 'live', live: { ...COUNTS, moved: 9, raiseMoved: 6, clockMoved: 3 }, shadow: ZERO }} />);
    expect(row('raiseMoved')).toHaveTextContent('Moved to someone at work6');
    expect(row('clockMoved')).toHaveTextContent('Moved3');
    expect(screen.queryByTestId('urgent-ops-moved')).not.toBeInTheDocument();
  });

  test('missing numbers read as 0, and no person is ever named', () => {
    render(<UrgentResponseOps data={{ mode: 'off', live: {}, shadow: undefined }} />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(row('redirected')).toHaveTextContent('0');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  test('Analytics shows the panel only when the server sends the block', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/Analytics.jsx'), 'utf8');
    expect(source).toMatch(/\{ops\?\.urgentResponse && \(\s*<Panel title="Urgent response"[^>]*>\s*<UrgentResponseOps data=\{ops\.urgentResponse\} \/>/);
  });
});
