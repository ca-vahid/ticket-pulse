/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import NonActionableBadge from './NonActionableBadge';

afterEach(cleanup);

describe('NonActionableBadge (QA 09-05 option 3)', () => {
  test('shows the label and the reason when the AI flagged the ticket', () => {
    render(<NonActionableBadge recommendation={{
      nonActionable: true,
      nonActionableReason: 'Automated statement with nothing to action.',
      recommendations: [{ techId: 7 }],
    }} />);
    expect(screen.getByTestId('non-actionable-badge')).toBeInTheDocument();
    expect(screen.getByText(/needs no follow-up/i)).toBeInTheDocument();
    expect(screen.getByText(/Automated statement with nothing to action/)).toBeInTheDocument();
  });

  test('says plainly that the ticket was still routed and nothing was closed', () => {
    // The whole point of option 3: a wrong label costs a label, not a ticket.
    render(<NonActionableBadge recommendation={{ nonActionable: true, recommendations: [{ techId: 7 }] }} />);
    expect(screen.getByText(/still routed the ticket/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was closed or dismissed/i)).toBeInTheDocument();
  });

  test('renders nothing for an ordinary recommendation', () => {
    const { container } = render(<NonActionableBadge recommendation={{ recommendations: [{ techId: 7 }] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('renders nothing when there is no recommendation at all', () => {
    const { container } = render(<NonActionableBadge recommendation={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('a missing reason does not produce an empty line', () => {
    render(<NonActionableBadge recommendation={{ nonActionable: true, nonActionableReason: '   ' }} />);
    expect(screen.getByTestId('non-actionable-badge')).toBeInTheDocument();
    expect(screen.getByText(/needs no follow-up/i)).toBeInTheDocument();
  });
});
