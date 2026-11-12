/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 11-10 #2: On/Offboarding → People, sort by column and filter the loaded rows.
const { FAMILIES, families } = vi.hoisted(() => {
  const fam = (id, personName, kind, effectiveDate, office, assignees, progress, extra = {}) => ({
    id, personName, kind, effectiveDate, office, assignees, progress, status: 'open', linked: 0, afterTheFact: false, ...extra,
  });
  const SAM = { id: 1, name: 'Sam Okafor' };
  const ANA = { id: 2, name: 'Ana Souza' };
  const list = [
    fam(11, 'Priya Nair', 'onboarding', '2026-12-01', 'Vancouver', [SAM], { done: 1, total: 3 }),
    fam(12, 'Dana Whitfield', 'offboarding', null, 'Calgary', [], { done: 0, total: 2 }, { asleep: true }),
    fam(13, 'Lee Moreau', 'onboarding', '2026-11-20', 'Vancouver', [ANA], { done: 2, total: 2 }),
    fam(14, 'Zoë Adler', 'offboarding', '2027-01-05', 'Montréal', [SAM], { done: 0, total: 1 }),
  ];
  return { FAMILIES: list, families: { fn: null } };
});

vi.mock('../../services/api', () => ({
  hrLifecycleAPI: {
    families: (...args) => families.fn(...args),
    candidates: async () => ({ data: [] }),
    family: async () => ({ data: null }),
  },
  ticketsAPI: { requesterPhoto: async () => ({ data: { photo: null } }) },
}));

import PeoplePanel from './PeoplePanel';

beforeEach(() => {
  window.localStorage.clear();
  families.fn = vi.fn(async () => ({ data: FAMILIES }));
});
afterEach(() => { cleanup(); });

const renderPanel = () => render(<MemoryRouter><PeoplePanel mode="observe" /></MemoryRouter>);

/** The people in the table, top to bottom (each row's expand button carries the name). */
async function order() {
  const buttons = await screen.findAllByRole('button', { name: /^(Show|Hide) .+'s tickets$/ });
  return buttons.map((b) => b.getAttribute('aria-label').replace(/^(Show|Hide) /, '').replace(/'s tickets$/, ''));
}
const header = (name) => screen.getByRole('button', { name });
const columnHeader = (name) => header(name).closest('th');

describe('People table sorting (QA 11-10 #2)', () => {
  test('Person sorts A to Z, then Z to A, then back to the server order', async () => {
    renderPanel();
    expect(await order()).toEqual(['Priya Nair', 'Dana Whitfield', 'Lee Moreau', 'Zoë Adler']);
    expect(columnHeader('Person')).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(header('Person'));
    expect(await order()).toEqual(['Dana Whitfield', 'Lee Moreau', 'Priya Nair', 'Zoë Adler']);
    expect(columnHeader('Person')).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(header('Person'));
    expect(await order()).toEqual(['Zoë Adler', 'Priya Nair', 'Lee Moreau', 'Dana Whitfield']);
    expect(columnHeader('Person')).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(header('Person'));
    expect(await order()).toEqual(['Priya Nair', 'Dana Whitfield', 'Lee Moreau', 'Zoë Adler']);
    expect(columnHeader('Person')).toHaveAttribute('aria-sort', 'none');
  });

  test('Date sorts earliest first, then latest first; no date stays last both ways', async () => {
    renderPanel();
    await order();
    fireEvent.click(header('Date'));
    expect(await order()).toEqual(['Lee Moreau', 'Priya Nair', 'Zoë Adler', 'Dana Whitfield']);
    fireEvent.click(header('Date'));
    expect(await order()).toEqual(['Zoë Adler', 'Priya Nair', 'Lee Moreau', 'Dana Whitfield']);
  });

  test('With sorts by the first owner; no owner yet stays last; ties go by date', async () => {
    renderPanel();
    await order();
    fireEvent.click(header('With'));
    expect(await order()).toEqual(['Lee Moreau', 'Priya Nair', 'Zoë Adler', 'Dana Whitfield']);
    fireEvent.click(header('With'));
    expect(await order()).toEqual(['Priya Nair', 'Zoë Adler', 'Lee Moreau', 'Dana Whitfield']);
  });

  test('Children sorts least done first, then most done first', async () => {
    renderPanel();
    await order();
    fireEvent.click(header('Children'));
    // 0/2 and 0/1 tie: by date, and no date goes last.
    expect(await order()).toEqual(['Zoë Adler', 'Dana Whitfield', 'Priya Nair', 'Lee Moreau']);
    fireEvent.click(header('Children'));
    expect(await order()).toEqual(['Lee Moreau', 'Priya Nair', 'Zoë Adler', 'Dana Whitfield']);
  });

  test('the sort is remembered for the next visit', async () => {
    renderPanel();
    await order();
    fireEvent.click(header('Date'));
    cleanup();
    renderPanel();
    expect(await order()).toEqual(['Lee Moreau', 'Priya Nair', 'Zoë Adler', 'Dana Whitfield']);
    expect(columnHeader('Date')).toHaveAttribute('aria-sort', 'ascending');
  });
});

describe('People table filters (QA 11-10 #2)', () => {
  test('search matches a name or a location, ignoring case and accents', async () => {
    renderPanel();
    await order();
    const search = screen.getByRole('searchbox', { name: 'Search by person or location' });
    fireEvent.change(search, { target: { value: 'zoe' } });
    expect(await order()).toEqual(['Zoë Adler']);
    fireEvent.change(search, { target: { value: 'MONTREAL' } });
    expect(await order()).toEqual(['Zoë Adler']);
    fireEvent.change(search, { target: { value: 'vancouver' } });
    expect(await order()).toEqual(['Priya Nair', 'Lee Moreau']);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 2 of 4');
  });

  test('agent and location filters narrow the list; Clear brings everyone back', async () => {
    renderPanel();
    await order();
    const agent = screen.getByRole('combobox', { name: /Agent/ });
    expect(within(agent).getAllByRole('option').map((o) => o.textContent)).toEqual(['Anyone', 'Ana Souza', 'Sam Okafor', 'No owner yet']);

    fireEvent.change(agent, { target: { value: '1' } });
    expect(await order()).toEqual(['Priya Nair', 'Zoë Adler']);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 2 of 4');

    fireEvent.change(agent, { target: { value: '__none' } });
    expect(await order()).toEqual(['Dana Whitfield']);

    fireEvent.change(agent, { target: { value: '' } });
    const location = screen.getByRole('combobox', { name: /Location/ });
    expect(within(location).getAllByRole('option').map((o) => o.textContent)).toEqual(['Anywhere', 'Calgary', 'Montréal', 'Vancouver']);
    fireEvent.change(location, { target: { value: 'Vancouver' } });
    expect(await order()).toEqual(['Priya Nair', 'Lee Moreau']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await order()).toHaveLength(4);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('filters that match nothing show an empty line in the table', async () => {
    renderPanel();
    await order();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by person or location' }), { target: { value: 'nobody here' } });
    expect(await screen.findByText(/Nobody matches these filters/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /'s tickets$/ })).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 0 of 4');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await order()).toHaveLength(4);
  });

  test('a remembered agent who is no longer in the rows falls back to Anyone', async () => {
    window.localStorage.setItem('tp.onboarding.people.filters', JSON.stringify({ q: '', agent: '99', location: '' }));
    renderPanel();
    expect(await order()).toHaveLength(4);
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Agent/ })).toHaveValue(''));
  });

  test('sorting keeps an open row open', async () => {
    renderPanel();
    await order();
    fireEvent.click(screen.getByRole('button', { name: "Show Lee Moreau's tickets" }));
    fireEvent.click(header('Person'));
    expect(await order()).toEqual(['Dana Whitfield', 'Lee Moreau', 'Priya Nair', 'Zoë Adler']);
    expect(screen.getByRole('button', { name: "Hide Lee Moreau's tickets" })).toHaveAttribute('aria-expanded', 'true');
  });
});
