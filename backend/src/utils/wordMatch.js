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

// ---------- variants + light typo tolerance (Knowledge v2, 28 Sep 2026) ----------
// Playbook word rules (when a playbook still uses them) hear the spellings
// people actually type: British / American pairs, "set up" / "setup" /
// "set-up", and one slip in a longer word ("Globbal Mapper"). The plain
// functions above stay exact for every other caller.

const SPELLING_PAIRS = Object.freeze([
  ['licence', 'license'],
  ['licences', 'licenses'],
  ['colour', 'color'],
  ['organisation', 'organization'],
  ['centre', 'center'],
  ['catalogue', 'catalog'],
  ['favourite', 'favorite'],
]);
const COMPOUND_GROUPS = Object.freeze([
  ['set up', 'setup', 'set-up'],
  ['log in', 'login', 'log-in'],
  ['sign in', 'signin', 'sign-in'],
]);
/** A ticket word within one edit of a rule word counts only when the rule word is at least this long. */
export const FUZZY_MIN_LENGTH = 6;

/**
 * Damerau-Levenshtein distance (optimal string alignment: insert, delete,
 * substitute, swap two neighbours), stopping early once it passes `max`.
 */
export function editDistance(a, b, max = Infinity) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[t.length];
}

/** Every spelling a rule word stands for (itself first), lower-case. */
export function wordVariants(word) {
  const w = String(word ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!w) return [];
  const out = new Set([w]);
  // British / American, word by word (so "licence server" also reads "license server").
  for (const v of [...out]) {
    for (const [uk, us] of SPELLING_PAIRS) {
      if (containsWord(v, uk)) out.add(v.replace(wordRegex(uk), us));
      if (containsWord(v, us)) out.add(v.replace(wordRegex(us), uk));
    }
  }
  for (const v of [...out]) {
    for (const group of COMPOUND_GROUPS) {
      const hit = group.find((form) => containsWord(v, form));
      if (hit) for (const form of group) out.add(v.replace(wordRegex(hit), form));
    }
  }
  return [...out];
}

/** The distinct lower-case words of a text (letters and digits), for typo checks. */
export function wordTokens(text) {
  return new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

/**
 * Does `text` contain `word` in any of its forms: a common ending
 * (containsWordForm), a British / American spelling, a joined or hyphenated
 * compound ("setup" for "set up"), or — for a single word of
 * FUZZY_MIN_LENGTH+ letters — one typo (one letter added, dropped, changed or
 * two swapped). Pass `tokens` (wordTokens(text)) when checking many words
 * against one text.
 */
export function containsWordVariant(text, word, { tokens = null } = {}) {
  const variants = wordVariants(word);
  if (!variants.length) return false;
  const body = String(text ?? '');
  if (variants.some((v) => containsWordForm(body, v))) return true;
  const single = variants.filter((v) => /^[\p{L}]+$/u.test(v) && v.length >= FUZZY_MIN_LENGTH);
  if (!single.length) return false;
  const words = tokens || wordTokens(body);
  for (const tok of words) {
    for (const v of single) {
      if (Math.abs(tok.length - v.length) <= 1 && editDistance(tok, v, 1) <= 1) return true;
    }
  }
  return false;
}
