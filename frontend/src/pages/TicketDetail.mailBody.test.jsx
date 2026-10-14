/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// QA 10-13 #2 to #4 on the conversation entry itself (TP-1886).

const attachmentObjectUrl = vi.fn((ticketId, id) => Promise.resolve({ url: `blob:t${ticketId}-a${id}`, type: 'image/png' }));
const pending = () => new Promise(() => {});
vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, key) => (key === 'attachmentObjectUrl' ? attachmentObjectUrl : pending) }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../hooks/useTicketPresence', () => ({ useTicketPresence: () => ({ viewers: [], onPresence: vi.fn() }) }));
vi.mock('../hooks/useTicketTypes', () => ({ useTicketTypes: () => ({ activeTypes: [], types: [], typeByName: () => null }) }));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [] }),
}));
vi.mock('../components/AppHeader', () => ({ default: () => null }));

import { ThreadEntry } from './TicketDetail';

afterEach(cleanup);

const base = {
  id: 3731358,
  source: 'email_inbound',
  actorName: 'Susan Xu',
  actorEmail: 'sxu@example.com',
  authorType: 'requester',
  incoming: true,
  isPrivate: false,
  occurredAt: '2026-10-13T15:56:04.000Z',
  rawPayload: { to_emails: ['it@example.com'], cc_emails: [] },
};

describe('the opening e-mail entry', () => {
  const preview = 'Susan Xu, B.A.Sc. (she/her)\r\n\r\nIT Coordinator\r\n\r\nWe respectfully acknowledge that our Vancouver office is';
  const description = '<div><p><em>[Image: picture-1-9jDAAA-image.png]</em></p></div><p><b>Susan Xu, </b>B.A.Sc.</p>'
    + '<p><i>We respectfully acknowledge that our Vancouver office is located on the traditional, ancestral, and unceded territories of the xʷməθkʷəy̓əm (Musqueam) Nation.</i></p>';
  const screenshot = { id: 70934, threadEntryId: null, fileName: 'picture-1-9jDAAA-image.png', contentType: 'image/png', sizeBytes: 2941575 };

  test('an older entry (preview only) is shown whole and formatted, with the pasted picture in place', async () => {
    const onImageRef = vi.fn();
    render(
      <ul>
        <ThreadEntry
          entry={{ ...base, eventType: 'original_email', bodyHtml: null, bodyText: preview }}
          ticketId={62969}
          openingHtml={description}
          openingImages={[screenshot]}
          onImageRef={onImageRef}
        />
      </ul>,
    );
    expect(screen.getByText(/xʷməθkʷəy̓əm \(Musqueam\) Nation\./)).toBeInTheDocument();
    expect(screen.getByText('Susan Xu,').tagName).toBe('B');
    const img = await screen.findByAltText('picture-1-9jDAAA-image.png');
    expect(img).toHaveAttribute('src', 'blob:t62969-a70934');
    fireEvent.click(img);
    expect(onImageRef).toHaveBeenCalledWith('picture-1-9jDAAA-image.png');
  });

  test('a picture shown inside a reply is not repeated in the strip under it; other pictures still are', async () => {
    const inBody = { id: 1, threadEntryId: 5, fileName: 'pasted-image-1.png', contentType: 'image/png' };
    const extra = { id: 2, threadEntryId: 5, fileName: 'photo.jpg', contentType: 'image/jpeg' };
    render(
      <ul>
        <ThreadEntry
          entry={{ ...base, id: 5, eventType: 'reply', bodyHtml: '<p>Here it is <i>[Image:&nbsp;pasted-image-1.png]</i></p>', bodyText: 'Here it is [Image: pasted-image-1.png]' }}
          attachments={[inBody, extra]}
          ticketId={62969}
        />
      </ul>,
    );
    expect(await screen.findByAltText('pasted-image-1.png')).toHaveClass('tp-inline-img');
    const strip = screen.getByLabelText('Pictures in this message');
    expect(strip.querySelectorAll('button')).toHaveLength(1);
    expect(strip.querySelector('button')).toHaveAttribute('title', 'Preview photo.jpg');
  });
});

describe('an agent reply', () => {
  const reply = {
    ...base,
    id: 3731438,
    source: 'ticketpulse_user',
    eventType: 'reply',
    authorType: 'agent',
    incoming: false,
    bodyHtml: null,
    bodyText: 'Hi Susan,\n\nTesting agent reply to requester.\n\nKind regards,',
  };

  test('shows the signature that was mailed with it, under the message', () => {
    render(
      <ul>
        <ThreadEntry entry={{ ...reply, rawPayload: { to_emails: ['sxu@example.com'], sentSignature: { html: '<p style="margin: 0"><b>Susan Xu, </b>B.A.Sc.</p><p style="margin: 0">IT Coordinator</p>', text: 'Susan Xu, B.A.Sc.\nIT Coordinator' } } }} />
      </ul>,
    );
    expect(screen.getByText(/Kind regards,/)).toBeInTheDocument();
    expect(screen.getByTestId('sent-signature')).toHaveTextContent('IT Coordinator');
  });

  test('a reply sent before this release has no stored signature and looks as it did', () => {
    render(<ul><ThreadEntry entry={{ ...reply, rawPayload: { to_emails: ['sxu@example.com'] } }} /></ul>);
    expect(screen.getByText(/Kind regards,/)).toBeInTheDocument();
    expect(screen.queryByTestId('sent-signature')).toBeNull();
  });
});
