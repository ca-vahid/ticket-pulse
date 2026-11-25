// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TicketAttachmentsTab from './TicketAttachmentsTab';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    attachmentObjectUrl: vi.fn(() => new Promise(() => {})),
    attachmentBytes: vi.fn(),
    uploadAttachments: vi.fn(),
    saveBlob: vi.fn(),
    removeAttachment: vi.fn(),
  },
}));

const at = '2026-11-25T17:49:00Z';
const MINE = { id: 1, fileName: 'teams-picture-1.png', contentType: 'image/png', sizeBytes: 111381, source: 'upload', uploadedBy: 'me@x.ca', createdAt: at };
const THEIRS = { id: 2, fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 2048, source: 'email', uploadedBy: null, createdAt: '2026-11-25T16:00:00Z' };
const canRemove = (a) => a.uploadedBy === 'me@x.ca';

const renderTab = (props = {}) => render(
  <TicketAttachmentsTab ticketId={42} attachments={[MINE, THEIRS]} ticketRef="TP-13939" subject="PDF comments" canRemove={canRemove} {...props} />,
);

beforeEach(() => {
  try { localStorage.setItem('tp_attach_view', 'grid'); } catch { /* jsdom */ }
  ticketsAPI.removeAttachment.mockReset();
});
afterEach(() => cleanup());

describe('Remove on the Attachments tab', () => {
  test('only files the person may remove get a Remove button', () => {
    renderTab();
    expect(screen.getByRole('button', { name: 'Remove teams-picture-1.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove invoice.pdf' })).not.toBeInTheDocument();
  });

  test('without canRemove nobody sees Remove', () => {
    renderTab({ canRemove: null });
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
  });

  test('asks in place first; Cancel keeps the file and calls nothing', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Remove teams-picture-1.png' }));
    const confirm = screen.getByTestId('attachment-remove-confirm');
    expect(confirm).toHaveTextContent('Remove it for good? It can’t be restored.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('attachment-remove-confirm')).not.toBeInTheDocument();
    expect(ticketsAPI.removeAttachment).not.toHaveBeenCalled();
    expect(screen.getByText('teams-picture-1.png')).toBeInTheDocument();
  });

  test('confirming removes it, takes it off the tab and tells the page', async () => {
    ticketsAPI.removeAttachment.mockResolvedValue({ data: { removed: true } });
    const onRemoved = vi.fn();
    renderTab({ onRemoved });
    fireEvent.click(screen.getByRole('button', { name: 'Remove teams-picture-1.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ id: 1 })));
    expect(ticketsAPI.removeAttachment).toHaveBeenCalledWith(42, 1);
    expect(screen.queryByText('teams-picture-1.png')).not.toBeInTheDocument();
    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
  });

  test('a refusal is said in words under the file, and the file stays', async () => {
    ticketsAPI.removeAttachment.mockRejectedValue({ response: { data: { message: 'Only the uploader or an admin can remove an attachment' } } });
    const onRemoved = vi.fn();
    renderTab({ onRemoved });
    fireEvent.click(screen.getByRole('button', { name: 'Remove teams-picture-1.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Could not remove it: Only the uploader or an admin can remove an attachment.')).toBeInTheDocument();
    expect(onRemoved).not.toHaveBeenCalled();
    expect(screen.getByText('teams-picture-1.png')).toBeInTheDocument();
  });

  test('the list view has Remove too', async () => {
    try { localStorage.setItem('tp_attach_view', 'list'); } catch { /* jsdom */ }
    ticketsAPI.removeAttachment.mockResolvedValue({ data: { removed: true } });
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Remove teams-picture-1.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('teams-picture-1.png')).not.toBeInTheDocument());
  });
});
