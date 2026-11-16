import { describe, expect, test } from '@jest/globals';
import { digestCard } from '../src/services/teamsCards.js';

// 16 Nov 2026 (Vahid, on a phone): the digest put subject, ref and due date in
// three columns, so a subject showed about a dozen letters. Each ticket is now
// a two-line block that uses the full width.
const rows = [
  { ref: 'TP-11092', subject: 'Customizing photos on BGC computer lock screens for the whole company', dueLabel: 'Aug 31, 11:59 PM', overdue: true, priority: 2, url: 'https://x/t/1' },
  { ref: 'TP-12200', subject: 'New Hire: Jane Doe', dueLabel: '', overdue: false, priority: 4, url: 'https://x/t/2' },
];
const card = digestCard({ name: 'Kim Lee', counts: { open: 37, overdue: 2, dueToday: 3 }, rows, queueUrl: 'https://x/q' });
const body = card.content ? card.content.body : card.body;
const flat = JSON.stringify(card);

describe('daily digest on a phone', () => {
  test('each ticket is one tappable block: the subject wraps (two lines), then priority, ref and due date', () => {
    const blocks = body.filter((b) => b.type === 'Container' && b.selectAction?.url?.startsWith('https://x/t/'));
    expect(blocks).toHaveLength(2);
    const [first] = blocks;
    expect(first.selectAction.url).toBe('https://x/t/1');
    expect(first.items[0]).toMatchObject({ type: 'TextBlock', wrap: true, maxLines: 2 });
    expect(first.items[0].text).toContain('Customizing photos on BGC computer lock screens');
    const meta = first.items[1].inlines.map((i) => i.text).join('');
    expect(meta).toContain('Medium · TP-11092');
    expect(meta).toContain('overdue · was due Aug 31, 11:59 PM');
    expect(blocks[1].items[1].inlines.map((i) => i.text).join('')).toContain('Urgent · TP-12200 · no due date');
    expect(body.some((b) => b.type === 'ColumnSet' && b.selectAction)).toBe(false);
  });

  test('the count labels may wrap instead of being cut', () => {
    expect(flat).toContain('"text":"OVERDUE"');
    const tiles = body.find((b) => b.type === 'Container' && b.showBorder && b.items?.[0]?.type === 'ColumnSet').items[0].columns;
    for (const c of tiles) expect(c.items[1].wrap).toBe(true);
  });
});
