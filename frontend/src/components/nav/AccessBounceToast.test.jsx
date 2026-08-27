/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AccessBounceToast from './AccessBounceToast';
import { ACCESS_BOUNCE_KEY } from './navDestinations';

const renderToast = () => render(
  <MemoryRouter initialEntries={['/tickets']}>
    <AccessBounceToast />
  </MemoryRouter>,
);

afterEach(() => { cleanup(); sessionStorage.clear(); });

describe('AccessBounceToast', () => {
  test('renders nothing without a bounce marker', () => {
    renderToast();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('shows the one-time "Your access has changed" notice and consumes the marker', () => {
    sessionStorage.setItem(ACCESS_BOUNCE_KEY, '/analytics');
    renderToast();
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Your access has changed');
    expect(toast).toHaveTextContent('/analytics');
    expect(sessionStorage.getItem(ACCESS_BOUNCE_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
