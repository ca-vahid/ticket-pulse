/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AssigneePicker from './AssigneePicker';

// The picker's trigger render never touches the API; stub the module so the
// import doesn't drag in a live axios client during the test.
vi.mock('../../services/api', () => ({
  assignmentAPI: { decide: vi.fn() },
  ticketsAPI: { assign: vi.fn(), triage: vi.fn() },
}));

afterEach(cleanup);

describe('AssigneePicker current-assignee resolution', () => {
  const activeTeam = [{ id: 49, name: 'Reza Zaim', origin: 'freshservice' }];

  test('renders an active team assignee by name, no read-only tag', () => {
    render(<AssigneePicker value={49} technicians={activeTeam} />);
    expect(screen.getByText('Reza Zaim')).toBeInTheDocument();
    expect(screen.queryByText('read-only')).not.toBeInTheDocument();
  });

  test('renders a deactivated/FS-only assignee (not in the active team) with a read-only tag', () => {
    // Reid is the current assignee but is deactivated in TP → absent from the
    // active technicians list. He must still show by name, tagged read-only.
    render(
      <AssigneePicker
        value={48}
        currentTech={{ id: 48, name: 'Reid Laird', origin: 'freshservice', isActive: false }}
        technicians={activeTeam}
      />,
    );
    expect(screen.getByText('Reid Laird')).toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();
  });

  test('a real assignee is never overridden by a pending AI suggestion', () => {
    render(
      <AssigneePicker
        value={48}
        currentTech={{ id: 48, name: 'Reid Laird', origin: 'freshservice', isActive: false }}
        technicians={activeTeam}
        aiSuggestion={{ runId: 1, state: 'suggested', techId: 49, techName: 'Reza Zaim', score: 0.76 }}
      />,
    );
    expect(screen.getByText('Reid Laird')).toBeInTheDocument();
    // The "AI: <name>" fallback must not appear when there's a real assignee.
    expect(screen.queryByText(/^AI:/)).not.toBeInTheDocument();
  });

  test('quick-assign lists all AI candidates (2nd/3rd) when the dropdown is opened', async () => {
    render(
      <AssigneePicker
        value={null}
        technicians={activeTeam}
        aiSuggestion={{
          runId: 1,
          state: 'suggested',
          techId: 49,
          techName: 'Zoe Dio',
          score: 0.89,
          count: 3,
          candidates: [
            { techId: 49, techName: 'Zoe Dio', score: 0.89 },
            { techId: 50, techName: 'Benjamin Rabel', score: 0.87 },
            { techId: 51, techName: 'Dominic Bautista', score: 0.86 },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /assign a member/i }));
    // All three ranked candidates appear as radios inside the AI card.
    expect(await screen.findByRole('radio', { name: /Zoe Dio/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Benjamin Rabel/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Dominic Bautista/ })).toBeInTheDocument();
    expect(screen.getByText('87%')).toBeInTheDocument();
    // Top candidate is pre-selected.
    expect(screen.getByRole('radio', { name: /Zoe Dio/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('falls back to the AI suggestion only when genuinely unassigned', () => {
    render(
      <AssigneePicker
        value={null}
        technicians={activeTeam}
        aiSuggestion={{ runId: 1, state: 'suggested', techId: 49, techName: 'Reza Zaim', score: 0.76 }}
      />,
    );
    expect(screen.getByText(/Reza Zaim/)).toBeInTheDocument();
  });
});
