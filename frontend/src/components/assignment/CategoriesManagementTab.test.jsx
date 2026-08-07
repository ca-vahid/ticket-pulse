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
    // Phase 3 — migration-era tools relocated into the tree toolbar
    getSkillDraft: vi.fn(() => Promise.resolve({ data: { draft: null } })),
    discardSkillDraft: vi.fn(() => Promise.resolve({ data: {} })),
    getFreshserviceSkillDrift: vi.fn(() => Promise.resolve({ data: null })),
    syncFreshserviceSkillObjects: vi.fn(() => Promise.resolve({ data: {} })),
    reclassifyTickets: vi.fn(() => Promise.resolve({ data: {} })),
    getReclassificationRuns: vi.fn(() => Promise.resolve({ data: [] })),
    rollbackReclassificationRun: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

const renderTab = async (props = {}) => {
  render(<CategoriesManagementTab {...props} />);
  await waitFor(() => expect(screen.getByText('Project Setup')).toBeInTheDocument());
};

describe('CategoriesManagementTab (tree overhaul)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignmentAPI.getCompetencies.mockResolvedValue({ data: { categoriesDetailed: DETAILED, categories: [], categoryTree: [] } });
    assignmentAPI.getSkillDraft.mockResolvedValue({ data: { draft: null } });
    assignmentAPI.getReclassificationRuns.mockResolvedValue({ data: [] });
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

  // ── Inline add flows (Phase 2 — add-flow modernization) ───────────────

  test('the legacy bottom "Add category or subcategory" bar is gone', async () => {
    await renderTab();
    expect(screen.queryByText('Add category or subcategory')).not.toBeInTheDocument();
    // Its parent picker went with it
    expect(screen.queryByRole('button', { name: /Top-level category/ })).not.toBeInTheDocument();
  });

  test('header + New category opens an inline row that posts parentId null, then refetches and collapses', async () => {
    await renderTab();
    const trigger = screen.getByRole('button', { name: 'New category' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const nameInput = screen.getByLabelText('New category name');
    expect(nameInput).toHaveFocus();

    fireEvent.change(nameInput, { target: { value: 'Networking' } });
    fireEvent.change(screen.getByLabelText('New category description'), { target: { value: 'Switches & VPN' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });

    await waitFor(() => expect(assignmentAPI.createCategory).toHaveBeenCalledWith({
      name: 'Networking', description: 'Switches & VPN', parentId: null,
    }));
    // Refetch keeps the Skill Matrix consistent, then the row collapses and focus returns
    await waitFor(() => expect(assignmentAPI.getCompetencies).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByLabelText('New category name')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('per-category + presets the parentId, expands a collapsed category, and adds under it', async () => {
    await renderTab();
    // Collapse "Project Setup" so the expand-on-open behavior is exercised
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Project Setup' }));
    expect(screen.queryByText('Quebec')).not.toBeInTheDocument();

    const addBtn = screen.getByRole('button', { name: 'Add subcategory to Project Setup' });
    expect(addBtn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(addBtn);

    // Category re-expanded so the inline row lands under its children
    expect(screen.getByText('Quebec')).toBeInTheDocument();
    expect(addBtn).toHaveAttribute('aria-expanded', 'true');
    const nameInput = screen.getByLabelText('New subcategory name under Project Setup');
    expect(nameInput).toHaveFocus();

    fireEvent.change(nameInput, { target: { value: 'Manitoba' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(assignmentAPI.createCategory).toHaveBeenCalledWith({
      name: 'Manitoba', description: null, parentId: 1,
    }));
    await waitFor(() => expect(screen.queryByLabelText('New subcategory name under Project Setup')).not.toBeInTheDocument());
    expect(addBtn).toHaveFocus();
    // Retired rows never offer the + affordance
    fireEvent.click(screen.getByRole('button', { name: /Retired \(1\)/ }));
    expect(screen.queryByRole('button', { name: 'Add subcategory to Old Hardware' })).not.toBeInTheDocument();
  });

  test('create conflict renders the friendly error inline in the add row and keeps it open', async () => {
    const conflict = new Error('Request failed');
    conflict.response = { status: 409, data: { success: false, message: 'Category "Project Setup" already exists' } };
    assignmentAPI.createCategory.mockRejectedValueOnce(conflict);
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'New category' }));
    const nameInput = screen.getByLabelText('New category name');
    fireEvent.change(nameInput, { target: { value: 'Project Setup' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Category "Project Setup" already exists');
    // Row stays open for correction; no refetch happened; no page-level Retry banner
    expect(screen.getByLabelText('New category name')).toBeInTheDocument();
    expect(assignmentAPI.getCompetencies).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    // Typing again clears the error
    fireEvent.change(nameInput, { target: { value: 'Project Setup II' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('Escape cancels the add row and returns focus to the trigger', async () => {
    await renderTab();
    const trigger = screen.getByRole('button', { name: 'New category' });
    fireEvent.click(trigger);
    const nameInput = screen.getByLabelText('New category name');
    fireEvent.change(nameInput, { target: { value: 'Half-typed' } });
    fireEvent.keyDown(nameInput, { key: 'Escape' });

    expect(screen.queryByLabelText('New category name')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(assignmentAPI.createCategory).not.toHaveBeenCalled();
    // Reopening starts clean
    fireEvent.click(trigger);
    expect(screen.getByLabelText('New category name')).toHaveValue('');
  });

  test('empty state offers the + New category affordance', async () => {
    assignmentAPI.getCompetencies.mockResolvedValue({ data: { categoriesDetailed: [], categories: [], categoryTree: [] } });
    render(<CategoriesManagementTab />);
    await waitFor(() => expect(screen.getByText('No categories yet')).toBeInTheDocument());

    const buttons = screen.getAllByRole('button', { name: 'New category' });
    expect(buttons).toHaveLength(2); // header + empty state
    fireEvent.click(buttons[1]);
    expect(screen.getByLabelText('New category name')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'First Category' } });
    fireEvent.keyDown(screen.getByLabelText('New category name'), { key: 'Enter' });
    await waitFor(() => expect(assignmentAPI.createCategory).toHaveBeenCalledWith({
      name: 'First Category', description: null, parentId: null,
    }));
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

  // ── Phase 3 — surface unification: migration tools live in the toolbar ──

  const DRIFT_PAYLOAD = {
    data: {
      configured: { tpSkillCustomField: 'lf_ticket_pulse_category', tpSubskillCustomField: 'lf_ticket_pulse_subcategory' },
      objectRecords: { skills: 12, subskills: 40 },
      skillDrift: { missing: ['Networking'], extra: [] },
      subskillDrift: { missing: [], extra: ['Old Sub'] },
      subskillParentDrift: { missingParent: [], wrongParent: [], unresolved: [] },
      exports: {
        skillCsv: 'value\n"Networking"',
        subskillCsv: 'value',
        skillText: 'Networking',
        subskillText: '',
        hierarchyText: 'Project Setup\n  - Quebec',
      },
    },
  };

  test('non-flag workspaces get a single clean surface: no toolbar extras, no draft lookup', async () => {
    await renderTab();
    expect(screen.queryByRole('button', { name: /FreshService/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reclassify' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Category tools help' })).not.toBeInTheDocument();
    expect(screen.queryByText(/legacy draft from the migration editor/)).not.toBeInTheDocument();
    expect(assignmentAPI.getSkillDraft).not.toHaveBeenCalled();
    // Retired draft-editor chrome never renders anywhere anymore
    expect(screen.queryByText('Categories / Subcategories Draft')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
  });

  test('flagged workspaces render the relocated toolbar (prop-driven), without the old draft editor', async () => {
    await renderTab({ showMigrationControls: true });
    expect(screen.getByRole('button', { name: /FreshService/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reclassify' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Category tools help' })).toBeInTheDocument();
    // Draft Save/Publish and the bulk name grid are gone
    expect(screen.queryByText('Categories / Subcategories Draft')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Legacy mapping review/)).not.toBeInTheDocument();
  });

  test('Check drift calls the drift API and renders the report with export buttons', async () => {
    assignmentAPI.getFreshserviceSkillDrift.mockResolvedValue(DRIFT_PAYLOAD);
    await renderTab({ showMigrationControls: true });

    fireEvent.click(screen.getByRole('button', { name: /FreshService/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Check drift/ }));

    await waitFor(() => expect(assignmentAPI.getFreshserviceSkillDrift).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Freshservice drift report')).toBeInTheDocument();
    expect(screen.getByText(/Missing categories: 1; extra categories: 0/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Categories CSV/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Subcategories CSV/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hierarchy text/ })).toBeInTheDocument();
    // Close hides the report
    fireEvent.click(screen.getByRole('button', { name: 'Close drift report' }));
    expect(screen.queryByText('Freshservice drift report')).not.toBeInTheDocument();
  });

  test('Sync to FreshService requires the create-only confirm; cancel never calls the API', async () => {
    assignmentAPI.syncFreshserviceSkillObjects.mockResolvedValue({
      data: { created: { skills: ['Networking'], subskills: [] }, updated: { subskillParents: [] } },
    });
    await renderTab({ showMigrationControls: true });

    fireEvent.click(screen.getByRole('button', { name: /FreshService/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sync to FreshService/ }));

    const dialog = screen.getByRole('dialog', { name: 'Sync to FreshService?' });
    expect(dialog).toHaveTextContent('Creates missing records and repairs parent links in FreshService. Never deletes. Continue?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(assignmentAPI.syncFreshserviceSkillObjects).not.toHaveBeenCalled();

    // Confirm path
    fireEvent.click(screen.getByRole('button', { name: /FreshService/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sync to FreshService/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Sync to FreshService?' })).getByRole('button', { name: 'Sync to FreshService' }));
    await waitFor(() => expect(assignmentAPI.syncFreshserviceSkillObjects).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Freshservice objects synced\. Created 1 categories and 0 subcategories\./)).toBeInTheDocument();
  });

  test('Reclassify opens the batch panel and Dry Run Batch calls the same reclassify API', async () => {
    assignmentAPI.getReclassificationRuns.mockResolvedValue({
      data: [{ id: 7, mode: 'apply', status: 'completed', createdAt: '2026-08-01T12:00:00Z', summary: { scanned: 25, classified: 20, failed: 0 }, rolledBackAt: null }],
    });
    assignmentAPI.reclassifyTickets.mockResolvedValue({
      data: {
        id: 9, dryRun: true, scanned: 1, classified: 1, reviewNeeded: 0, failed: 0,
        model: 'claude-haiku-4-5-20251001', concurrency: 10, createdAt: '2026-08-01',
        results: [{ ticketId: 10, freshserviceTicketId: 111, subject: 'VPN down', classification: { categoryName: 'Networking' }, createdAt: '2026-07-01' }],
      },
    });
    await renderTab({ showMigrationControls: true });

    const toggle = screen.getByRole('button', { name: 'Reclassify' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Reclassify tickets')).toBeInTheDocument();
    await waitFor(() => expect(assignmentAPI.getReclassificationRuns).toHaveBeenCalled());
    expect(screen.getByText('Recent Reclassification Runs')).toBeInTheDocument();
    expect(screen.getByText('TR-7')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Dry Run Batch/ }));
    await waitFor(() => expect(assignmentAPI.reclassifyTickets).toHaveBeenCalledWith({
      apply: false, days: 180, limit: 25, model: 'claude-haiku-4-5-20251001',
      concurrency: 10, onlyNeedsReview: true, unclassifiedOnly: true,
    }));
    expect(await screen.findByText(/Dry run complete with Haiku 4\.5/)).toBeInTheDocument();
    expect(screen.getByText('FS-111')).toBeInTheDocument();
    expect(screen.getByText('Networking')).toBeInTheDocument();
  });

  test('sync nudge appears after a tree edit, offers Check drift, and dismisses for the session', async () => {
    assignmentAPI.getFreshserviceSkillDrift.mockResolvedValue(DRIFT_PAYLOAD);
    await renderTab({ showMigrationControls: true });
    expect(screen.queryByText(/FreshService objects may be out of date/)).not.toBeInTheDocument();

    // Rename Quebec → nudge appears
    fireEvent.click(screen.getByRole('button', { name: 'Rename Quebec' }));
    const input = screen.getByLabelText('New name for Quebec');
    fireEvent.change(input, { target: { value: 'Quebec City' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText(/FreshService objects may be out of date/)).toBeInTheDocument();

    // Its Check drift shortcut works
    const nudge = screen.getByText(/FreshService objects may be out of date/).closest('[role="status"]');
    fireEvent.click(within(nudge).getByRole('button', { name: 'Check drift' }));
    await waitFor(() => expect(assignmentAPI.getFreshserviceSkillDrift).toHaveBeenCalledTimes(1));

    // Dismiss → gone, and a later edit does NOT bring it back this session
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss sync reminder' }));
    expect(screen.queryByText(/FreshService objects may be out of date/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retire Ontario' }));
    fireEvent.click(screen.getByRole('button', { name: /^Retire$/ }));
    await waitFor(() => expect(assignmentAPI.updateCategory).toHaveBeenCalledWith(3, { isActive: false }));
    expect(screen.queryByText(/FreshService objects may be out of date/)).not.toBeInTheDocument();
  });

  test('no sync nudge on non-flag workspaces even after an edit', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Quebec' }));
    const input = screen.getByLabelText('New name for Quebec');
    fireEvent.change(input, { target: { value: 'Quebec City' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(assignmentAPI.updateCategory).toHaveBeenCalled());
    expect(screen.queryByText(/FreshService objects may be out of date/)).not.toBeInTheDocument();
  });

  test('migration banner shows for a leftover draft and Discard draft confirms then deletes it', async () => {
    assignmentAPI.getSkillDraft.mockResolvedValue({ data: { draft: { id: 5, status: 'draft', source: 'summit_workshop' } } });
    await renderTab({ showMigrationControls: true });

    expect(await screen.findByText(/A legacy draft from the migration editor exists and is no longer editable here/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));

    const dialog = screen.getByRole('dialog', { name: 'Discard legacy draft?' });
    expect(dialog).toHaveTextContent('The live category tree is not affected.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(assignmentAPI.discardSkillDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/A legacy draft from the migration editor exists/)).not.toBeInTheDocument());
    expect(screen.getByText(/Legacy migration draft discarded/)).toBeInTheDocument();
  });

  test('no migration banner when the workspace has no leftover draft', async () => {
    await renderTab({ showMigrationControls: true });
    await waitFor(() => expect(assignmentAPI.getSkillDraft).toHaveBeenCalled());
    expect(screen.queryByText(/legacy draft from the migration editor/)).not.toBeInTheDocument();
  });
});
