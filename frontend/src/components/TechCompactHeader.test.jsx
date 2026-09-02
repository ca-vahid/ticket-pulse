/** @vitest-environment jsdom */
// QA 09-01 #1: the compact table's sticky column header must NOT carry a
// positive top offset — below 1100px `.tp-compact-scroll` is a scroll
// container, so `top-[57px]` parked the header over the first technician
// row on iPads. The offset now lives in `.tp-compact-sticky` (index.css):
// top:0, and only from 1100px `var(--tp-app-header-h, 53px)`.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import TechCompactHeader from './TechCompactHeader';

afterEach(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));

describe('TechCompactHeader sticky offset', () => {
  test('uses the tp-compact-sticky class (no Tailwind top-* offsets) with z-30', () => {
    render(<TechCompactHeader viewMode="daily" sortField="name" sortDirection="asc" onSort={() => {}} simple />);
    const el = screen.getByTestId('tech-compact-header');
    expect(el).toHaveClass('tp-compact-sticky', 'z-30');
    // No Tailwind sticky/top utilities — the offset is owned by the CSS rule.
    expect(el.className).not.toMatch(/\btop-\[/);
    expect(el.className.split(/\s+/)).not.toContain('sticky');
  });

  test('index.css defines .tp-compact-sticky as top:0 below 1100px and the measured app-header var above', () => {
    const css = readFileSync(join(HERE, '../index.css'), 'utf8');
    // Base rule: position sticky + top 0.
    expect(css).toMatch(/\.tp-compact-sticky\s*\{\s*position:\s*sticky;\s*top:\s*0;\s*\}/);
    // Docked rule under the same 1100px seam as .tp-compact-scroll.
    expect(css).toMatch(/@media \(min-width: 1100px\)\s*\{\s*\.tp-compact-sticky\s*\{\s*top:\s*var\(--tp-app-header-h,\s*53px\);\s*\}\s*\}/);
    // The old 57px guess must not come back anywhere in the sticky rule.
    expect(css).not.toMatch(/tp-compact-sticky[^}]*57px/);
  });

  test('sortable columns call onSort; a fresh numeric column sorts high → low, name sorts A → Z', () => {
    const onSort = vi.fn();
    render(<TechCompactHeader viewMode="daily" sortField={null} sortDirection="desc" onSort={onSort} />);
    fireEvent.click(screen.getByTitle(/^sort by agent name/i));
    expect(onSort).toHaveBeenLastCalledWith('name', 'asc');
    const numeric = screen.getAllByTitle(/^sort by /i).find((b) => !/agent name/i.test(b.title));
    fireEvent.click(numeric);
    expect(onSort.mock.calls.at(-1)[0]).not.toBe('name');
    expect(onSort.mock.calls.at(-1)[1]).toBe('desc');
  });
});
