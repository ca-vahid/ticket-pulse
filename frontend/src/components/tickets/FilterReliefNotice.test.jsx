/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FilterReliefNotice, { reliefActionLabel } from './FilterReliefNotice';

afterEach(cleanup);

// The real production numbers for the reported search: 0 shown, 1 exists, and
// the one that exists is Closed.
const reported = {
  current: 0,
  withoutFilters: 1,
  hasQuery: true,
  query: '241226',
  activeGroups: 1,
  groups: [{ key: 'status', label: 'Status', apiKeys: ['status'], hidden: 1 }],
  statusesToAdd: [{ status: 'Closed', count: 1 }],
};

describe('FilterReliefNotice — empty state', () => {
  test('names the culprit filter and the exact status to add', () => {
    render(<FilterReliefNotice relief={reported} onWiden={() => {}} onClearFilters={() => {}} />);
    expect(screen.getByTestId('filter-relief-empty')).toBeInTheDocument();
    expect(screen.getByText(/1 ticket is/)).toBeInTheDocument();
    expect(screen.getByText(/Status/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Include Closed \(1\)/ })).toBeInTheDocument();
  });

  test('clicking the offer hands back the group so the page can widen', () => {
    const onWiden = vi.fn();
    render(<FilterReliefNotice relief={reported} onWiden={onWiden} onClearFilters={() => {}} />);
    fireEvent.click(screen.getByTestId('filter-relief-primary'));
    expect(onWiden).toHaveBeenCalledWith(expect.objectContaining({ key: 'status' }));
  });

  test('it promises the search text is kept — that is the whole point', () => {
    render(<FilterReliefNotice relief={reported} onWiden={() => {}} onClearFilters={() => {}} />);
    expect(screen.getByText(/search text is kept/i)).toBeInTheDocument();
  });

  test('the "search everything" escape hatch appears only when it would find MORE', () => {
    // One filter hiding everything there is: the fallback would be identical
    // to the offer above, so it is not shown.
    render(<FilterReliefNotice relief={reported} onWiden={() => {}} onClearFilters={() => {}} />);
    expect(screen.queryByTestId('filter-relief-all')).not.toBeInTheDocument();

    cleanup();
    const twoFilters = {
      ...reported,
      withoutFilters: 40,
      groups: [
        { key: 'status', label: 'Status', hidden: 1 },
        { key: 'assignee', label: 'Assignee', hidden: 12 },
      ],
    };
    render(<FilterReliefNotice relief={twoFilters} onWiden={() => {}} onClearFilters={() => {}} />);
    expect(screen.getByTestId('filter-relief-all')).toHaveTextContent('Search all tickets for “241226” (40)');
  });

  test('secondary filters are offered too, ranked below the worst offender', () => {
    const multi = {
      ...reported,
      withoutFilters: 40,
      groups: [
        { key: 'assignee', label: 'Assignee', hidden: 12 },
        { key: 'status', label: 'Status', hidden: 1 },
        { key: 'priority', label: 'Priority', hidden: 1 },
      ],
    };
    render(<FilterReliefNotice relief={multi} onWiden={() => {}} onClearFilters={() => {}} />);
    expect(screen.getByTestId('filter-relief-primary')).toHaveTextContent('Clear the Assignee filter (12)');
    expect(screen.getByRole('button', { name: /Include Closed \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clear the Priority filter \(1\)/ })).toBeInTheDocument();
  });

  test('clicking the escape hatch clears everything but the text', () => {
    const onClearFilters = vi.fn();
    render(<FilterReliefNotice
      relief={{ ...reported, withoutFilters: 40, groups: [{ key: 'status', label: 'Status', hidden: 1 }] }}
      onWiden={() => {}}
      onClearFilters={onClearFilters}
    />);
    fireEvent.click(screen.getByTestId('filter-relief-all'));
    expect(onClearFilters).toHaveBeenCalled();
  });

  test('with no query it offers to show all tickets rather than to search', () => {
    render(<FilterReliefNotice
      relief={{ ...reported, hasQuery: false, query: null, withoutFilters: 40, groups: [{ key: 'status', label: 'Status', hidden: 1 }] }}
      onWiden={() => {}}
      onClearFilters={() => {}}
    />);
    expect(screen.getByTestId('filter-relief-all')).toHaveTextContent('Show all tickets (40)');
  });
});

describe('FilterReliefNotice — inline hint', () => {
  test('reads as "more matches" above a list that already has results', () => {
    render(<FilterReliefNotice
      relief={{ ...reported, current: 3, withoutFilters: 15, groups: [{ key: 'status', label: 'Status', hidden: 12 }] }}
      variant="inline"
      onWiden={() => {}}
    />);
    expect(screen.getByTestId('filter-relief-inline')).toHaveTextContent('12 more matches hidden by your Status filter.');
    expect(screen.getByTestId('filter-relief-inline-action')).toBeInTheDocument();
  });

  test('singular reads correctly', () => {
    render(<FilterReliefNotice relief={{ ...reported, current: 3, groups: [{ key: 'status', label: 'Status', hidden: 1 }] }} variant="inline" onWiden={() => {}} />);
    expect(screen.getByTestId('filter-relief-inline')).toHaveTextContent('1 more match hidden');
  });
});

describe('FilterReliefNotice — silence', () => {
  test('nothing renders without an answer, or when nothing is hidden', () => {
    const { container: a } = render(<FilterReliefNotice relief={null} />);
    expect(a).toBeEmptyDOMElement();
    cleanup();
    const { container: b } = render(<FilterReliefNotice relief={{ ...reported, groups: [] }} />);
    expect(b).toBeEmptyDOMElement();
  });
});

describe('reliefActionLabel', () => {
  test('one, two and many statuses read naturally', () => {
    const g = { key: 'status', label: 'Status' };
    expect(reliefActionLabel(g, [{ status: 'Closed' }])).toBe('Include Closed');
    expect(reliefActionLabel(g, [{ status: 'Resolved' }, { status: 'Closed' }])).toBe('Include Resolved and Closed');
    expect(reliefActionLabel(g, [{ status: 'A' }, { status: 'B' }, { status: 'C' }])).toBe('Include 3 more statuses');
  });

  test('a non-status group falls back to clearing it by name', () => {
    expect(reliefActionLabel({ key: 'assignee', label: 'Assignee' }, [])).toBe('Clear the Assignee filter');
  });
});
