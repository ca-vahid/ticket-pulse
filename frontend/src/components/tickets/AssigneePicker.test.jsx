/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AssigneePicker from './AssigneePicker';

// The picker's trigger render never touches the API; stub the module so the
// import doesn't drag in a live axios client during the test.
const assign = vi.fn().mockResolvedValue({});
const recordOverrideReason = vi.fn().mockResolvedValue({});
vi.mock('../../services/api', () => ({
  assignmentAPI: { decide: vi.fn(), recordOverrideReason: (...a) => recordOverrideReason(...a) },
  ticketsAPI: { assign: (...a) => assign(...a), triage: vi.fn() },
}));

afterEach(() => { cleanup(); assign.mockReset(); assign.mockResolvedValue({}); recordOverrideReason.mockClear(); });

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

// QA 08-04 #9: the "Why the override?" prompt — fires when the assign
// response flags a manual pick over a completed AI decision, stays silent
// otherwise, and records the one-click reason.
describe('AssigneePicker override-reason prompt', () => {
  const team = [{ id: 49, name: 'Reza Zaim', origin: 'freshservice' }];

  const pick = async () => {
    fireEvent.click(screen.getByRole('button', { name: /assign a member/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Reza Zaim/ }));
  };

  test('native assign resolving aiOverride:true raises the prompt and posts the reason', async () => {
    assign.mockResolvedValue({ success: true, data: { aiOverride: true } });
    render(<AssigneePicker ticketId={321} value={null} technicians={team} />);
    await pick();

    expect(await screen.findByText('Why the override?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wrong skill' }));
    await waitFor(() => expect(recordOverrideReason).toHaveBeenCalledWith(
      321, { toTechnicianId: 49, reasonCode: 'wrong_skill' },
    ));
    expect(await screen.findByText(/Thanks — noted/)).toBeInTheDocument();
  });

  test('no prompt when the flag is false/absent (e.g. the pick matches the AI decision)', async () => {
    assign.mockResolvedValue({ success: true, data: { aiOverride: false } });
    render(<AssigneePicker ticketId={321} value={null} technicians={team} />);
    await pick();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(321, 49));
    expect(screen.queryByText('Why the override?')).not.toBeInTheDocument();
  });

  test('FS-born path: the prompt fires from the assignFn (fs-update) envelope too', async () => {
    const fsAssign = vi.fn().mockResolvedValue({ success: true, data: { aiOverride: true, synced: ['assignee'] } });
    render(
      <AssigneePicker
        ticketId={654}
        value={null}
        technicians={team}
        ticketOrigin="freshservice"
        assignFn={fsAssign}
      />,
    );
    await pick();

    await waitFor(() => expect(fsAssign).toHaveBeenCalledWith(49));
    expect(await screen.findByText('Why the override?')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  test('a cancelled FS confirmation (rejected assignFn) never prompts', async () => {
    const fsAssign = vi.fn().mockRejectedValue(new Error('cancelled'));
    render(
      <AssigneePicker
        ticketId={654}
        value={null}
        technicians={team}
        ticketOrigin="freshservice"
        assignFn={fsAssign}
      />,
    );
    await pick();

    await waitFor(() => expect(fsAssign).toHaveBeenCalledWith(49));
    expect(screen.queryByText('Why the override?')).not.toBeInTheDocument();
  });
});
