/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail from './TicketFilterRail';

afterEach(cleanup);

const META = { workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: {} };

// 16 Oct 2026 (Vahid): the filter rail got long; "Find a filter" narrows it to
// the sections whose name matches, like FreshService's "Search fields".
describe('TicketFilterRail — Find a filter', () => {
  test('typing keeps only matching sections; Escape brings them all back', () => {
    render(<MemoryRouter initialEntries={['/tickets']}><TicketFilterRail meta={META} docked /></MemoryRouter>);
    const rail = screen.getByRole('complementary', { name: 'Ticket filters' });
    expect(within(rail).getByText('Views')).toBeInTheDocument();
    expect(within(rail).getByText('Priority')).toBeInTheDocument();

    const box = within(rail).getByTestId('rail-find');
    fireEvent.change(box, { target: { value: 'PRI' } });
    expect(within(rail).getByText('Priority')).toBeInTheDocument();
    expect(within(rail).queryByText('Views')).not.toBeInTheDocument();
    expect(within(rail).queryByText('Status')).not.toBeInTheDocument();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).toHaveValue('');
    expect(within(rail).getByText('Views')).toBeInTheDocument();
  });

  // 5 Nov 2026 (QA): the words inside a section count too.
  const META_FULL = {
    workspaceId: 1,
    actor: { technicianId: 7 },
    technicians: [{ id: 7, name: 'Alex Rivera' }, { id: 8, name: 'Sam Ortiz' }],
    groups: [{ id: 1, freshserviceId: 101, name: 'Service Desk' }],
    categoryTree: [
      { id: 1, name: 'Hardware', subcategories: [{ id: 11, name: 'Laptops' }, { id: 12, name: 'Monitors' }] },
      { id: 2, name: 'Software', subcategories: [{ id: 21, name: 'Licensing' }] },
    ],
    sources: [],
  };
  const mountRail = () => {
    render(<MemoryRouter initialEntries={['/tickets']}><TicketFilterRail meta={META_FULL} docked /></MemoryRouter>);
    const rail = screen.getByRole('complementary', { name: 'Ticket filters' });
    return { rail, box: within(rail).getByTestId('rail-find') };
  };
  const sectionToggle = (rail, title) => within(rail).getByText(title, { selector: 'span' }).closest('button');

  test('"overdue" opens Due and shows only Overdue, in bold; the rest is one click away', () => {
    const { rail, box } = mountRail();
    expect(sectionToggle(rail, 'Due')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(box, { target: { value: 'Overdue' } });
    expect(sectionToggle(rail, 'Due')).toHaveAttribute('aria-expanded', 'true');
    const overdue = within(rail).getByRole('checkbox', { name: 'Overdue' });
    expect(overdue).toBeInTheDocument();
    expect(within(rail).getByTestId('find-hit')).toHaveTextContent('Overdue');
    expect(within(rail).queryByRole('checkbox', { name: 'Due today' })).not.toBeInTheDocument();
    // Sections without the word hide.
    expect(within(rail).queryByText('Priority')).not.toBeInTheDocument();
    expect(within(rail).queryByText('Views')).not.toBeInTheDocument();
    fireEvent.click(within(rail).getByRole('button', { name: /Show all in Due · 3 more/ }));
    expect(within(rail).getByRole('checkbox', { name: 'Due today' })).toBeInTheDocument();
    expect(within(rail).getByRole('checkbox', { name: 'No due date' })).toBeInTheDocument();
  });

  test('"high" finds the Priority option and nothing else in Priority', () => {
    const { rail, box } = mountRail();
    fireEvent.change(box, { target: { value: 'high' } });
    expect(within(rail).getByRole('checkbox', { name: /^High/ })).toBeInTheDocument();
    expect(within(rail).queryByRole('checkbox', { name: /^Medium/ })).not.toBeInTheDocument();
    expect(within(rail).queryByRole('checkbox', { name: /^Urgent/ })).not.toBeInTheDocument();
  });

  test('"noise" finds the Noise & spam view', () => {
    const { rail, box } = mountRail();
    fireEvent.change(box, { target: { value: 'noise' } });
    expect(within(rail).getByText('Views')).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: /Noise & spam/ })).toBeInTheDocument();
    expect(within(rail).queryByRole('button', { name: /Unassigned/ })).not.toBeInTheDocument();
    expect(within(rail).queryByText(/Save current filters/)).not.toBeInTheDocument();
  });

  test('a subcategory name opens Category with its own search seeded; a member name seeds Members', () => {
    const { rail, box } = mountRail();
    fireEvent.change(box, { target: { value: 'laptop' } });
    expect(sectionToggle(rail, 'Category')).toHaveAttribute('aria-expanded', 'true');
    expect(within(rail).getByLabelText('Search categories')).toHaveValue('laptop');
    expect(within(rail).getByRole('checkbox', { name: 'Laptops' })).toBeInTheDocument();
    expect(within(rail).queryByRole('checkbox', { name: /Software/ })).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'ortiz' } });
    expect(within(rail).getByLabelText('Search members')).toHaveValue('ortiz');
    expect(within(rail).getByRole('checkbox', { name: /Sam Ortiz/ })).toBeInTheDocument();
    expect(within(rail).queryByRole('checkbox', { name: /Alex Rivera/ })).not.toBeInTheDocument();
  });

  test('no match anywhere: one quiet line', () => {
    const { rail, box } = mountRail();
    fireEvent.change(box, { target: { value: 'zebra' } });
    expect(within(rail).getByTestId('rail-find-none')).toHaveTextContent('No filter matches “zebra”.');
  });

  test('clearing the box (Escape) restores every section and its open/closed state', () => {
    const { rail, box } = mountRail();
    expect(sectionToggle(rail, 'Due')).toHaveAttribute('aria-expanded', 'false');
    expect(sectionToggle(rail, 'Category')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(box, { target: { value: 'overdue' } });
    fireEvent.change(box, { target: { value: 'laptop' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).toHaveValue('');
    expect(within(rail).getByText('Views')).toBeInTheDocument();
    expect(within(rail).queryByTestId('rail-find-none')).not.toBeInTheDocument();
    expect(sectionToggle(rail, 'Due')).toHaveAttribute('aria-expanded', 'false');
    expect(sectionToggle(rail, 'Category')).toHaveAttribute('aria-expanded', 'false');
    expect(sectionToggle(rail, 'Priority')).toHaveAttribute('aria-expanded', 'true');
    // Every option is back, and the seeded box is empty again.
    expect(within(rail).getByRole('checkbox', { name: /^Medium/ })).toBeInTheDocument();
    expect(within(rail).getByLabelText('Search members')).toHaveValue('');
    expect(within(rail).getByRole('checkbox', { name: /Alex Rivera/ })).toBeInTheDocument();
    fireEvent.click(sectionToggle(rail, 'Category'));
    expect(within(rail).getByLabelText('Search categories')).toHaveValue('');
  });

  test('docked: the rail fills its pane instead of sticking to the page', () => {
    const { rerender } = render(<MemoryRouter><TicketFilterRail meta={META} docked /></MemoryRouter>);
    const rail = () => screen.getByRole('complementary', { name: 'Ticket filters' });
    expect(rail().className).toContain('h-full');
    // The slim layer (absolute) needs a containing block, or a collapsed rail's
    // expand button floats to the top of the page (4.2.78 regression).
    expect(rail().className).toContain('relative');
    expect(rail().className).not.toContain('sticky');
    rerender(<MemoryRouter><TicketFilterRail meta={META} /></MemoryRouter>);
    // Page-scroll mode docks UNDER the app header (it used to slide beneath it).
    expect(rail().className).toContain('sticky');
    expect(rail().className).toContain('--tp-app-header-h');
  });
});
