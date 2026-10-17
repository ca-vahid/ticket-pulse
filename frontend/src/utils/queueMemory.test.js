/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from 'vitest';
import { queueSearchToKeep, recallQueueScroll, recallQueueView, rememberQueueScroll, rememberQueueView } from './queueMemory';

afterEach(() => localStorage.clear());

describe('queue scroll memory (QA 10-16 #9)', () => {
  afterEach(() => sessionStorage.clear());

  test('gives the offset back only for the same view (the preview is ignored)', () => {
    rememberQueueScroll(1, '?status=Open&peek=5', 840.4);
    expect(recallQueueScroll(1, '?status=Open')).toBe(840);
    expect(recallQueueScroll(1, '?status=Pending')).toBe(0);
    expect(recallQueueScroll(2, '?status=Open')).toBe(0);
  });

  test('never throws on garbage', () => {
    sessionStorage.setItem('tp_queue_scroll_ws1', '{not json');
    expect(recallQueueScroll(1, '')).toBe(0);
  });
});

describe('queue view memory (sticky Tickets filters, 14 Oct 2026)', () => {
  test('remembers the filters per workspace and gives them back', () => {
    rememberQueueView(1, '?status=Open&assignee=49&sort=updated');
    rememberQueueView(2, '?view=mine');
    expect(recallQueueView(1)).toBe('?status=Open&assignee=49&sort=updated');
    expect(recallQueueView(2)).toBe('?view=mine');
    expect(recallQueueView(3)).toBe('');
  });

  test('the side preview is not part of the view', () => {
    expect(queueSearchToKeep('?status=Open&peek=62973')).toBe('?status=Open');
    expect(queueSearchToKeep('?peek=62973')).toBe('');
    rememberQueueView(1, '?group=7&peek=62973');
    expect(recallQueueView(1)).toBe('?group=7');
  });

  test('"Clear all" is remembered as no filters', () => {
    rememberQueueView(1, '?status=Open');
    rememberQueueView(1, '');
    expect(recallQueueView(1)).toBe('');
  });

  test('a view older than a week is not restored', () => {
    rememberQueueView(1, '?status=Open');
    expect(recallQueueView(1, Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe('');
  });

  test('broken storage never throws', () => {
    localStorage.setItem('tp_queue_view_ws1', '{not json');
    expect(recallQueueView(1)).toBe('');
    expect(recallQueueView(null)).toBe('');
    expect(() => rememberQueueView(null, '?a=1')).not.toThrow();
  });
});
