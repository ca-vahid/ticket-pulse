/** Teams approval card (19 Oct 2026): a picture pasted into the request shows as a picture. */
import { approvalCard } from '../src/services/teamsCards.js';

const base = { approvalId: 1, ticketId: 2, workspaceId: 1, categoryName: 'New Computer Upgrade', ref: 'TP-10231', subject: 'New Device Request: Laptop', askedByName: 'Adrian Lo', decisionUrl: 'https://tp.example/approval/tok' };
const flatten = (items) => items.flatMap((i) => [i, ...flatten(i.items || [])]);

describe('approval card pictures', () => {
  test('a note that is only a picture shows the heading and the picture, which opens full size', () => {
    const card = approvalCard({ ...base, noteMd: '', noteImages: [{ name: 'pasted-image-1.png', url: 'https://api.example/api/ticket-approvals/public/tok/image/7' }] });
    const all = flatten(card.content?.body || card.body || []);
    const img = all.find((i) => i.type === 'Image');
    expect(img).toEqual(expect.objectContaining({ url: 'https://api.example/api/ticket-approvals/public/tok/image/7', altText: 'pasted-image-1.png' }));
    expect(img.selectAction).toEqual({ type: 'Action.OpenUrl', url: img.url });
    expect(all.some((i) => i.type === 'TextBlock' && i.text === 'WHY ADRIAN IS ASKING')).toBe(true);
    expect(JSON.stringify(card)).not.toContain('[Image:');
  });

  test('without pictures the note card is unchanged', () => {
    const card = approvalCard({ ...base, noteMd: 'Quote attached' });
    const all = flatten(card.content?.body || card.body || []);
    expect(all.some((i) => i.type === 'Image')).toBe(false);
    expect(all.some((i) => i.type === 'TextBlock' && i.text === 'Quote attached')).toBe(true);
  });
});
