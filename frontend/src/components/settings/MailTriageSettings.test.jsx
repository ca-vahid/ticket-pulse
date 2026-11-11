/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Settings → Ticket Mailboxes → Mail triage: mode pick-list, guidance, monthly limit, 30-day agreement.
const api = vi.hoisted(() => ({ getMailTriageSettings: vi.fn(), saveMailTriageSettings: vi.fn() }));
vi.mock('../../services/api', () => ({ ticketsAPI: api }));

const { default: MailTriageSettings, GUIDANCE_MAX } = await import('./MailTriageSettings');

const SETTINGS = { mode: 'shadow', guidance: 'Remittance advice notices need no ticket.', monthlyCapUsd: 20, stats: { last30: { judged: 140, sureAccepted: 61, sureChanged: 5, agreementPct: 92 } } };
beforeEach(() => {
  api.getMailTriageSettings.mockResolvedValue({ success: true, data: { ...SETTINGS } });
  api.saveMailTriageSettings.mockImplementation((body) => Promise.resolve({ success: true, data: { ...SETTINGS, ...body } }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const mount = () => render(<MemoryRouter><MailTriageSettings /></MemoryRouter>);

describe('MailTriageSettings', () => {
  test('shows the saved mode with one plain sentence, the guidance, the limit and the agreement', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Mail triage (AI review of held e-mail)' })).toBeInTheDocument();
    const mode = screen.getByLabelText('Mode');
    expect(mode).toHaveValue('shadow');
    expect([...mode.options].map((o) => o.textContent)).toEqual(['Off', 'Shadow', 'On']);
    expect(screen.getByTestId('mail-triage-mode-help')).toHaveTextContent('Nothing is applied');
    expect(screen.getByLabelText('Guidance for this workspace')).toHaveValue(SETTINGS.guidance);
    expect(screen.getByLabelText('Guidance for this workspace')).toHaveAttribute('maxlength', '2000');
    expect(screen.getByLabelText('Monthly AI limit')).toHaveValue(20);
    expect(screen.getByTestId('mail-triage-agreement')).toHaveTextContent('People kept 92% of sure suggestions, 61 of 66. 140 e-mails judged.');
    expect(screen.getByTestId('mail-triage-save')).toBeDisabled();
  });

  test('On says exactly what is applied automatically', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Mode'), { target: { value: 'on' } });
    expect(screen.getByTestId('mail-triage-mode-help')).toHaveTextContent('Only suggestions the AI is sure about, and only adding to a ticket or making a new one. It never discards mail.');
    expect(api.saveMailTriageSettings).not.toHaveBeenCalled(); // nothing is saved until Save
  });

  test('Save sends mode, guidance and the limit', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Mode'), { target: { value: 'on' } });
    fireEvent.change(screen.getByLabelText('Guidance for this workspace'), { target: { value: 'Mail from the bank is always a new ticket.' } });
    fireEvent.change(screen.getByLabelText('Monthly AI limit'), { target: { value: '35' } });
    fireEvent.click(screen.getByTestId('mail-triage-save'));
    await waitFor(() => expect(api.saveMailTriageSettings).toHaveBeenCalledWith({ mode: 'on', guidance: 'Mail from the bank is always a new ticket.', monthlyCapUsd: 35 }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByTestId('mail-triage-save')).toBeDisabled();
  });

  test('guidance stops at 2,000 characters and a failed save says why', async () => {
    api.saveMailTriageSettings.mockRejectedValueOnce(new Error('Only workspace admins can change this.'));
    mount();
    const box = await screen.findByLabelText('Guidance for this workspace');
    fireEvent.change(box, { target: { value: 'x'.repeat(GUIDANCE_MAX + 50) } });
    expect(box.value).toHaveLength(GUIDANCE_MAX);
    expect(screen.getByText('2,000 of 2,000 characters')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mail-triage-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only workspace admins can change this.');
  });

  test('renders nothing when the server has no such setting', async () => {
    api.getMailTriageSettings.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    const { container } = mount();
    await waitFor(() => expect(api.getMailTriageSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
