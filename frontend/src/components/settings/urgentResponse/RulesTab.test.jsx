/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ON_CALL, PREVIEW, SETTINGS, TECHS, ok } from './urgentResponse.fixtures';

// Rules tab: the three steps render from the settings, numbers are edited in
// the sentence, problems are said in plain words and block Save, Save sends
// only what changed, and the estimate follows the draft.

const api = vi.hoisted(() => ({}));
vi.mock('../../../services/api', () => ({ get urgentResponseAPI() { return api; } }));
vi.mock('../../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));

const { default: RulesTab } = await import('./RulesTab');

const CHANGE = { id: 3, changedBy: 'vahid@x.ca', changedByName: 'Vahid Haeri', field: 'clockNotifyMinutes', before: 20, after: 15, createdAt: '2026-10-09T18:00:00Z' };

function setup(props = {}) {
  const onSaved = vi.fn();
  render(
    <RulesTab
      settings={SETTINGS}
      technicians={TECHS}
      techById={new Map(TECHS.map((t) => [t.id, t]))}
      teamsEnabled
      onCall={ON_CALL}
      timezone="America/Vancouver"
      previewDelayMs={0}
      onSaved={onSaved}
      {...props}
    />,
  );
  return { onSaved };
}

const num = (name) => screen.getByRole('spinbutton', { name });
const saveButton = () => screen.getByRole('button', { name: 'Save' });

beforeEach(() => {
  Object.assign(api, {
    preview: vi.fn(async () => ok(PREVIEW)),
    getChanges: vi.fn(async () => ok([CHANGE])),
    updateSettings: vi.fn(async (patch) => ok({ settings: { ...SETTINGS, ...patch }, changes: Object.keys(patch).map((field, i) => ({ id: 100 + i, field })) })),
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Urgent response: Rules', () => {
  test('draws the three steps from the settings', async () => {
    setup();
    const steps = screen.getAllByRole('listitem').filter((li) => /^Step \d/.test(li.getAttribute('aria-label') || ''));
    expect(steps.map((li) => li.getAttribute('aria-label'))).toEqual([
      'Step 1: When assigning', 'Step 2: When it becomes urgent', 'Step 3: If nobody touches it',
    ]);
    expect(num('Minutes before a shift starts that still count as at work')).toHaveValue(30);
    expect(steps[0]).toHaveTextContent(/Only assign to people who are at work, or who start within\s*min\./);
    expect(num('Minutes before the people at work are told')).toHaveValue(15);
    expect(num('Minutes before the ticket moves')).toHaveValue(30);
    expect(screen.getByRole('switch', { name: 'When assigning: on or off' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'When assigning: applies to High' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'When it becomes urgent: applies to High' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Leave it with them and tell the people at work/ })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Person told when nobody is at work' })).toHaveTextContent('Susan Xu');
    // The four fixed steps of picking the next owner, read-only.
    expect(within(screen.getByRole('region', { name: 'How the next owner is picked' })).getAllByRole('listitem')).toHaveLength(4);
    expect(saveButton()).toBeDisabled();
    await waitFor(() => expect(api.preview).toHaveBeenCalled());
  });

  test('the estimate is worked out from the draft and marked as an estimate', async () => {
    setup();
    const box = screen.getByTestId('urgent-preview');
    await waitFor(() => expect(box).toHaveTextContent('With these settings, the last 30 days would have had 12 redirected, 3 moved, 5 team notices and 1 clock move (estimate).'));
    expect(within(box).getByText('Estimate')).toBeInTheDocument();
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ clockNotifyMinutes: 15, clockMoveMinutes: 30 }));

    fireEvent.change(num('Minutes before the people at work are told'), { target: { value: '10' } });
    await waitFor(() => expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ clockNotifyMinutes: 10 })));
  });

  test('Save sends only what changed', async () => {
    const { onSaved } = setup();
    fireEvent.change(num('Minutes before the people at work are told'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'If nobody touches it: applies to High' }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1));
    expect(api.updateSettings).toHaveBeenCalledWith({ clockNotifyMinutes: 10, clockPriorities: [4, 3] });
    expect(await screen.findByText('Saved. 2 changes recorded below.')).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ clockNotifyMinutes: 10 }));
  });

  test('problems are said in plain words and block Save', async () => {
    setup();
    fireEvent.change(num('Minutes before the ticket moves'), { target: { value: '5' } });
    const problems = () => screen.getByTestId('urgent-rule-problems');
    expect(problems()).toHaveTextContent('The ticket cannot move before people are told');
    expect(saveButton()).toBeDisabled();
    fireEvent.change(num('Minutes before the ticket moves'), { target: { value: '30' } });
    expect(screen.queryByTestId('urgent-rule-problems')).not.toBeInTheDocument();

    // A step that is on needs at least one priority.
    fireEvent.click(screen.getByRole('checkbox', { name: 'When it becomes urgent: applies to Urgent' }));
    expect(problems()).toHaveTextContent('“When it becomes urgent” is on but applies to nothing');
    fireEvent.click(screen.getByRole('switch', { name: 'When it becomes urgent: on or off' }));
    expect(screen.queryByTestId('urgent-rule-problems')).not.toBeInTheDocument();

    // Named people needs a person.
    fireEvent.click(screen.getByRole('radio', { name: 'Named people' }));
    expect(problems()).toHaveTextContent('“Named people” needs at least one person.');
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Maria Lee' }));
    expect(screen.queryByTestId('urgent-rule-problems')).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({
      raisePriorities: [], raiseEnabled: false, notifyAudience: 'named', notifyTechnicianIds: [3],
    }));
  });

  test('the grace minutes go from 0 (strictly at work) to 480', async () => {
    setup();
    const grace = num('Minutes before a shift starts that still count as at work');
    fireEvent.change(grace, { target: { value: '481' } });
    expect(screen.getByTestId('urgent-rule-problems')).toHaveTextContent('from 0 to 480');
    fireEvent.change(grace, { target: { value: '0' } });
    expect(screen.queryByTestId('urgent-rule-problems')).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ assignGraceMinutes: 0 }));
  });

  test('the estimate waits while there is a problem', async () => {
    setup();
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(1));
    fireEvent.change(num('Minutes before the ticket moves'), { target: { value: '' } });
    expect(screen.getByTestId('urgent-preview')).toHaveTextContent('Fix the points below');
    await new Promise((r) => setTimeout(r, 20));
    expect(api.preview).toHaveBeenCalledTimes(1);
  });

  test('Teams is shown as unavailable when the workspace has it off', () => {
    setup({ teamsEnabled: false });
    expect(screen.getByRole('checkbox', { name: 'Teams' })).toBeDisabled();
    expect(screen.getByText('Teams is not available: it is switched off for this workspace.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'E-mail' })).toBeChecked();
  });

  test('people are picked with the in-app select; the on-call choice names who is on call', async () => {
    setup();
    fireEvent.click(screen.getByRole('combobox', { name: 'Coordinator' }));
    // Inactive people are not offered.
    expect(screen.queryByRole('option', { name: /Gone Person/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Maria Lee' }));
    fireEvent.click(screen.getByRole('radio', { name: /Give it to the on-call person/ }));
    expect(screen.getByText(/On call now:/)).toHaveTextContent('David Zapata');
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ nobodyMode: 'on_call', coordinatorTechnicianId: 3 }));
  });

  test('lists the changes: who, when, before → after', async () => {
    setup();
    const list = await screen.findByTestId('urgent-changes');
    expect(list).toHaveTextContent('Vahid Haeri');
    expect(list).toHaveTextContent('If nobody touches it: tell people after: 20 min → 15 min');
    // 18:00Z is 11:00 in the workspace time zone.
    expect(list).toHaveTextContent('Oct 9, 11:00 AM');
    expect(api.getChanges).toHaveBeenCalledWith(50);
  });
});
