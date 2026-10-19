// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import TicketAttachmentsTab from './TicketAttachmentsTab';

vi.mock('../../services/api', () => ({ ticketsAPI: { attachmentObjectUrl: vi.fn(() => new Promise(() => {})) } }));

/** Signature logos (19 Oct 2026): not counted as files, still listed under the files. */
describe('TicketAttachmentsTab signature logos', () => {
  const logo = { id: 9, fileName: 'picture-1-9Z0AAA-image001.png', contentType: 'image/png', sizeBytes: 39593, source: 'email', recurring: true, createdAt: '2026-10-19T16:29:54Z' };
  const quote = { id: 10, fileName: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 2048, source: 'email', createdAt: '2026-10-19T16:29:54Z' };

  test('counts only real files and folds the logos into a note', () => {
    render(<TicketAttachmentsTab ticketId={1} attachments={[quote]} signatureImages={[logo]} />);
    expect(screen.getByRole('tab', { name: /All/ })).toHaveTextContent('1');
    expect(screen.getByText('quote.pdf')).toBeInTheDocument();
    const fold = screen.getByTestId('signature-images');
    expect(within(fold).getByText(/1 signature logo/)).toBeInTheDocument();
    expect(within(fold).getByText(logo.fileName)).toBeInTheDocument();
  });

  test('a ticket whose only picture is the logo says so', () => {
    render(<TicketAttachmentsTab ticketId={1} attachments={[]} signatureImages={[logo]} />);
    expect(screen.getByText('No attachments on this ticket, apart from signature logos.')).toBeInTheDocument();
  });
});
