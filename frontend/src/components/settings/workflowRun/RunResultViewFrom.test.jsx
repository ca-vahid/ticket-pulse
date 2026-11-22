/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import RunResultView from './RunResultView';

afterEach(cleanup);

// 22 Nov 2026: Preview and Shadow name the address the e-mail would leave from
// (the ticket's team mailbox in a workspace with one per team).
const model = (over = {}) => ({
  summary: { status: 'completed', ref: 'TP-12', subject: 'Invoice question', auditId: 'TP-NWF-1', facts: [] },
  steps: [],
  email: { subject: 'Resolved: Invoice question', html: '<p>Done</p>', text: 'Done' },
  recipients: { to: ['dana.fox@example.com'], cc: [], bcc: [] },
  llm: [],
  issues: [],
  ...over,
});

describe('the From line on a run e-mail', () => {
  test('shows the address when the run reported one', () => {
    render(<RunResultView model={model({ from: 'ar@example.com' })} />);
    expect(screen.getByTestId('run-email-from')).toHaveTextContent('ar@example.com');
    expect(screen.getByText('From')).toBeInTheDocument();
  });

  test('reads it from the preview e-mail too', () => {
    render(<RunResultView model={model({ email: { subject: 'S', html: '<p>B</p>', fromAddress: 'ap@example.com' } })} />);
    expect(screen.getByTestId('run-email-from')).toHaveTextContent('ap@example.com');
  });

  test('no address: no From line, the rest unchanged', () => {
    render(<RunResultView model={model()} />);
    expect(screen.queryByTestId('run-email-from')).not.toBeInTheDocument();
    expect(screen.getByText('dana.fox@example.com')).toBeInTheDocument();
  });
});
