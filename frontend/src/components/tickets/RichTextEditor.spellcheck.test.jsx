/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import RichTextEditor from './RichTextEditor';

afterEach(() => cleanup());

// QA 10-08 #4: spell-check is asked for explicitly, in Canadian English.
test('the editor asks the browser to spell-check, in Canadian English', () => {
  render(<RichTextEditor value="" onChange={() => {}} ariaLabel="Reply" />);
  const box = screen.getByRole('textbox', { name: 'Reply' });
  expect(box).toHaveAttribute('spellcheck', 'true');
  expect(box).toHaveAttribute('lang', 'en-CA');
  expect(box).toHaveAttribute('contenteditable', 'true');
});
