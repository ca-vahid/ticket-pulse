/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// Inline answers (20 Nov 2026): the requester typed answers under the agent's
// questions inside the quote. The pairs show under the reply's own text, and
// the whole mail opens from the entry's "…" menu.

const { entryOriginal } = vi.hoisted(() => ({ entryOriginal: vi.fn() }));
const pending = () => new Promise(() => {});
vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_, key) => (key === 'entryOriginal' ? entryOriginal : pending) }),
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

// The TP-12900-like reply (invented names): only the top line was kept as the body.
const INLINE_ANSWERS_ENTRY = {
  id: 4200,
  eventType: 'reply',
  source: 'email_inbound',
  actorName: 'Priya Nair',
  actorEmail: 'priya.nair@example.com',
  authorType: 'requester',
  incoming: true,
  isPrivate: false,
  bodyHtml: '<div>Thank you so much Dana. Please see below <span style="background-color:rgb(255,255,0)">highlight</span>.</div><div><br></div><div>Priya</div>',
  bodyText: 'Thank you so much Dana. Please see below highlight.',
  occurredAt: '2026-11-20T23:20:00.000Z',
  rawPayload: {
    hasOriginalEmail: true,
    inlineAnswers: [
      { context: 'Is it OK if we remove the partial copy in the portal and start fresh?', answer: 'OK to proceed.', highlighted: true },
      { context: 'Should all three folders go to the client, or only some?', answer: 'All three', highlighted: true },
      { context: '…Should the client see those, or should we publish a version without them?', answer: 'Only the query page, so they can filter however they want and grab files easily.', highlighted: true },
    ],
  },
};

const renderEntry = (entry) => render(<ul><ThreadEntry entry={entry} ticketId={12900} /></ul>);

describe('ThreadEntry — answered inline', () => {
  afterEach(() => { cleanup(); entryOriginal.mockReset(); });

  test('the pairs show under the reply: label, each context line in semibold, the answer beneath', () => {
    renderEntry(INLINE_ANSWERS_ENTRY);
    const section = screen.getByTestId('inline-answers');
    expect(within(section).getByText('Answered inline')).toHaveClass('tp-well-muted');
    const terms = within(section).getAllByRole('term');
    expect(terms.map((t) => t.textContent)).toEqual(INLINE_ANSWERS_ENTRY.rawPayload.inlineAnswers.map((p) => p.context));
    expect(terms[0]).toHaveClass('font-semibold', 'tp-well-text');
    expect(within(section).getAllByRole('definition').map((d) => d.textContent)).toEqual(['OK to proceed.', 'All three', 'Only the query page, so they can filter however they want and grab files easily.']);
    // The reply's own text is still the body.
    expect(screen.getByText(/Thank you so much Dana/)).toBeInTheDocument();
  });

  test('the pairs sit INSIDE the reply\'s e-mail well, directly under its text (dark-mode paper too)', () => {
    document.documentElement.classList.add('dark');
    try {
      renderEntry(INLINE_ANSWERS_ENTRY);
      const section = screen.getByTestId('inline-answers');
      const well = section.closest('.tp-rich-body');
      expect(well).not.toBeNull();
      // The highlighted reply puts the body on the paper panel; the pairs share it.
      expect(well).toHaveClass('tp-rich-body--paper');
      expect(within(well).getByText(/Thank you so much Dana/)).toBeInTheDocument();
      expect(section.previousElementSibling).toHaveClass('tp-rich-body__html');
      expect(document.querySelectorAll('.tp-rich-body')).toHaveLength(1);
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  test('the "…" button is labelled and reachable by keyboard, and shows on focus as well as hover', () => {
    renderEntry(INLINE_ANSWERS_ENTRY);
    const button = screen.getByRole('button', { name: 'More actions for this message' });
    expect(button).toHaveAttribute('aria-label', 'More actions for this message');
    expect(button.tagName).toBe('BUTTON');
    expect(button).not.toHaveAttribute('tabindex', '-1');
    expect(button).toBeEnabled();
    expect(button).toHaveClass('tp-focus-ring', 'opacity-0', 'group-hover:opacity-100', 'group-focus-within:opacity-100', 'focus-visible:opacity-100');
    button.focus();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'View the original e-mail' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  test('no answers: no section, and no "…" menu without a stored original', () => {
    renderEntry({ ...INLINE_ANSWERS_ENTRY, rawPayload: { cc_emails: [] } });
    expect(screen.queryByTestId('inline-answers')).not.toBeInTheDocument();
    expect(screen.queryByText('Answered inline')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entry-menu-button')).not.toBeInTheDocument();
  });

  test('unreliable comparison: no pairs, but the original is still one menu click away', () => {
    renderEntry({ ...INLINE_ANSWERS_ENTRY, rawPayload: { hasOriginalEmail: true } });
    expect(screen.queryByTestId('inline-answers')).not.toBeInTheDocument();
    expect(screen.getByTestId('entry-menu-button')).toBeInTheDocument();
  });

  test('"View the original e-mail" in the "…" menu opens the whole mail in a dialog', async () => {
    entryOriginal.mockResolvedValue({ data: { success: true, data: { entryId: 4200, html: '<p>Thank you so much Dana.</p><p><b>From:</b> Dana Fox</p><p>2. Should all three folders go? <span style="background:yellow">All three</span></p>', text: null, truncated: false } } });
    renderEntry(INLINE_ANSWERS_ENTRY);
    expect(screen.queryByTestId('original-email-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for this message' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'View the original e-mail' }));
    const dialog = await screen.findByRole('dialog', { name: 'The original e-mail' });
    expect(entryOriginal).toHaveBeenCalledWith(12900, 4200);
    expect(await within(dialog).findByText(/Should all three folders go\?/)).toBeInTheDocument();
    expect(dialog.querySelector('.tp-rich-body')).not.toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('an outgoing agent reply never shows the section', () => {
    renderEntry({ ...INLINE_ANSWERS_ENTRY, authorType: 'agent', incoming: false });
    expect(screen.queryByTestId('inline-answers')).not.toBeInTheDocument();
  });
});
