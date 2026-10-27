/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('../../services/api', () => ({ ticketsAPI: {} }));
// Directory photos by e-mail: Phillip has one, Alexey does not.
vi.mock('../../hooks/useRequesterPhoto', () => ({
  useRequesterPhoto: (email) => (email === 'phillip@x.io' ? 'data:image/png;base64,PHILLIP' : null),
}));
afterEach(cleanup);
import ApprovalThread from './ApprovalThread';

// 27 Oct 2026 (Vahid): the conversation showed initials for everyone, even
// people with a directory photo.
describe('ApprovalThread — real faces', () => {
  test('a person with a directory photo shows it; one without keeps their initials', () => {
    const approval = { id: 161, createdAt: '2026-10-23T16:09:37Z', requestNote: 'Request for Claude AI', requestedBy: 'alexey@x.io', requestedByName: 'Alexey Lavrenyuk' };
    const answer = { id: 85, kind: 'answer', audience: 'requester', author: { email: 'phillip@x.io', name: 'Phillip Crispell', role: 'requester' }, bodyText: 'ChatGPT would be fine.', to: [], cc: [], createdAt: '2026-10-27T14:09:10Z' };
    const { container } = render(<ApprovalThread lookupPhotos approval={approval} messages={[answer]} />);
    const items = container.querySelectorAll('li[data-kind]');
    expect(items[0].querySelector('img')).toBeNull();
    expect(items[0]).toHaveTextContent('AL');
    expect(items[1].querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,PHILLIP');
  });

  test('a photo the caller already has wins, and nothing is looked up for it', () => {
    const approval = { id: 1, createdAt: '2026-10-23T16:09:37Z', requestNote: 'Hi', requestedBy: 'phillip@x.io', requestedByName: 'Phillip', requestedByPhotoUrl: 'https://x/own.png' };
    const { container } = render(<ApprovalThread lookupPhotos approval={approval} messages={[]} />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://x/own.png');
  });

  test('the public link pages never look photos up (no sign-in there)', () => {
    const approval = { id: 1, createdAt: '2026-10-23T16:09:37Z', requestNote: 'Hi', requestedBy: 'phillip@x.io', requestedByName: 'Phillip Crispell' };
    const { container } = render(<ApprovalThread approval={approval} messages={[]} />);
    expect(container.querySelector('img')).toBeNull();
  });
});
