/**
 * Phrases for "complete as I type" in the ticket composer (Nov 2026).
 *
 * Tier 1 has no AI: the completion comes from sentences this person has
 * already sent, and from the workspace's reply templates and quick notes —
 * the way a command prompt offers what you typed before. The store lives in
 * this browser only (localStorage), per person, and only fills while the
 * person has the feature switched on.
 *
 * The requester's first name is stored as a token and filled in again for the
 * ticket on screen, so "Hi Rita," learned on one ticket offers "Hi Sam," on
 * the next.
 */

const KEY = 'tp_composer_phrases_v1';
const MAX_PHRASES = 400;
const MIN_LEN = 12;
const MAX_LEN = 220;
export const NAME_TOKEN = '{{name}}';

const clean = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();

/** Text → the sentences worth offering again. */
export function splitPhrases(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    for (const part of clean(line).split(/(?<=[.!?])\s+/)) {
      const phrase = clean(part).replace(/^[-•*]\s+/, '');
      if (phrase.length < MIN_LEN || phrase.length > MAX_LEN) continue;
      // Not prose: quoted mail headers, links, code, markers, numbers-only lines.
      if (/https?:\/\/|\[Image:|^>|[{}<>]|^\S+@\S+$/.test(phrase.replace(NAME_TOKEN, ''))) continue;
      if (!/[a-z]{3,}\s+[a-z]{2,}/i.test(phrase)) continue;
      out.push(phrase);
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return raw && typeof raw === 'object' && Array.isArray(raw.items) ? raw : { items: [] };
  } catch {
    return { items: [] };
  }
}

/** Remember what was just sent. `firstName`: the requester's, swapped for a token. */
export function rememberSentText(text, { firstName = '' } = {}) {
  let body = String(text || '');
  const name = clean(firstName);
  if (name.length >= 2) body = body.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'g'), NAME_TOKEN);
  const phrases = splitPhrases(body);
  if (!phrases.length) return;
  const store = read();
  const byKey = new Map(store.items.map((it) => [it.t.toLowerCase(), it]));
  const now = Date.now();
  for (const t of phrases) {
    const hit = byKey.get(t.toLowerCase());
    if (hit) { hit.n += 1; hit.at = now; } else byKey.set(t.toLowerCase(), { t, n: 1, at: now });
  }
  // Most used first, then most recent; the tail drops off.
  const items = [...byKey.values()].sort((a, b) => (b.n - a.n) || (b.at - a.at)).slice(0, MAX_PHRASES);
  try { localStorage.setItem(KEY, JSON.stringify({ items })); } catch { /* storage full or unavailable */ }
}

/** The person's own phrases, most used first, with the name token still in. */
export function ownPhrases() {
  return read().items.map((it) => it.t);
}

export function forgetPhrases() {
  try { localStorage.removeItem(KEY); } catch { /* no-op */ }
}

/**
 * Everything on offer for this ticket: own phrases first, then templates and
 * quick notes, names filled in. `extraTexts`: plain texts to split.
 */
export function phrasesFor({ firstName = '', extraTexts = [] } = {}) {
  const name = clean(firstName);
  const seen = new Set();
  const out = [];
  const add = (t) => {
    let phrase = t;
    if (phrase.includes(NAME_TOKEN)) {
      if (!name) return;
      phrase = phrase.split(NAME_TOKEN).join(name);
    }
    const k = phrase.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(phrase); }
  };
  ownPhrases().forEach(add);
  extraTexts.forEach((text) => splitPhrases(text).forEach(add));
  return out;
}

/**
 * What to offer after `before` (the text of the line up to the caret), or
 * null. Only the sentence being typed counts, it needs a few letters first,
 * and the offer is the rest of the first phrase that starts the same way.
 */
export function suggestCompletion(before, phrases) {
  const text = String(before || '').replace(/\u00a0/g, ' ');
  if (!text || /\s{2,}$/.test(text)) return null;
  const cut = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '));
  const fragment = (cut >= 0 ? text.slice(cut + 2) : text).replace(/^\s+/, '');
  if (fragment.length < 4 || !/[a-z]/i.test(fragment)) return null;
  const low = fragment.toLowerCase();
  for (const phrase of phrases || []) {
    if (phrase.length > fragment.length + 2 && phrase.toLowerCase().startsWith(low)) return phrase.slice(fragment.length);
  }
  return null;
}

/** The first word of an offer (with its leading space), for Ctrl+Right. */
export function firstWord(offer) {
  const m = /^\s*\S+/.exec(String(offer || ''));
  return m ? m[0] : '';
}
