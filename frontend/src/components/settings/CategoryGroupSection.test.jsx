/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Category ↔ group mapping, two-pane builder (FR 09-10).
 *
 * The panel it replaced rendered every category against every group — 11 × 17 =
 * 187 buttons — whether or not anything was mapped, so the normal state ("this
 * category is not scoped") was drawn as a wall of unselected chips and the only
 * real information was 10px italic text at the end of a wrapped line.
 *
 * What these tests protect is the thing that made Option 3 the pick: the panel
 * now says, in a sentence, what a mapping will actually do.
 */

const CATEGORIES = [
  { id: 1, name: 'Account & Access' },
  { id: 2, name: 'Cloud & Servers' },
  { id: 3, name: 'Security' },
];
const GROUPS = [
  { id: 900, freshserviceId: 900, name: 'Servers' },
  { id: 901, freshserviceId: 901, name: 'Azure & M365' },
  { id: 902, freshserviceId: 902, name: 'Cyber Security' },
];

const { api } = vi.hoisted(() => ({
  api: {
    meta: vi.fn(),
    categoryGroupLinks: vi.fn(),
    setCategoryGroupLinks: vi.fn(),
  },
}));

vi.mock('../../services/api', () => ({
  ticketsAPI: api,
  settingsAPI: { get: vi.fn().mockResolvedValue({ data: {} }), update: vi.fn() },
  workspaceAPI: { get: vi.fn().mockResolvedValue({ data: {} }) },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [] }),
  invalidateTicketTypesCache: vi.fn(),
}));

const { CategoryGroupSection } = await import('./TicketOpsPanel');

beforeEach(() => {
  api.meta.mockResolvedValue({ data: { categoryTree: CATEGORIES, groups: GROUPS } });
  api.categoryGroupLinks.mockResolvedValue({ data: [{ categoryId: 2, groupId: 900 }] });
  api.setCategoryGroupLinks.mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ready = async () => {
  render(<CategoryGroupSection />);
  await screen.findByTestId('cgm-category-list');
};

describe('the summary line', () => {
  test('says how many categories are scoped, so the default state reads as a fact not a wall', async () => {
    await ready();
    await waitFor(() => expect(screen.getByTestId('cgm-summary'))
      .toHaveTextContent('1 of 3 categories are scoped to specific groups. The rest show everywhere.'));
  });
});

describe('the explainer — the reason this layout was chosen', () => {
  test('an unscoped category says it can be picked anywhere', async () => {
    await ready();
    // Account & Access is first, so it is selected on open and has no links.
    await waitFor(() => expect(screen.getByTestId('cgm-explainer'))
      .toHaveTextContent('Anyone raising a ticket can pick Account & Access, whichever group the ticket is in.'));
  });

  test('a scoped category names the groups it is restricted to', async () => {
    await ready();
    fireEvent.click(await screen.findByText('Cloud & Servers'));
    await waitFor(() => expect(screen.getByTestId('cgm-explainer'))
      .toHaveTextContent('An agent will see Cloud & Servers in the category picker only when the ticket is in Servers.'));
  });

  test('two groups read as "X or Y", not a comma list', async () => {
    await ready();
    fireEvent.click(await screen.findByText('Cloud & Servers'));
    fireEvent.click(screen.getByLabelText('Azure & M365', { selector: 'input' }));
    await waitFor(() => expect(screen.getByTestId('cgm-explainer'))
      .toHaveTextContent('when the ticket is in Servers or Azure & M365.'));
  });
});

describe('scope badges in the left list', () => {
  test('a scoped category shows its count; an unscoped one shows the everywhere glyph', async () => {
    await ready();
    const list = screen.getByTestId('cgm-category-list');
    const cloud = within(list).getByText('Cloud & Servers').closest('button');
    expect(within(cloud).getByText('1')).toBeInTheDocument();

    const account = within(list).getByText('Account & Access').closest('button');
    expect(within(account).getByLabelText('Shows everywhere')).toBeInTheDocument();
  });
});

describe('editing', () => {
  test('ticking a group updates the count and reveals Save', async () => {
    await ready();
    expect(screen.queryByRole('button', { name: /Save mapping/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Cyber Security', { selector: 'input' }));

    const save = await screen.findByRole('button', { name: /Save mapping/ });
    fireEvent.click(save);
    await waitFor(() => expect(api.setCategoryGroupLinks).toHaveBeenCalledWith(
      // groupId is a STRING here — the section normalises with String(freshserviceId)
      // on load, and the save payload keeps that shape.
      expect.arrayContaining([{ categoryId: 1, groupId: '902' }]),
    ));
  });

  test('"Show everywhere" clears only the selected category', async () => {
    await ready();
    fireEvent.click(await screen.findByText('Cloud & Servers'));
    fireEvent.click(screen.getByRole('button', { name: 'Show everywhere' }));

    await waitFor(() => expect(screen.getByTestId('cgm-explainer'))
      .toHaveTextContent('Anyone raising a ticket can pick Cloud & Servers'));
    await waitFor(() => expect(screen.getByTestId('cgm-summary')).toHaveTextContent('0 of 3'));
  });

  test('search narrows the picker and says so when nothing matches', async () => {
    await ready();
    const box = screen.getByLabelText(/Find a group to scope/);
    fireEvent.change(box, { target: { value: 'azure' } });
    await waitFor(() => {
      const picker = screen.getByTestId('cgm-group-picker');
      expect(within(picker).getByText('Azure & M365')).toBeInTheDocument();
      expect(within(picker).queryByText('Servers')).not.toBeInTheDocument();
    });

    fireEvent.change(box, { target: { value: 'zzz' } });
    await waitFor(() => expect(screen.getByTestId('cgm-group-picker')).toHaveTextContent('No group matches'));
  });
});

describe('edge cases', () => {
  test('renders nothing when the workspace has no FreshService groups', async () => {
    api.meta.mockResolvedValue({ data: { categoryTree: CATEGORIES, groups: [] } });
    const { container } = render(<CategoryGroupSection />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  test('groups without a freshserviceId are excluded', async () => {
    api.meta.mockResolvedValue({
      data: { categoryTree: CATEGORIES, groups: [...GROUPS, { id: 999, freshserviceId: null, name: 'Local only' }] },
    });
    await ready();
    expect(within(screen.getByTestId('cgm-group-picker')).queryByText('Local only')).not.toBeInTheDocument();
  });

  test('survives a workspace with groups but no categories', async () => {
    api.meta.mockResolvedValue({ data: { categoryTree: [], groups: GROUPS } });
    api.categoryGroupLinks.mockResolvedValue({ data: [] });
    render(<CategoryGroupSection />);
    expect(await screen.findByText(/no top-level categories yet/i)).toBeInTheDocument();
  });
});
