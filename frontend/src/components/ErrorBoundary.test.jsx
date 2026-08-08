/** @vitest-environment jsdom */
// Phase 2 (QA 08-07 #10) — crash-proofing: a render throw shows the tp-styled
// fallback card (with Reload + collapsible detail) instead of a white screen.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

function Bomb({ shouldThrow = true }) {
  if (shouldThrow) throw new Error('kaboom: overlay lost its ticket');
  return <p>healthy content</p>;
}

let consoleErrorSpy;

beforeEach(() => {
  // React logs caught boundary errors loudly — keep test output clean while
  // still asserting the boundary's own console.error call.
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
});

describe('ErrorBoundary', () => {
  test('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy content')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  test('catches a render throw: fallback card, console.error, no white screen', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload/ })).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'ErrorBoundary caught a render error:',
      expect.any(Error),
      expect.anything(),
    );
  });

  test('detail is collapsed by default and reveals the error text on toggle', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.queryByText(/kaboom/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText(/kaboom: overlay lost its ticket/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.queryByText(/kaboom/)).not.toBeInTheDocument();
  });

  test('Reload button triggers window.location.reload', () => {
    const reload = vi.fn();
    const original = window.location;
    // jsdom's window.location is replaceable this way in vitest.
    delete window.location;
    window.location = { ...original, reload };
    try {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      fireEvent.click(screen.getByRole('button', { name: /Reload/ }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      window.location = original;
    }
  });

  test('inline variant labels the failed area and stays compact (no page backdrop)', () => {
    const { container } = render(
      <ErrorBoundary variant="inline" label="ticket board">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/The ticket board hit an unexpected error/)).toBeInTheDocument();
    expect(container.querySelector('.tp-page-backdrop')).toBeNull();
  });
});
