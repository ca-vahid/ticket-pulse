/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CategoriesManagementTab from './CategoriesManagementTab';
import { assignmentAPI } from '../../services/api';

// Contract mock for the Categories overhaul: GET /assignment/competencies now
// returns `categoriesDetailed` — every row (including retired) with counts.
const DETAILED = [
  { id: 1, name: 'Project Setup', description: 'New project spin-up', parentId: null, parentName: null, isActive: true, source: 'manual', sortOrder: 1, isSystemSuggested: false, ticketCount: 42, techCount: 5, childCount: 2 },
  { id: 2, name: 'Quebec', description: null, parentId: 1, parentName: 'Project Setup', isActive: true, source: 'manual', sortOrder: 0, isSystemSuggested: false, ticketCount: 12, techCount: 3, childCount: 0 },
  { id: 3, name: 'Ontario', description: null, parentId: 1, parentName: 'Project Setup', isActive: true, source: 'manual', sortOrder: 0, isSystemSuggested: false, ticketCount: 8, techCount: 2, childCount: 0 },
  { id: 4, name: 'Proposal Setup', description: 'Pre-award work', parentId: null, parentName: null, isActive: true, source: 'freshservice', sortOrder: 2, isSystemSuggested: false, ticketCount: 7, techCount: 2, childCount: 1 },
  { id: 5, name: 'Alberta', description: null, parentId: 4, parentName: 'Proposal Setup', isActive: true, source: 'manual', sortOrder: 0, isSystemSuggested: false, ticketCount: 3, techCount: 1, childCount: 0 },
  { id: 6, name: 'Old Hardware', description: 'Legacy queue', parentId: null, parentName: null, isActive: false, source: 'manual', sortOrder: 9, isSystemSuggested: false, ticketCount: 99, techCount: 0, childCount: 0 },
];

vi.mock('../../services/api', () => ({
  assignmentAPI: {
    getCompetencies: vi.fn(),
    createCategory: vi.fn(() => Promise.resolve({})),
    updateCategory: vi.fn(() => Promise.resolve({})),
    deleteCategory: vi.fn(() => Promise.resolve({})),
    mergeCategories: vi.fn(() => Promise.resolve({})),
    detectDuplicateCategories: vi.fn(() => Promise.resolve({ data: [] })),
  },
}));

const renderTab = async () => {
  render(<CategoriesManagementTab />);
  await waitFor(() => expect(screen.getByText('Project Setup')).toBeInTheDocument());
};

describe('CategoriesManagementTab (tree overhaul)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignmentAPI.getCompetencies.mockResolvedValue({ data: { categoriesDetailed: DETAILED, categories: [], categoryTree: [] } });
  });
  afterEach(() => cleanup());

  test('renders two-level tree from categoriesDetailed with counts, source chip, and retired section', async () => {
    await renderTab();
    // Parents and subs
    expect(screen.getByText('Proposal Setup')).toBeInTheDocument();
    expect(screen.getByText('Quebec')).toBeInTheDocument();
    expect(screen.getByText('Ontario')).toBeInTheDocument();
    expect(screen.getByText('Alberta')).toBeInTheDocument();
    // Counts badges
    expect(screen.getByText('42 tickets · 5 techs')).toBeInTheDocument();
    // Source chip only for non-manual rows
    expect(screen.getByText('Freshservice')).toBeInTheDocument();
    // Header totals: 2 active parents, 3 active subs, 1 retired
    expect(screen.getByText(/2 categories · 3 subcategories · 1 retired/)).toBeInTheDocument();
    // Retired section is collapsed but labeled with count; row inside on expand
    const retiredToggle = screen.getByRole('button', { name: /Retired \(1\)/ });
    expect(screen.queryByText('Old Hardware')).not.toBeInTheDocument();
    fireEvent.click(retiredToggle);
    expect(screen.getByText('Old Hardware')).toBeInTheDocument();
    expect(screen.getByText('Retired')).toBeInTheDocument();
  });

  test('inline rename commits on Enter and refetches', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Quebec' }));
    const input = screen.getByLabelText('New name for Quebec');
    fireEvent.change(input, { target: { value: 'Quebec City' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(assignmentAPI.updateCategory).toHaveBeenCalledWith(2, { name: 'Quebec City' }));
    // refetch keeps the Skill Matrix consistent
    await waitFor(() => expect(assignmentAPI.getCompetencies).toHaveBeenCalledTimes(2));
  });

  test('rename conflict shows the friendly error inline under the row, not a page banner', async () => {
    const conflict = new Error('Request failed');
    conflict.response = { status: 409, data: { success: false, message: 'Subcategory "Ontario" already exists under "Project Setup"' } };
    assignmentAPI.updateCategory.mockRejectedValueOnce(conflict);
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Quebec' }));
    const input = screen.getByLabelText('New name for Quebec');
    fireEvent.change(input, { target: { value: 'Ontario' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Subcategory "Ontario" already exists under "Project Setup"');
    // still editing (input retained), and no page-level Retry banner
    expect(screen.getByLabelText('New name for Quebec')).toBeInTheDocument();
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    // Escape cancels cleanly
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('New name for Quebec')).not.toBeInTheDocument();
  });

  test('retire flow confirms with history explainer, then PUTs isActive:false; reactivate PUTs isActive:true', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Retire Ontario' }));
    expect(screen.getByText(/Tickets keep their history/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Retire$/ }));
    await waitFor(() => expect(assignmentAPI.updateCategory).toHaveBeenCalledWith(3, { isActive: false }));

    // Reactivate from the retired section
    fireEvent.click(screen.getByRole('button', { name: /Retired \(1\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate Old Hardware' }));
    await waitFor(() => expect(assignmentAPI.updateCategory).toHaveBeenCalledWith(6, { isActive: true }));
  });

  test('delete is disabled with children and confirms with the corrected copy for leaves', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderTab();
    expect(screen.getByRole('button', { name: 'Delete Project Setup' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Quebec' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Only possible when no tickets reference it'));
    await waitFor(() => expect(assignmentAPI.deleteCategory).toHaveBeenCalledWith(2));
    confirmSpy.mockRestore();
  });

  test('merge picker only offers same-parent, same-level candidates and merges with keepId=target', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Merge Quebec into another' }));
    const listbox = screen.getByRole('listbox', { name: 'Merge target' });
    // Sibling under the same parent only — no cross-parent subs, no top-levels
    expect(within(listbox).getByText('Ontario')).toBeInTheDocument();
    expect(within(listbox).queryByText('Alberta')).not.toBeInTheDocument();
    expect(within(listbox).queryByText('Proposal Setup')).not.toBeInTheDocument();
    fireEvent.click(within(listbox).getByText('Ontario'));
    fireEvent.click(screen.getByRole('button', { name: /Merge into "Ontario"/ }));
    await waitFor(() => expect(assignmentAPI.mergeCategories).toHaveBeenCalledWith({ keepId: 3, mergeIds: [2] }));
  });

  test('add flow creates a subcategory under the picked parent', async () => {
    await renderTab();
    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'Quebec' } });
    fireEvent.change(screen.getByLabelText('New category description'), { target: { value: 'Pre-award Quebec work' } });
    // Pick "Proposal Setup" as parent — same sub name under a different parent is allowed now
    fireEvent.click(screen.getByRole('button', { name: /Top-level category/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Proposal Setupparent' }));
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() => expect(assignmentAPI.createCategory).toHaveBeenCalledWith({
      name: 'Quebec', description: 'Pre-award Quebec work', parentId: 4,
    }));
    await waitFor(() => expect(assignmentAPI.getCompetencies).toHaveBeenCalledTimes(2));
  });

  test('search filters the tree but keeps parent context', async () => {
    await renderTab();
    fireEvent.change(screen.getByLabelText('Search categories'), { target: { value: 'alberta' } });
    // Matching sub + its parent stay; unrelated branch disappears
    expect(screen.getByText('Alberta')).toBeInTheDocument();
    expect(screen.getByText('Proposal Setup')).toBeInTheDocument();
    expect(screen.queryByText('Project Setup')).not.toBeInTheDocument();
    expect(screen.queryByText('Quebec')).not.toBeInTheDocument();
  });

  test('falls back to legacy categories payload when categoriesDetailed is absent', async () => {
    assignmentAPI.getCompetencies.mockResolvedValue({
      data: {
        categories: [
          { id: 1, name: 'Project Setup', parentId: null },
          { id: 2, name: 'Quebec', parentId: 1 },
        ],
        categoryTree: [],
      },
    });
    await renderTab();
    expect(screen.getByText('Quebec')).toBeInTheDocument();
    expect(screen.getByText(/1 category · 1 subcategory · 0 retired/)).toBeInTheDocument();
  });
});
