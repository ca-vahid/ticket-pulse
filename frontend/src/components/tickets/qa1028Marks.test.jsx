/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalMark, approvalMarkTitle } from './ticketUi';
import { FOCUS_COLUMN_KEYS, QueueColumnsMenu } from './queueColumns';
import GroupedBanner, { isGroupedCopy } from './GroupedBanner';

describe('GroupedBanner (QA 10-28 #4)', () => {
  const copy = { isNoise: true, noiseRuleMatched: 'Grouped: same request as TP-10593', groupedInto: { id: 501, displayRef: 'TP-10593', kind: 'duplicate' } };

  test('names the ticket it went into and opens it', () => {
    const onOpen = vi.fn();
    render(<GroupedBanner ticket={copy} onOpen={onOpen} />);
    expect(screen.getByTestId('grouped-banner')).toHaveTextContent('The same request as TP-10593');
    expect(screen.getByTestId('grouped-banner')).toHaveTextContent('It is not noise');
    fireEvent.click(screen.getByText('TP-10593'));
    expect(onOpen).toHaveBeenCalledWith(501);
  });

  test('falls back to the label when the event is gone; real noise gets no banner', () => {
    const { rerender } = render(<GroupedBanner ticket={{ ...copy, groupedInto: null, noiseRuleMatched: 'Grouped: repeat of TP-9' }} />);
    expect(screen.getByTestId('grouped-banner')).toHaveTextContent('TP-9');
    rerender(<GroupedBanner ticket={{ isNoise: true, noiseRuleMatched: 'Veeam backup errors' }} />);
    expect(screen.queryByTestId('grouped-banner')).not.toBeInTheDocument();
    expect(isGroupedCopy({ isNoise: false, noiseRuleMatched: 'Grouped: x' })).toBe(false);
  });
});

afterEach(() => cleanup());

describe('ApprovalMark (QA 10-28 #2)', () => {
  test('one icon per state, named for screen readers and the tooltip', () => {
    const { rerender } = render(<ApprovalMark approval={{ state: 'pending', approvers: ['Priya Nair'] }} />);
    const mark = screen.getByTestId('approval-mark');
    expect(mark).toHaveAttribute('data-state', 'pending');
    expect(mark).toHaveAttribute('title', 'Waiting for approval · with Priya Nair');
    expect(mark).toHaveTextContent('Waiting for approval · with Priya Nair');

    rerender(<ApprovalMark approval={{ state: 'closed', approvers: ['Sam Okafor'] }} />);
    expect(screen.getByTestId('approval-mark')).toHaveAttribute('title', 'Approval closed without a decision · by Sam Okafor');
  });

  test('no approval, or an unknown state, draws nothing', () => {
    const { container, rerender } = render(<ApprovalMark approval={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ApprovalMark approval={{ state: 'cancelled' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('titles without a name still read', () => {
    expect(approvalMarkTitle({ state: 'approved', approvers: [] })).toBe('Approved');
    expect(approvalMarkTitle({ state: 'info_requested', approvers: ['Dana Whitfield'] })).toBe('Approval on hold for an answer · with Dana Whitfield');
  });
});

describe('Columns menu in Focus (QA 10-28 #3)', () => {
  test('names the fixed set and keeps the switches, without the column list', () => {
    const onSideArrowsChange = vi.fn();
    render(
      <QueueColumnsMenu
        fixedKeys={FOCUS_COLUMN_KEYS}
        value={['subject', 'requester', 'category']}
        onChange={vi.fn()}
        onResetWidths={vi.fn()}
        onColumnMapChange={vi.fn()}
        onSideArrowsChange={onSideArrowsChange}
        onFreezeSubjectChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Columns/ }));
    expect(screen.getByTestId('columns-menu-fixed')).toHaveTextContent('Focus keeps five columns');
    expect(screen.getByTestId('columns-menu-fixed')).toHaveTextContent('Subject · Status · Assignee · Due');
    expect(screen.queryByLabelText('Requester column')).not.toBeInTheDocument();
    expect(screen.queryByText('Reset columns')).not.toBeInTheDocument();
    expect(screen.getByText('Reset widths')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Scroll arrows'));
    expect(onSideArrowsChange).toHaveBeenCalledWith(true);
  });

  test('outside Focus the column list is still there', () => {
    render(<QueueColumnsMenu value={['subject', 'requester']} onChange={vi.fn()} onResetWidths={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Columns/ }));
    expect(screen.getByLabelText('Requester column')).toBeInTheDocument();
    expect(screen.queryByTestId('columns-menu-fixed')).not.toBeInTheDocument();
  });
});
