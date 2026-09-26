/**
 * Whole-word matching for keyword rules and keyword scoring (Auto-help,
 * 25 Sep 2026 audit): "app" must not match "approval", "vpn" must match
 * "VPN." and "c++" / ".net" keep working. Case-insensitive; regex specials
 * in the word are escaped. A "word" boundary is any character that is not a
 * letter or digit, so phrases ("company portal") match across one space.
 */

export function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const cache = new Map();
const CACHE_MAX = 500;

/** Case-insensitive whole-word RegExp for a word or short phrase (null for blank). */
export function wordRegex(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return null;
  let re = cache.get(w);
  if (!re) {
    const body = escapeRegex(w).replace(/\s+/g, '\\s+');
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(w, re);
  }
  return re;
}

const formCache = new Map();
// Common English endings on the LAST word, so a rule for "install" also hears
// "installed", "installing", "installs" and "installation" (QA 09-25: "Can I
// please get the app installed" missed the install playbook). Still whole-word
// at the start: "app" matches "apps" but never "approval".
const WORD_FORM_SUFFIX = '(?:s|es|d|ed|ing|er|ers|ation|ations)?';

/** Like wordRegex, but the last word may carry a common ending (keyword rules). */
export function wordFormRegex(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return null;
  let re = formCache.get(w);
  if (!re) {
    const body = escapeRegex(w).replace(/\s+/g, '\\s+');
    const suffix = /[a-z]$/.test(w) ? WORD_FORM_SUFFIX : '';
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}${suffix}(?![\\p{L}\\p{N}])`, 'iu');
    if (formCache.size >= CACHE_MAX) formCache.clear();
    formCache.set(w, re);
  }
  return re;
}

/** Does `text` contain `word` (or a common form of it, e.g. install -> installed)? */
export function containsWordForm(text, word) {
  const re = wordFormRegex(word);
  return re ? re.test(String(text ?? '')) : false;
}

/** Does `text` contain `word` as a whole word (or phrase)? */
export function containsWord(text, word) {
  const re = wordRegex(word);
  return re ? re.test(String(text ?? '')) : false;
}
