// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import AttachmentPreviewModal, { wheelZoomDelta } from './AttachmentPreviewModal';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    attachmentObjectUrl: vi.fn(() => Promise.resolve({ url: 'blob:picture' })),
    downloadAttachment: vi.fn(),
  },
}));

const picture = { id: 7, fileName: 'pasted-image-1.png', contentType: 'image/png', sizeBytes: 151000 };

/** 21 Oct 2026: the wheel zooms the picture and never scrolls the ticket; the preview can be maximized. */
describe('AttachmentPreviewModal wheel and maximize', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  const open = async () => {
    render(<AttachmentPreviewModal ticketId={1} attachment={picture} onClose={() => {}} />);
    await screen.findByRole('img', { name: picture.fileName });
    await act(async () => {}); // let the wheel listener re-attach for the loaded picture
  };

  const wheel = (target, deltaY) => {
    const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(e); });
    return e;
  };

  test('a wheel over the picture zooms it and cancels the page scroll', async () => {
    await open();
    const e = wheel(screen.getByRole('img', { name: picture.fileName }), -100);
    expect(e.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('135%');
  });

  test('a wheel over the header or the backdrop does not scroll the page either', async () => {
    await open();
    const e = wheel(screen.getByRole('button', { name: 'Download' }), 100);
    expect(e.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%');
  });

  test('a trackpad nudge zooms a little, a mouse notch one step', () => {
    expect(wheelZoomDelta({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(0.35);
    expect(wheelZoomDelta({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(0.35);
    expect(wheelZoomDelta({ deltaY: -4, deltaMode: 0 })).toBeCloseTo(0.014);
    expect(wheelZoomDelta({ deltaY: 500, deltaMode: 0 })).toBeCloseTo(-0.35);
  });

  test('Maximize fills the window, F toggles it, and the choice is remembered', async () => {
    await open();
    const card = screen.getByTestId('attachment-preview-card');
    expect(card.className).not.toMatch(/\bh-full w-full\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    expect(card.className).toMatch(/\bh-full w-full\b/);
    expect(localStorage.getItem('tp.attachmentPreview.full')).toBe('1');
    fireEvent.keyDown(document, { key: 'f' });
    expect(screen.getByRole('button', { name: 'Maximize' })).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('tp.attachmentPreview.full')).toBe('0');
  });
});
