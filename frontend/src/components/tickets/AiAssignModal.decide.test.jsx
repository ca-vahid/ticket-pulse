/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AiAssignModal from './AiAssignModal';
import { assignmentAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getLatestRunForTicket: vi.fn(),
    decide: vi.fn(),
  },
}));

// The real RecommendationCards is exercised elsewhere — here we only need a
// hook to fire onDecide with a realistic payload.
vi.mock('../assignment/LivePipelineView', () => ({
  default: () => null,
  RecommendationCards: ({ onDecide }) => (
    <button onClick={() => onDecide({ decision: 'modified', assignedTechId: 42, overrideReason: null, decisionNote: '' })}>
      apply pick
    </button>
  ),
}));

const ticket = {
  id: 40715,
  displayRef: '#238146',
  freshserviceTicketId: 238146,
  subject: 'Account blocked - Seabridge Gold Inc',
  assignedTechId: null,
  assignedTech: null,
};

const completedRun = {
  id: 9001,
  status: 'completed',
  decision: 'pending_review',
  recommendation: { recommendations: [{ techId: 48, techName: 'Reid Laird' }] },
};

describe('AiAssignModal decide hand-off', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  // Regression guard (QA 08-19, #238146): the decide endpoint returns before
  // the FreshService write-back lands, so the host page can't just refetch —
  // it needs the chosen tech from the decision payload to update its row
  // immediately. onDone must therefore receive the decision data.
  test('passes the decision payload to onDone after a successful apply', async () => {
    assignmentAPI.getLatestRunForTicket.mockResolvedValue({ data: completedRun });
    assignmentAPI.decide.mockResolvedValue({ data: { success: true } });
    const onDone = vi.fn();
    const onClose = vi.fn();

    render(
      <MemoryRouter>
        <AiAssignModal ticket={ticket} onClose={onClose} onDone={onDone} />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'apply pick' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'modified', assignedTechId: 42 }),
    ));
    expect(assignmentAPI.decide).toHaveBeenCalledWith(9001, expect.objectContaining({ assignedTechId: 42 }));
    expect(onClose).toHaveBeenCalled();
  });

  test('a failed decide surfaces the error and never fires onDone', async () => {
    assignmentAPI.getLatestRunForTicket.mockResolvedValue({ data: completedRun });
    assignmentAPI.decide.mockRejectedValue({ response: { data: { message: 'Target agent is not a member of group' } } });
    const onDone = vi.fn();
    const onClose = vi.fn();

    render(
      <MemoryRouter>
        <AiAssignModal ticket={ticket} onClose={onClose} onDone={onDone} />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'apply pick' }));

    expect(await screen.findByText(/Target agent is not a member of group/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
