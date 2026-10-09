/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TeamsMessageNodeEditor } from './NotificationWorkflowsPanel';

afterEach(() => cleanup());

// QA 10-08 #3: the Teams message step — who the bot tells and what it says.
test('roles, internal groups and typed addresses become the step data; FreshService groups are not offered', () => {
  const onChange = vi.fn();
  render(
    <TeamsMessageNodeEditor
      data={{ roles: ['ticket_group'], groups: [], people: [], bodyTemplate: '', includeTicketLink: true }}
      onChange={onChange}
      variables={[]}
      groups={[{ id: 3, name: 'Service Desk leads', origin: 'local' }, { id: 9, name: 'FS group', origin: 'freshservice' }]}
    />,
  );
  expect(screen.getByLabelText(/Members of the ticket/)).toBeChecked();
  expect(screen.queryByLabelText('FS group')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('The assigned agent'));
  expect(onChange).toHaveBeenLastCalledWith({ roles: ['ticket_group', 'assigned_agent'] });
  fireEvent.click(screen.getByLabelText('Service Desk leads'));
  expect(onChange).toHaveBeenLastCalledWith({ groups: [3] });
  fireEvent.change(screen.getByLabelText('People to tell'), { target: { value: 'Vahid@bgc.ca, not an address; alo@bgc.ca' } });
  expect(onChange).toHaveBeenLastCalledWith({ people: ['vahid@bgc.ca', 'alo@bgc.ca'] });
  fireEvent.change(screen.getByLabelText('Teams message'), { target: { value: 'Unassigned for 4 hours.' } });
  expect(onChange).toHaveBeenLastCalledWith({ bodyTemplate: 'Unassigned for 4 hours.' });
  expect(screen.getByLabelText('Teams message')).toHaveAttribute('spellcheck', 'true');
});
