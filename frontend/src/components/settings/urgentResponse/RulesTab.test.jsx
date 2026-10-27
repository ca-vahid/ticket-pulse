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
    updateCoordinators: vi.fn(async (body) => ok({ ...body, fromLegacy: false, saved: true, changed: true })),
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
    fireEvent.click(screen.getByRole('combobox', { name: 'Person told when nobody is at work' }));
    // Inactive people are not offered.
    expect(screen.queryByRole('option', { name: /Gone Person/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Maria Lee' }));
    fireEvent.click(screen.getByRole('radio', { name: /Give it to the on-call person/ }));
    expect(screen.getByText(/On call now:/)).toHaveTextContent('David Zapata');
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ nobodyMode: 'on_call', nobodyContactTechnicianId: 3 }));
    expect(api.updateCoordinators).not.toHaveBeenCalled();
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

  test('the workspace coordinators are the fallback, and the groups with their own coordinator are listed, linking to Groups', () => {
    setup({
      groupCoordinators: [
        { groupId: 3, groupName: 'Service Desk', groupActive: true, coordinator: { id: 3, name: 'Maria Lee', isActive: true }, backup: { id: 1, name: 'Andrew Fong', isActive: true } },
        { groupId: 4, groupName: 'Network', groupActive: true, coordinator: { id: 9, name: 'Gone Person', isActive: false }, backup: null },
      ],
    });
    const box = screen.getByRole('region', { name: 'If it keeps moving' });
    expect(within(box).getByText('Coordinators')).toBeInTheDocument();
    expect(within(box).getByText('Used when the ticket’s group has no coordinator of its own. Most workspaces only need this.')).toBeInTheDocument();
    expect(within(box).queryByRole('combobox', { name: 'Workspace coordinator' })).not.toBeInTheDocument();
    expect(within(box).getByText('Group coordinators (optional)')).toBeInTheDocument();
    const list = screen.getByTestId('group-coordinators');
    expect(list).toHaveTextContent('Service Desk — Maria Lee (backup Andrew Fong)');
    expect(list).toHaveTextContent('Network — Gone Person (inactive)');
    expect(within(list).getByRole('link', { name: 'Set them in Groups' })).toHaveAttribute('href', '/settings#groups');
  });

  test('no group has its own coordinator: says the coordinators are used for every ticket', () => {
    setup();
    expect(screen.getByTestId('group-coordinators')).toHaveTextContent('No group has its own coordinator, so the coordinators above are used for every ticket.');
  });
});

// QA 10-15 item 9: one to three workspace coordinators instead of one per group.
describe('Urgent response: workspace coordinators', () => {
  const CREW = [
    { id: 11, name: 'Priya Nair', isActive: true },
    { id: 12, name: 'Sam Okafor', isActive: true },
    { id: 13, name: 'Dana Whitfield', isActive: true },
    { id: 14, name: 'Lena Brooks', isActive: true },
    { id: 15, name: 'Old Hand', isActive: false },
  ];
  const crew = (props = {}) => setup({ technicians: CREW, techById: new Map(CREW.map((t) => [t.id, t])), ...props });
  const editor = () => screen.getByTestId('workspace-coordinators');
  const add = (name) => {
    fireEvent.click(within(editor()).getByRole('combobox', { name: 'Add a coordinator' }));
    fireEvent.click(screen.getByRole('option', { name }));
  };
  // The names in list order, read from each row's Remove button.
  const listed = () => within(editor()).queryAllByRole('button', { name: /^Remove / }).map((b) => b.getAttribute('aria-label').slice('Remove '.length));

  test('nothing saved yet: the old single coordinator is the first entry, and nothing is unsaved', () => {
    crew({ settings: { ...SETTINGS, coordinatorTechnicianId: 13 } });
    expect(listed()).toEqual(['Dana Whitfield']);
    expect(screen.getByRole('radio', { name: 'Give it to the first one who is working (by the order above)' })).toBeChecked();
    expect(saveButton()).toBeDisabled();
  });

  test('add up to three in order, remove, reorder, pick "all at once", and Save sends the list', async () => {
    const { onSaved } = crew({ workspaceCoordinators: { technicianIds: [], mode: 'first_available', fromLegacy: false, saved: false } });
    expect(within(editor()).getByText('Nobody yet: the ticket stays with its last owner.')).toBeInTheDocument();

    fireEvent.click(within(editor()).getByRole('combobox', { name: 'Add a coordinator' }));
    // Inactive people are not offered.
    expect(screen.queryByRole('option', { name: /Old Hand/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Priya Nair' }));
    add('Sam Okafor');
    // Somebody already on the list is not offered again.
    fireEvent.click(within(editor()).getByRole('combobox', { name: 'Add a coordinator' }));
    expect(screen.queryByRole('option', { name: 'Priya Nair' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Dana Whitfield' }));
    expect(listed()).toEqual(['Priya Nair', 'Sam Okafor', 'Dana Whitfield']);
    // Three is the most.
    expect(within(editor()).queryByRole('combobox', { name: 'Add a coordinator' })).not.toBeInTheDocument();
    expect(within(editor()).getByText('Three is the most. Remove one to add someone else.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sam Okafor' }));
    expect(within(editor()).getByRole('combobox', { name: 'Add a coordinator' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move Dana Whitfield up' }));
    expect(listed()).toEqual(['Dana Whitfield', 'Priya Nair']);

    fireEvent.click(screen.getByRole('radio', { name: 'Alert all of them at once; the first one who is working owns it' }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateCoordinators).toHaveBeenCalledWith({ technicianIds: [13, 11], mode: 'all' }));
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved. 1 change recorded below.')).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith({}, { coordinators: { technicianIds: [13, 11], mode: 'all', updatedBy: null, updatedAt: null } });
    expect(saveButton()).toBeDisabled();
  });

  test('a rule change and a coordinator change go out with one Save; Discard puts the list back', async () => {
    crew({ workspaceCoordinators: { technicianIds: [11], mode: 'first_available' } });
    fireEvent.change(num('Minutes before the people at work are told'), { target: { value: '10' } });
    add('Lena Brooks');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(listed()).toEqual(['Priya Nair']);
    expect(saveButton()).toBeDisabled();

    fireEvent.change(num('Minutes before the people at work are told'), { target: { value: '10' } });
    add('Lena Brooks');
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateCoordinators).toHaveBeenCalledWith({ technicianIds: [11, 14], mode: 'first_available' }));
    expect(api.updateSettings).toHaveBeenCalledWith({ clockNotifyMinutes: 10 });
    expect(await screen.findByText('Saved. 2 changes recorded below.')).toBeInTheDocument();
  });

  test('a refused save says why and keeps the draft', async () => {
    api.updateCoordinators = vi.fn(async () => { throw new Error('Coordinators: pick active technicians of this workspace'); });
    crew({ workspaceCoordinators: { technicianIds: [], mode: 'first_available' } });
    add('Priya Nair');
    fireEvent.click(saveButton());
    expect(await screen.findByText(/Coordinators not saved: Coordinators: pick active technicians of this workspace/)).toBeInTheDocument();
    expect(listed()).toEqual(['Priya Nair']);
  });

  // QA 10-26 #5: the list was picked on screen but never reached the server.
  test('an unsaved list says so right under it, with its own Save', async () => {
    crew({ workspaceCoordinators: { technicianIds: [], mode: 'first_available', saved: false } });
    expect(screen.queryByTestId('coordinators-unsaved')).toBeNull();
    add('Priya Nair');
    expect(screen.getByTestId('coordinators-unsaved')).toHaveTextContent('Coordinators not saved yet.');
    fireEvent.click(within(screen.getByTestId('coordinators-unsaved')).getByRole('button', { name: 'Save now' }));
    await waitFor(() => expect(api.updateCoordinators).toHaveBeenCalledWith({ technicianIds: [11], mode: 'first_available' }));
    await waitFor(() => expect(screen.queryByTestId('coordinators-unsaved')).toBeNull());
  });

  test('a stored list says who saved it and when', () => {
    crew({ workspaceCoordinators: { technicianIds: [11, 12], mode: 'all', saved: true, updatedBy: 'rita@x.io', updatedAt: '2026-10-16T19:40:00Z' } });
    expect(listed()).toEqual(['Priya Nair', 'Sam Okafor']);
    expect(screen.getByTestId('coordinators-saved')).toHaveTextContent('Saved by rita@x.io on Oct 16, 12:40 PM.');
  });

  test('a refused rules change never keeps the coordinators from being stored', async () => {
    api.updateSettings = vi.fn(async () => { throw new Error('Who is told: pick active technicians of this workspace'); });
    crew({ workspaceCoordinators: { technicianIds: [11], mode: 'first_available' } });
    fireEvent.change(num('Minutes before the people at work are told'), { target: { value: '10' } });
    add('Lena Brooks');
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateCoordinators).toHaveBeenCalledWith({ technicianIds: [11, 14], mode: 'first_available' }));
    expect(await screen.findByText(/The coordinators were saved; the rules were not: Who is told/)).toBeInTheDocument();
    expect(screen.queryByTestId('coordinators-unsaved')).toBeNull();
    // The rule change is still there to fix and save again.
    expect(saveButton()).toBeEnabled();
  });

  test('leaving the page with unsaved coordinators asks first', () => {
    crew({ workspaceCoordinators: { technicianIds: [], mode: 'first_available' } });
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
    add('Priya Nair');
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  });

  test('a reload of the saved list shows it (the tab stays open)', () => {
    const props = { technicians: CREW, techById: new Map(CREW.map((t) => [t.id, t])), settings: SETTINGS, teamsEnabled: true, onCall: ON_CALL, timezone: 'America/Vancouver', previewDelayMs: 0, onSaved: vi.fn() };
    const { rerender } = render(<RulesTab {...props} workspaceCoordinators={{ technicianIds: [], mode: 'first_available' }} />);
    expect(listed()).toEqual([]);
    rerender(<RulesTab {...props} workspaceCoordinators={{ technicianIds: [12], mode: 'first_available', saved: true }} />);
    expect(listed()).toEqual(['Sam Okafor']);
    expect(saveButton()).toBeDisabled();
  });

  test('the change history reads the list in words', async () => {
    api.getChanges = vi.fn(async () => ok([{
      id: 9, changedByName: 'Dana Whitfield', field: 'coordinators', before: { technicianIds: [], mode: 'first_available' }, after: { technicianIds: [11, 12], mode: 'all' }, createdAt: '2026-10-15T18:00:00Z',
    }]));
    crew();
    expect(await screen.findByTestId('urgent-changes')).toHaveTextContent('Coordinators: nobody → Priya Nair, Sam Okafor (all at once)');
  });
});
