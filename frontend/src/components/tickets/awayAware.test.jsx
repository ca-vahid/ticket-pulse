/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  ticketsAPI: { assign: vi.fn(() => Promise.resolve({ success: true, data: {} })), triage: vi.fn() },
  assignmentAPI: {},
}));
vi.mock('../../utils/currentIdentity', () => ({ useCurrentIdentity: () => ({ email: 'vahid@example.com', technicianId: 59 }) }));

const { ticketsAPI } = await import('../../services/api');
const { default: AssigneePicker } = await import('./AssigneePicker');
const { default: RichTextEditor } = await import('./RichTextEditor');
const { default: ApprovalComposer } = await import('./ApprovalComposer');
const { awayTag, awaySentence, dayLabel } = await import('../../utils/away');
const { BookTimeButton } = await import('../../pages/Availability');

// Sam off Mon 2 Nov – Fri 13 Nov 2026 (Remembrance Day skipped), back Mon 16 Nov.
const mehdiAway = { firstDay: '2026-11-02', lastDay: '2026-11-13', backOn: '2026-11-16', workingDaysAway: 9, fromToday: false };
const team = [
  { id: 1, name: 'Sam Rivera', away: mehdiAway },
  { id: 2, name: 'Jo Chen' },
];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('away wording', () => {
  it('reads like a person wrote it', () => {
    expect(dayLabel('2026-11-16')).toBe('Mon 16 Nov');
    expect(awayTag(mehdiAway)).toBe('Away · back Mon 16 Nov');
    expect(awaySentence('Sam Rivera', mehdiAway)).toBe('Sam is away from Mon 2 Nov to Fri 13 Nov (9 working days) and back Mon 16 Nov.');
    expect(awaySentence('Sam Rivera', { firstDay: '2026-11-02', lastDay: '2026-11-02', backOn: '2026-11-03', workingDaysAway: 1 }))
      .toBe('Sam is away on Mon 2 Nov (1 working day) and back Tue 3 Nov.');
    expect(awayTag(null)).toBeNull();
  });
});

describe('assigning to someone who is away', () => {
  it('shows the tag in the list, asks first, and assigns only on "Assign anyway"', async () => {
    render(<AssigneePicker ticketId={321} value={null} technicians={team} showAi={false} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('Away · back Mon 16 Nov')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Sam Rivera/ }));
    const dialog = await screen.findByTestId('away-assign-confirm');
    expect(dialog.textContent).toMatch(/Sam is away from Mon 2 Nov to Fri 13 Nov/);
    expect(ticketsAPI.assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Assign anyway' }));
    await waitFor(() => expect(ticketsAPI.assign).toHaveBeenCalledWith(321, 1));
  });

  it('"Pick someone else" assigns nothing', async () => {
    render(<AssigneePicker ticketId={321} value={null} technicians={team} showAi={false} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('option', { name: /Sam Rivera/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pick someone else' }));
    expect(screen.queryByTestId('away-assign-confirm')).toBeNull();
    expect(ticketsAPI.assign).not.toHaveBeenCalled();
  });

  it('someone who is in is assigned straight away', async () => {
    render(<AssigneePicker ticketId={321} value={null} technicians={team} showAi={false} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('option', { name: /Jo Chen/ }));
    await waitFor(() => expect(ticketsAPI.assign).toHaveBeenCalledWith(321, 2));
    expect(screen.queryByTestId('away-assign-confirm')).toBeNull();
  });
});

describe('@mention list', () => {
  it('marks people who are away, and they can still be picked', () => {
    const onMention = vi.fn();
    render(<RichTextEditor ariaLabel="Body" mentionPeople={team} onMention={onMention} />);
    const box = screen.getByRole('textbox', { name: 'Body' });
    box.focus();
    box.innerHTML = '@';
    const range = document.createRange();
    range.setStart(box.firstChild, 1);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    fireEvent.input(box);
    expect(screen.getByTestId('mention-away').textContent).toBe('Away · back Mon 16 Nov');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Sam Rivera/ }));
    expect(onMention).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
});

describe('approval note @mentions (QA 10-30 #8)', () => {
  it('the approval editor offers the agents', () => {
    render(<ApprovalComposer approval={{ id: 5, ticketRef: 'TP-10781' }} onDecide={vi.fn()} onAsk={vi.fn()} mentionPeople={team} layout="choices" showShortcuts={false} />);
    const box = screen.getByRole('textbox', { name: 'Decision note' });
    box.focus();
    box.innerHTML = '@Jo';
    const range = document.createRange();
    range.setStart(box.firstChild, 3);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    fireEvent.input(box);
    expect(screen.getByTestId('mention-menu').textContent).toMatch(/Jo Chen/);
  });
});

describe('Book time away (QA 10-30 #1)', () => {
  it('is a solid button with the words on it', () => {
    const onClick = vi.fn();
    render(<MemoryRouter><BookTimeButton onClick={onClick} /></MemoryRouter>);
    const btn = screen.getByTestId('book-time-away');
    expect(btn.textContent).toBe('Book time away');
    expect(btn.className).toMatch(/bg-primary/);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });
});
