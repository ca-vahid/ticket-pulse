import { describe, expect, test } from 'vitest';
import { filterTickets, getTicketCategoryLabel } from './ticketFilter';

describe('ticketFilter category modes', () => {
  test('canonical filters match category and subcategory IDs', () => {
    const tickets = [
      { id: 1, categoryMode: 'canonical', categoryId: 10, subcategoryId: 101, categoryLabel: 'Security / Advisory' },
      { id: 2, categoryMode: 'canonical', categoryId: 10, subcategoryId: 102, categoryLabel: 'Security / Audit' },
      { id: 3, categoryMode: 'canonical', categoryId: 20, subcategoryId: 201, categoryLabel: 'Hardware / Laptop' },
    ];

    expect(filterTickets(tickets, '', { mode: 'canonical', categoryIds: [10], subcategoryIds: [] }).map((ticket) => ticket.id)).toEqual([1, 2]);
    expect(filterTickets(tickets, '', { mode: 'canonical', categoryIds: [10], subcategoryIds: [102] }).map((ticket) => ticket.id)).toEqual([2]);
  });

  test('canonical subcategory-only filters match exact subcategory IDs', () => {
    const tickets = [
      { id: 1, categoryMode: 'canonical', categoryId: 10, subcategoryId: 101, categoryLabel: 'Security / Advisory' },
      { id: 2, categoryMode: 'canonical', categoryId: 10, subcategoryId: 102, categoryLabel: 'Security / Audit' },
      { id: 3, categoryMode: 'canonical', categoryId: 20, subcategoryId: 102, categoryLabel: 'Hardware / Audit' },
      { id: 4, categoryMode: 'canonical', categoryId: 20, categoryLabel: 'Hardware' },
    ];

    expect(filterTickets(tickets, '', { mode: 'canonical', categoryIds: [], subcategoryIds: [102] }).map((ticket) => ticket.id)).toEqual([2, 3]);
    expect(filterTickets(tickets, '', { mode: 'canonical', categoryIds: [], subcategoryIds: [999] }).map((ticket) => ticket.id)).toEqual([]);
  });

  test('legacy filters keep using ticketCategory labels', () => {
    const tickets = [
      { id: 1, categoryMode: 'legacy', ticketCategory: 'BST', categoryLabel: 'Canonical should not win' },
      { id: 2, categoryMode: 'legacy', ticketCategory: 'GIS' },
    ];

    expect(getTicketCategoryLabel(tickets[0], 'legacy')).toBe('BST');
    expect(filterTickets(tickets, '', ['GIS'], { categoryMode: 'legacy' }).map((ticket) => ticket.id)).toEqual([2]);
  });
});
