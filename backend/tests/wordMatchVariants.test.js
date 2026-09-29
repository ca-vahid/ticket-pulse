import {
  containsWord, containsWordForm, containsWordVariant, editDistance, wordVariants, wordTokens, FUZZY_MIN_LENGTH,
} from '../src/utils/wordMatch.js';

/**
 * Knowledge v2 (28 Sep 2026): playbook word rules hear spelling variants and
 * one typo in longer words. The exact functions stay exact for other callers.
 */
describe('editDistance (Damerau-Levenshtein, optimal string alignment)', () => {
  test('insert, delete, substitute and swap each cost one', () => {
    expect(editDistance('global', 'globbal')).toBe(1);
    expect(editDistance('global', 'globl')).toBe(1);
    expect(editDistance('global', 'glibal')).toBe(1);
    expect(editDistance('global', 'glboal')).toBe(1);
    expect(editDistance('global', 'global')).toBe(0);
    expect(editDistance('global', 'gloobbal')).toBe(2);
  });

  test('stops early past max', () => {
    expect(editDistance('abcdef', 'uvwxyz', 1)).toBe(2);
    expect(editDistance('a', 'abcdef', 1)).toBe(2);
  });
});

describe('wordVariants', () => {
  test('British / American pairs both ways, inside phrases too', () => {
    expect(wordVariants('licence')).toEqual(expect.arrayContaining(['licence', 'license']));
    expect(wordVariants('License')).toEqual(expect.arrayContaining(['license', 'licence']));
    expect(wordVariants('licence server')).toEqual(expect.arrayContaining(['license server']));
    expect(wordVariants('colour')).toContain('color');
    expect(wordVariants('organization')).toContain('organisation');
    expect(wordVariants('centre')).toContain('center');
    expect(wordVariants('catalog')).toContain('catalogue');
    expect(wordVariants('favourite')).toContain('favorite');
  });

  test('set up / setup / set-up, log in, sign in', () => {
    expect(wordVariants('setup')).toEqual(expect.arrayContaining(['set up', 'setup', 'set-up']));
    expect(wordVariants('log-in')).toEqual(expect.arrayContaining(['log in', 'login']));
    expect(wordVariants('sign in issue')).toEqual(expect.arrayContaining(['signin issue', 'sign-in issue']));
  });

  test('blank is empty', () => {
    expect(wordVariants('  ')).toEqual([]);
  });
});

describe('containsWordVariant', () => {
  test('spelling pairs and plurals', () => {
    expect(containsWordVariant('ArcGIS Pro License expired', 'licence')).toBe(true);
    expect(containsWordVariant('Two licences please', 'license')).toBe(true);
    expect(containsWordVariant('Need more licenses', 'licence')).toBe(true);
  });

  test('compounds', () => {
    expect(containsWordVariant('Please set up my laptop', 'setup')).toBe(true);
    expect(containsWordVariant('New laptop set-up', 'set up')).toBe(true);
    expect(containsWordVariant('Cannot login to Teams', 'log in')).toBe(true);
    expect(containsWordVariant('Cannot sign-in', 'signin')).toBe(true);
  });

  test('one typo counts for words of FUZZY_MIN_LENGTH+ letters', () => {
    expect(FUZZY_MIN_LENGTH).toBe(6);
    expect(containsWordVariant('Globbal Mapper Update', 'global')).toBe(true);
    expect(containsWordVariant('instlal RocScience', 'install')).toBe(true);
    // Two edits: no.
    expect(containsWordVariant('Gloobbal Mapper', 'global')).toBe(false);
  });

  test('short words stay exact (no fuzzy): "vpn" never hears "vpm", "app" never "approval"', () => {
    expect(containsWordVariant('vpm down', 'vpn')).toBe(false);
    expect(containsWordVariant('Approval needed', 'app')).toBe(false);
    expect(containsWordVariant('Office dwn', 'down')).toBe(false);
  });

  test('still whole-word with common endings, and precomputed tokens work', () => {
    const text = 'Can I get the app installed?';
    expect(containsWordVariant(text, 'install', { tokens: wordTokens(text) })).toBe(true);
    expect(containsWordVariant('', 'install')).toBe(false);
    expect(containsWordVariant('anything', '')).toBe(false);
  });

  test('the exact helpers are unchanged', () => {
    expect(containsWord('ArcGIS Pro License', 'licence')).toBe(false);
    expect(containsWordForm('Globbal Mapper', 'global')).toBe(false);
  });
});
