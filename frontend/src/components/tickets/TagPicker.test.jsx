/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TagPicker, { SHORT_LIST } from './TagPicker';

// Invented names only (the repository is public).
const COLORS = ['slate', 'red', 'sky', 'emerald', 'amber', 'violet'];
const manyTags = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  name: `zz-gear-${String(i + 1).padStart(3, '0')}`,
  color: COLORS[i % COLORS.length],
}));
const FEW = [
  { id: 1, name: 'beacon-kit', color: 'sky' },
  { id: 2, name: 'drone-spare', color: 'red' },
  { id: 3, name: 'field-radio', color: 'emerald' },
  { id: 4, name: 'solar-panel', color: 'amber' },
  { id: 5, name: 'tripod', color: 'slate' },
];

/** A parent that owns the value, like the create form. */
function Harness({ tags, initial = [], onChange, onCreate }) {
  const [value, setValue] = useState(initial);
  return (
    <form onSubmit={(e) => { e.preventDefault(); throw new Error('form must not submit'); }}>
      <label htmlFor="tp-tags">Tags</label>
      <TagPicker
        id="tp-tags"
        tags={tags}
        value={value}
        onChange={(next) => { setValue(next); onChange?.(next); }}
        onCreate={onCreate}
      />
    </form>
  );
}

const box = () => screen.getByRole('combobox', { name: 'Tags' });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TagPicker', () => {
  test('200 tags: only the picked chips plus a short list — never a pill per tag', () => {
    const tags = manyTags(200);
    render(<Harness tags={tags} initial={[3, 150]} />);
    // Closed: just the two chips, no list at all.
    expect(screen.getAllByRole('button', { name: /^remove tag/i })).toHaveLength(2);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByText('zz-gear-001')).not.toBeInTheDocument();

    fireEvent.focus(box());
    const list = screen.getByRole('listbox');
    const options = within(list).getAllByRole('option');
    const tagOptions = options.filter((o) => !/browse all/i.test(o.textContent));
    expect(tagOptions.length).toBeLessThanOrEqual(SHORT_LIST);
    expect(options[options.length - 1]).toHaveTextContent('Browse all (200)');
    // Picked tags aren't offered again in the short list.
    expect(within(list).queryByText('zz-gear-003')).not.toBeInTheDocument();
    expect(box()).toHaveAttribute('aria-expanded', 'true');
  });

  test('typing filters, and the list stays capped', () => {
    render(<Harness tags={manyTags(200)} />);
    fireEvent.change(box(), { target: { value: 'gear-19' } });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    // gear-190…199 match (10): 8 rows + "Show all 10 matches".
    expect(options).toHaveLength(SHORT_LIST + 1);
    expect(options[0]).toHaveTextContent('zz-gear-190');
    expect(options[options.length - 1]).toHaveTextContent('Show all 10 matches');
  });

  test('keyboard: arrows move, Enter picks and keeps the list open', () => {
    const onChange = vi.fn();
    render(<Harness tags={FEW} onChange={onChange} />);
    fireEvent.focus(box());
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    const active = box().getAttribute('aria-activedescendant');
    expect(document.getElementById(active)).toHaveTextContent('drone-spare');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith([2]);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove tag drone-spare' })).toBeInTheDocument();
    // The next Enter picks the row that slid into place.
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith([2, 3]);
  });

  test('holding Backspace (key repeat) never eats the chips', () => {
    const onChange = vi.fn();
    render(<Harness tags={FEW} initial={[1, 4]} onChange={onChange} />);
    fireEvent.focus(box());
    fireEvent.keyDown(box(), { key: 'Backspace', repeat: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove tag solar-panel' })).toBeInTheDocument();
  });

  test('Backspace on an empty box removes the last chip; Esc closes the list only', () => {
    const onChange = vi.fn();
    render(<Harness tags={FEW} initial={[1, 4]} onChange={onChange} />);
    fireEvent.focus(box());
    fireEvent.keyDown(box(), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith([1]);
    expect(screen.queryByRole('button', { name: 'Remove tag solar-panel' })).not.toBeInTheDocument();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(box(), { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    expect(box()).toBeInTheDocument();
  });

  test('a chip × removes that tag', () => {
    const onChange = vi.fn();
    render(<Harness tags={FEW} initial={[1, 4]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag beacon-kit' }));
    expect(onChange).toHaveBeenLastCalledWith([4]);
  });

  test('Browse all opens the full list in the same popover, with letter headings', () => {
    const tags = [...manyTags(60), { id: 900, name: 'antenna-mast', color: 'blue' }];
    const onChange = vi.fn();
    render(<Harness tags={tags} initial={[5]} onChange={onChange} />);
    fireEvent.focus(box());
    fireEvent.click(screen.getByRole('option', { name: 'Browse all (61)' }));
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(61);
    expect(within(list).getByRole('group', { name: 'A' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'Z' })).toBeInTheDocument();
    expect(list.className).toMatch(/max-h-80/);
    // Picked tags show checked in the full list and toggle off from there.
    const picked = within(list).getByRole('option', { name: 'zz-gear-005' });
    expect(picked).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(picked);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  test('a small palette (< 12 tags) is the whole list, with no Browse all', () => {
    render(<Harness tags={FEW} />);
    fireEvent.focus(box());
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(5);
    expect(screen.queryByText(/browse all/i)).not.toBeInTheDocument();
  });

  test('controlled: clicking a row hands the parent the new id list', () => {
    const onChange = vi.fn();
    render(<TagPicker ariaLabel="Tags to add" tags={FEW} value={[5]} onChange={onChange} />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Tags to add' }));
    fireEvent.click(screen.getByRole('option', { name: 'field-radio' }));
    expect(onChange).toHaveBeenCalledWith([5, 3]);
  });

  test('create is offered only with onCreate, and only when nothing matches exactly', async () => {
    const { unmount } = render(<Harness tags={FEW} />);
    fireEvent.change(box(), { target: { value: 'kiln-sensor' } });
    expect(screen.queryByText(/create/i)).not.toBeInTheDocument();
    expect(screen.getByText('No matching tags.')).toBeInTheDocument();
    unmount();

    const onCreate = vi.fn().mockResolvedValue({ id: 77, name: 'kiln-sensor', color: 'slate' });
    const onChange = vi.fn();
    render(<Harness tags={FEW} onCreate={onCreate} onChange={onChange} />);
    fireEvent.change(box(), { target: { value: 'Tripod' } });
    expect(screen.queryByText(/create/i)).not.toBeInTheDocument();
    fireEvent.change(box(), { target: { value: 'kiln-sensor' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('kiln-sensor'));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([77]));
    expect(await screen.findByRole('button', { name: 'Remove tag kiln-sensor' })).toBeInTheDocument();
  });
});
