/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { QUEUE_CARD_KEYS, QUEUE_CARD_REGISTRY, cardSearch, normalizeQueueCards } from './queueCards';
import { boardColumnScopes } from './boardColumns';

// QA 11-02 #1: a Closed card for workspaces that retired Resolved.
describe('Closed quick filter card', () => {
  test('is offered in the slot pickers and counts the closed key', () => {
    expect(QUEUE_CARD_KEYS).toContain('closed');
    expect(QUEUE_CARD_REGISTRY.closed).toMatchObject({ label: 'Closed', countKey: 'closed', windowed: true });
  });

  test('a configured row with Closed in it survives normalising', () => {
    const cards = ['all', 'open', 'unassigned', 'overdue', 'created_year', 'closed'];
    expect(normalizeQueueCards(cards)).toEqual(cards);
  });

  test('clicking it filters to the closed segment', () => {
    expect(cardSearch('?q=vpn&priority=3', 'closed').toString()).toBe('q=vpn&segment=closed');
  });

  test('on the board only the done column asks for tickets', () => {
    const statusDefs = [
      { name: 'Open', baseStatus: 'Open' }, { name: 'Pending', baseStatus: 'Pending' },
      { name: 'Resolved', baseStatus: 'Resolved' }, { name: 'Closed', baseStatus: 'Closed' },
    ];
    const scopes = boardColumnScopes({ statusDefs, segment: 'closed' });
    expect(scopes.map((s) => [s.key, s.inScope])).toEqual([['open', false], ['pending', false], ['closed', true]]);
  });
});
