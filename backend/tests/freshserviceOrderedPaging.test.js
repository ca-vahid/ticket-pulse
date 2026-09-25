import { jest } from '@jest/globals';

/**
 * History backfill (24 Sep 2026): the ticket list walks oldest-first and stops
 * once a page has passed the window, instead of listing every ticket updated
 * since the window's start (≈45,000 in IT for a 2023 window).
 */

jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: FreshServiceClient } = await import('../src/integrations/freshservice.js');

const page = (fromDay, n = 100) => Array.from({ length: n }, (_, i) => ({ id: fromDay * 1000 + i, updated_at: `2024-12-${String(fromDay).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z` }));

test('ordered walk stops at the first page that passes the window; params carry the order', async () => {
  const client = new FreshServiceClient('demo', 'key');
  const pages = [page(1), page(2), page(3), page(4)];
  const fetch = jest.spyOn(client, '_fetchWithRetry').mockImplementation(async (_endpoint, { params }) => ({ data: { tickets: pages[params.page - 1] || [] } }));
  const windowEnd = new Date('2024-12-02T23:59:59Z');

  const tickets = await client.fetchTickets({
    workspace_id: 2,
    updated_since: '2024-12-01T00:00:00Z',
    include: 'requester,stats',
    order_by: 'updated_at',
    order_type: 'asc',
    stopWhen: (t) => new Date(t.updated_at) > windowEnd,
  });

  expect(fetch).toHaveBeenCalledTimes(3); // page 3 passed Dec 2; page 4 never fetched
  expect(tickets).toHaveLength(300);
  expect(fetch.mock.calls[0][1].params).toEqual(expect.objectContaining({ order_by: 'updated_at', order_type: 'asc', workspace_id: 2, page: 1 }));
});

test('without stopWhen it still reads every page (the regular syncs are unchanged)', async () => {
  const client = new FreshServiceClient('demo', 'key');
  const pages = [page(1), page(2), page(3, 40)];
  const fetch = jest.spyOn(client, '_fetchWithRetry').mockImplementation(async (_endpoint, { params }) => ({ data: { tickets: pages[params.page - 1] || [] } }));
  const tickets = await client.fetchTickets({ updated_since: '2024-12-01T00:00:00Z' });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(tickets).toHaveLength(240);
  expect(fetch.mock.calls[0][1].params.order_by).toBeUndefined();
});
