/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import CombinedIntoMark from './CombinedIntoMark';

afterEach(cleanup);

// QA 11-09 #5: a ticket closed into another says where the conversation went.
describe('CombinedIntoMark', () => {
  test('grouping reads "Combined into", a merge "Merged into"; the number links to the ticket', () => {
    render(<CombinedIntoMark into={{ id: 119897, displayRef: 'TP-11638', kind: 'combined' }} />);
    expect(screen.getByTestId('combined-into')).toHaveTextContent('Combined into TP-11638');
    expect(screen.getByRole('link', { name: 'Combined into TP-11638: open TP-11638' })).toHaveAttribute('href', '/tickets/119897');
    cleanup();
    render(<CombinedIntoMark into={{ id: 501, displayRef: '#247001', kind: 'merged' }} />);
    expect(screen.getByTestId('combined-into')).toHaveTextContent('Merged into #247001');
  });

  test('a plain click opens through the page (peek); a modified click is left to the browser', () => {
    const onOpen = vi.fn();
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <CombinedIntoMark into={{ id: 5, displayRef: 'TP-5', kind: 'combined' }} onOpen={onOpen} />
      </div>,
    );
    const link = screen.getByRole('link');
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith(5, expect.anything());
    expect(rowClick).not.toHaveBeenCalled();
    fireEvent.click(link, { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('nothing to say renders nothing', () => {
    const { container } = render(<CombinedIntoMark into={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
