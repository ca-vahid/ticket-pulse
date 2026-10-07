import { describe, expect, test } from 'vitest';
import { briefDescription, groupApprovals, splitImageRefs } from './approvalBrief';

// Option A approval rows (7 Oct 2026): the request and ticket summary as readable text.
describe('approval brief text', () => {
  test('image markers become a picture list, not text', () => {
    expect(splitImageRefs('Price is $1059 instead of $916 [Image: pasted-image-1.png]')).toEqual({
      text: 'Price is $1059 instead of $916',
      names: ['pasted-image-1.png'],
    });
    expect(splitImageRefs('')).toEqual({ text: '', names: [] });
  });

  test('the description loses the pasted-source footer and stacked blank lines', () => {
    const ticket = { descriptionText: 'Request: a work phone.\n\n \n\n Next step: order it\n\n — Source material (pasted) — \n [Image: screenshot-1.png]' };
    expect(briefDescription(ticket)).toBe('Request: a work phone.\n\nNext step: order it');
    expect(briefDescription(null)).toBe('');
  });
});

// Vahid, 7 Oct 2026: one request to several approvers is one row, and a
// "Superseded" cancellation disappears once a sibling decided.
describe('groupApprovals', () => {
  const base = { ticketId: 9, categoryName: 'New Computer Upgrade', requestedBy: 'agrynik@x', requestNote: 'She works with…' };
  test('two pending approvers on one request are one group led by a pending row', () => {
    const g = groupApprovals([
      { ...base, id: 1, requestGroupId: 'g1', status: 'pending', approverEmail: 'rzaim@x', createdAt: '2026-10-07T19:43:00Z' },
      { ...base, id: 2, requestGroupId: 'g1', status: 'pending', approverEmail: 'vhaeri@x', createdAt: '2026-10-07T19:43:00Z' },
      { ...base, id: 3, ticketId: 10, requestGroupId: 'g2', status: 'pending', approverEmail: 'vhaeri@x', createdAt: '2026-10-07T18:00:00Z' },
    ]);
    expect(g).toHaveLength(2);
    expect(g[0].members.map((m) => m.id)).toEqual([1, 2]);
  });

  test('an approval and its superseded sibling become one approved row', () => {
    const g = groupApprovals([
      { ...base, id: 5, requestGroupId: 'g5', status: 'approved', approverEmail: 'rzaim@x', decidedAt: '2026-10-07T20:48:00Z' },
      { ...base, id: 6, requestGroupId: 'g5', status: 'cancelled', approverEmail: 'vhaeri@x', decisionNote: 'Superseded — approved by Reza Zaim' },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].primary.id).toBe(5);
    expect(g[0].members.map((m) => m.id)).toEqual([5]);
  });

  test('older rows without a group id still group by ticket, category, asker and note; a lone cancellation stays', () => {
    const g = groupApprovals([
      { ...base, id: 7, status: 'pending', approverEmail: 'a@x' },
      { ...base, id: 8, status: 'pending', approverEmail: 'b@x' },
      { ...base, id: 9, ticketId: 11, status: 'cancelled', approverEmail: 'c@x' },
    ]);
    expect(g.map((x) => x.members.length)).toEqual([2, 1]);
  });
});
