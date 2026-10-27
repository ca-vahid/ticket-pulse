/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import EscalationPeople from './EscalationPeople';

const channel = (key, overrides = {}) => ({
  channel: key, enabled: false, configured: true, ready: false, pausedByWorkspace: false,
  warnings: ['not_enabled_by_user'], ...overrides,
});

const READY_EMAIL = channel('email', { enabled: true, ready: true, warnings: [] });

const PEOPLE = [
  {
    id: 1, name: 'Rita Requester', email: 'rita@x.io', membership: 'agent', hasPreferences: true,
    channels: {
      email: READY_EMAIL,
      sms: channel('sms', { enabled: true, ready: true, warnings: [] }),
      whatsapp: channel('whatsapp'),
      phone_call: channel('phone_call'),
    },
  },
  {
    id: 2, name: 'Olga Offline', email: 'olga@x.io', membership: 'agent', hasPreferences: false,
    channels: { email: channel('email'), sms: channel('sms'), whatsapp: channel('whatsapp'), phone_call: channel('phone_call') },
  },
  {
    id: 3, name: 'Nico Number', email: 'nico@x.io', membership: 'member', hasPreferences: true,
    channels: {
      email: channel('email'),
      sms: channel('sms', { enabled: true, warnings: ['missing_phone', 'phone_not_verified'] }),
      whatsapp: channel('whatsapp'),
      phone_call: channel('phone_call'),
    },
  },
  {
    id: 4, name: 'Avery Away', email: 'avery@x.io', membership: 'outside', hasPreferences: true,
    channels: { email: READY_EMAIL, sms: channel('sms'), whatsapp: channel('whatsapp'), phone_call: channel('phone_call') },
  },
];

const selected = (base = [], self = [], supervisor = []) => ({ base: new Set(base), self: new Set(self), supervisor: new Set(supervisor) });

afterEach(cleanup);

describe('EscalationPeople (QA 10-26 #4)', () => {
  test('picked people first, then reachable, then the rest; each says how or why not', () => {
    render(<EscalationPeople candidates={PEOPLE} selected={selected([4])} onToggle={vi.fn()} />);
    const rows = screen.getAllByTestId('escalation-person');
    expect(rows.map((row) => row.querySelector('.font-medium').textContent)).toEqual([
      'Avery Away', 'Rita Requester', 'Nico Number', 'Olga Offline',
    ]);
    expect(rows[0]).toHaveTextContent('No longer in this workspace');
    expect(rows[1]).toHaveTextContent('E-mail');
    expect(rows[1]).toHaveTextContent('Text');
    expect(rows[2]).toHaveTextContent('No mobile number. They add one in Mail & alerts.');
    expect(rows[2]).toHaveTextContent('App member, not an agent');
    expect(rows[3]).toHaveTextContent("Can't be reached");
    expect(rows[3]).toHaveTextContent('Has not turned on any alerts');
    expect(screen.queryByText(/No ready channel/)).not.toBeInTheDocument();
  });

  test('every channel has a plain-word status for screen readers', () => {
    render(<EscalationPeople candidates={PEOPLE} selected={selected()} onToggle={vi.fn()} />);
    expect(screen.getByText('E-mail: turned off in their Mail & alerts. Text: no mobile number. WhatsApp: turned off in their Mail & alerts. Phone call: turned off in their Mail & alerts')).toBeInTheDocument();
  });

  test('tick boxes toggle the three lists; filter and search narrow the rows', () => {
    const onToggle = vi.fn();
    render(<EscalationPeople candidates={PEOPLE} selected={selected([1], [], [1])} onToggle={onToggle} />);
    expect(screen.getByRole('checkbox', { name: 'Rita Requester: On the roster' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Rita Requester: Supervisor' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Olga Offline: Extra' }));
    expect(onToggle).toHaveBeenCalledWith('selfExtraRecipientIds', 2);

    fireEvent.click(screen.getByRole('button', { name: /Can't be reached 2/ }));
    expect(screen.getAllByTestId('escalation-person')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Everyone 4/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a person' }), { target: { value: 'nico' } });
    expect(screen.getAllByTestId('escalation-person')).toHaveLength(1);
  });
});
