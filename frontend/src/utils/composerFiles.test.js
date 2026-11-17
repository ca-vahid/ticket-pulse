import { describe, expect, test } from 'vitest';
import { MAX_COMPOSER_FILES, droppedFilesMessage, failedFilesMessage, mergeComposerFiles } from './composerFiles';

const f = (name, size = 10) => ({ name, size });

describe('mergeComposerFiles (QA 11-16 #3)', () => {
  test('twelve pasted screenshots all stay staged (the old cap kept five)', () => {
    const shots = Array.from({ length: 12 }, (_, i) => f(`pasted-image-${i + 1}.png`, 1000 + i));
    const { merged, dropped } = mergeComposerFiles([], shots);
    expect(merged).toHaveLength(12);
    expect(dropped).toEqual([]);
  });

  test('past the cap, the extra files are handed back, not lost silently', () => {
    const many = Array.from({ length: MAX_COMPOSER_FILES + 3 }, (_, i) => f(`f${i}.png`, i + 1));
    const { merged, dropped } = mergeComposerFiles([], many);
    expect(merged).toHaveLength(MAX_COMPOSER_FILES);
    expect(dropped.map((x) => x.name)).toEqual(['f20.png', 'f21.png', 'f22.png']);
  });

  test('the same file twice is staged once and is not counted as dropped', () => {
    const { merged, dropped } = mergeComposerFiles([f('a.png', 5)], [f('a.png', 5), f('b.png', 6)]);
    expect(merged.map((x) => x.name)).toEqual(['a.png', 'b.png']);
    expect(dropped).toEqual([]);
  });
});

describe('composer file notices', () => {
  test('dropped files', () => {
    expect(droppedFilesMessage([])).toBeNull();
    expect(droppedFilesMessage([f('x.png')])).toBe('A message can carry up to 20 files. x.png was not added.');
    expect(droppedFilesMessage([f('x.png'), f('y.png')])).toBe('A message can carry up to 20 files. 2 files were not added.');
  });

  test('files the server could not store', () => {
    expect(failedFilesMessage(undefined)).toBeNull();
    expect(failedFilesMessage([{ fileName: 'a.png', reason: 'Too big.' }])).toBe('One file was not stored: a.png. Too big.');
    const five = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ fileName: `${n}.png`, reason: 'Full.' }));
    expect(failedFilesMessage(five)).toBe('5 files were not stored: a.png, b.png, c.png and 2 more. Full.');
  });
});
