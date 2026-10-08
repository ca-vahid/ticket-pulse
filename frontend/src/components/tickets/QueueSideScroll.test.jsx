/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import QueueSideScroll from './QueueSideScroll';

// QA 10-07 #1: the round arrows sat on top of row content ("the arrow being
// inside the box can be annoying"). They are opt-in now; the list still
// scrolls by drag, Shift + wheel, the arrow keys and the sticky scrollbar.
function Harness({ arrows }) {
  const ref = useRef(null);
  return (
    <QueueSideScroll targetRef={ref} arrows={arrows}>
      <div ref={ref}><div>rows</div></div>
    </QueueSideScroll>
  );
}

afterEach(() => cleanup());

describe('QueueSideScroll arrows', () => {
  it('draws no arrow buttons unless the person turned them on', () => {
    render(<Harness />);
    expect(screen.getByText('rows')).toBeInTheDocument();
    expect(screen.queryByLabelText('Scroll columns right')).toBeNull();
    expect(screen.queryByLabelText('Scroll columns left')).toBeNull();
  });

  it('draws both arrows when turned on', () => {
    render(<Harness arrows />);
    expect(screen.getByLabelText('Scroll columns right')).toBeInTheDocument();
    expect(screen.getByLabelText('Scroll columns left')).toBeInTheDocument();
  });
});
