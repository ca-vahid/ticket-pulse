/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LearnedSkillsTab from './LearnedSkillsTab';

// QA 10-09 item 12: Assignment Review → Competencies → Learned skills.
const { listSpy, keepSpy, removeSpy, levelSpy, rosterSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(), keepSpy: vi.fn(), removeSpy: vi.fn(), levelSpy: vi.fn(), rosterSpy: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getLearnedSkills: (...a) => listSpy(...a),
    keepLearnedSkills: (...a) => keepSpy(...a),
    removeLearnedSkills: (...a) => removeSpy(...a),
    setLearnedSkillLevel: (...a) => levelSpy(...a),
    getCompetencyTechnicians: (...a) => rosterSpy(...a),
  },
}));

const item = (id, tech, category, level, closed, aiAssigned, expectedForLevel) => ({
  id, level, notes: 'Auto-created from closed tickets', createdAt: '2026-10-08T17:00:00Z', updatedAt: '2026-10-08T17:00:00Z',
  technician: { ...tech, isActive: true, assignableOnly: false },
  category,
  evidence: { closed, aiAssigned, expectedForLevel, belowBar: closed < expectedForLevel },
});
const ZOE = { id: 8, name: 'Zoe Zed', email: 'zoe@example.com' };
const ADAM = { id: 7, name: 'Adam Ant', email: 'adam@example.com' };
const NEW_HIRES = { id: 12, name: 'New hires', parentId: 10, parentName: 'Onboarding' };
const PRINTERS = { id: 20, name: 'Printers', parentId: null, parentName: null };
const VPN = { id: 21, name: 'VPN', parentId: null, parentName: null };

// Server order: weakest evidence first.
const DATA = () => ({
  items: [
    item(1, ZOE, NEW_HIRES, 'advanced', 2, 2, 25),
    item(2, ADAM, VPN, 'intermediate', 3, 0, 10),
    item(3, ADAM, PRINTERS, 'basic', 4, 1, 1),
  ],
  total: 3, belowBar: 2,
  thresholds: { basic: 1, intermediate: 10, advanced: 25 },
  levels: ['basic', 'intermediate', 'advanced', 'expert'],
  learningEnabled: true,
});

const mount = (props = {}) => render(<LearnedSkillsTab {...props} />);
const rows = () => screen.getAllByTestId('learned-row');

beforeEach(() => {
  listSpy.mockReset(); listSpy.mockResolvedValue({ data: DATA() });
  keepSpy.mockReset(); keepSpy.mockResolvedValue({ data: { kept: 1 } });
  removeSpy.mockReset(); removeSpy.mockResolvedValue({ data: { removed: 1 } });
  levelSpy.mockReset(); levelSpy.mockResolvedValue({ data: { id: 1, level: 'basic' } });
  rosterSpy.mockReset(); rosterSpy.mockResolvedValue({ data: [{ id: 7, photoUrl: 'https://example.com/adam.png' }] });
});
afterEach(cleanup);

describe('LearnedSkillsTab', () => {
  test('lists learned skills grouped by person in name order, with the evidence', async () => {
    mount();
    await screen.findAllByTestId('learned-row');

    expect(screen.getByText('Skills the system added — confirm or remove.')).toBeInTheDocument();
    expect(screen.getByText(/Basic from 1 closed, Comfortable from 10, Advanced from 25/)).toBeInTheDocument();
    expect(screen.getByTestId('learned-summary')).toHaveTextContent('3 skills added by the system · 2 with fewer closed tickets than their level asks for');

    // Name order, not a ranking: Adam before Zoe although Zoe's row is the weakest.
    const groups = screen.getAllByTestId('learned-group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Adam Ant', 'Zoe Zed']);
    // Inside a person the server's weakest-first order is kept.
    const adamRows = within(groups[0]).getAllByTestId('learned-row');
    expect(adamRows[0]).toHaveTextContent('VPN');
    expect(adamRows[1]).toHaveTextContent('Printers');

    const zoeRow = within(groups[1]).getByTestId('learned-row');
    expect(zoeRow).toHaveTextContent('Onboarding › New hires');
    expect(within(zoeRow).getByTestId('learned-evidence')).toHaveTextContent('2 tickets closed · 2 assigned by the AI');
    expect(within(zoeRow).getByTestId('learned-evidence')).toHaveTextContent('Advanced asks for 25');
    expect(within(adamRows[1]).getByTestId('learned-evidence')).not.toHaveTextContent('asks for');
  });

  test('photos come from the roster, never from the learned-skills payload', async () => {
    const { container } = mount();
    await screen.findAllByTestId('learned-row');
    await waitFor(() => expect(container.querySelector('img[src="https://example.com/adam.png"]')).toBeInTheDocument());
    expect(rosterSpy).toHaveBeenCalledTimes(1);
  });

  test('Keep confirms one skill and takes it off the list', async () => {
    mount();
    await screen.findAllByTestId('learned-row');
    fireEvent.click(screen.getByRole('button', { name: 'Keep VPN for Adam Ant' }));

    await waitFor(() => expect(keepSpy).toHaveBeenCalledWith([2]));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByText('VPN')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 skill kept');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  test('Remove asks first, then deletes', async () => {
    mount();
    await screen.findAllByTestId('learned-row');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Onboarding › New hires for Zoe Zed' }));
    expect(removeSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(rows()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Onboarding › New hires for Zoe Zed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith([1]));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole('region', { name: 'Zoe Zed' })).not.toBeInTheDocument();
  });

  test('bulk: select several, keep them in one request', async () => {
    mount();
    await screen.findAllByTestId('learned-row');
    expect(screen.queryByTestId('learned-bulk-bar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: "Select all of Adam Ant's learned skills" }));
    expect(screen.getByTestId('learned-bulk-bar')).toHaveTextContent('2 selected');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Onboarding › New hires for Zoe Zed' }));
    expect(screen.getByTestId('learned-bulk-bar')).toHaveTextContent('3 selected');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Printers for Adam Ant' }));
    expect(screen.getByTestId('learned-bulk-bar')).toHaveTextContent('2 selected');

    fireEvent.click(screen.getByRole('button', { name: 'Keep selected' }));
    await waitFor(() => expect(keepSpy).toHaveBeenCalledTimes(1));
    expect([...keepSpy.mock.calls[0][0]].sort()).toEqual([1, 2]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByTestId('learned-bulk-bar')).not.toBeInTheDocument();
  });

  test('bulk remove asks first, then deletes the selection in one request', async () => {
    mount();
    await screen.findAllByTestId('learned-row');
    fireEvent.click(screen.getByRole('checkbox', { name: "Select all of Adam Ant's learned skills" }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected' }));
    expect(removeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('learned-bulk-bar')).toHaveTextContent('Remove 2 skills?');

    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
    expect([...removeSpy.mock.calls[0][0]].sort()).toEqual([2, 3]);
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  test('changing the level saves it and confirms the row', async () => {
    mount();
    await screen.findAllByTestId('learned-row');
    fireEvent.click(screen.getByRole('combobox', { name: 'Level of Onboarding › New hires for Zoe Zed' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Basic' }));

    await waitFor(() => expect(levelSpy).toHaveBeenCalledWith(1, 'basic'));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  test('filters by person, by level, and to thin evidence only', async () => {
    mount();
    await screen.findAllByTestId('learned-row');

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by person' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Adam Ant' }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId('learned-summary')).toHaveTextContent('showing 2');

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by level' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Basic' }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('Printers');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Thin evidence only' }));
    expect(screen.queryAllByTestId('learned-row')).toHaveLength(0);
    expect(screen.getByText('No learned skills match these filters.')).toBeInTheDocument();
  });

  test('a failed save keeps the row and says why', async () => {
    keepSpy.mockRejectedValue({ response: { data: { message: 'Admin access required' } } });
    mount();
    await screen.findAllByTestId('learned-row');
    fireEvent.click(screen.getByRole('button', { name: 'Keep VPN for Adam Ant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required');
    expect(rows()).toHaveLength(3);
  });

  test('nothing to review', async () => {
    listSpy.mockResolvedValue({ data: { ...DATA(), items: [], total: 0, belowBar: 0 } });
    mount();
    expect(await screen.findByText('Nothing to review.')).toBeInTheDocument();
  });

  test('says so when learning is switched off for the workspace', async () => {
    listSpy.mockResolvedValue({ data: { ...DATA(), learningEnabled: false } });
    mount();
    expect(await screen.findByText(/Learning from closed tickets is switched off/)).toBeInTheDocument();
  });
});
