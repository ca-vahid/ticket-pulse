/**
 * Dark-mode token codemod (Phase DM-B, v3.8.03).
 *
 * Applies the CLAUDE.md migration map mechanically to class strings:
 *   bg-white → bg-card · text-slate-900/800 → text-foreground ·
 *   text-slate-600/500 → text-muted-foreground · border-slate-200 → border-border ·
 *   border-slate-300 → border-input · bg-slate-50/100 → bg-muted/50|bg-muted ·
 *   (+ gray twins, gradient stops, divide/ring/placeholder variants)
 * and adds `dark:` twins for accent tints that have no token
 * (bg-blue-50 → + dark:bg-blue-500/15, text-blue-700 → + dark:text-blue-200 …).
 *
 * Variant prefixes (hover:, md:, group-hover:, data-[…]:) are preserved because
 * only the base token is rewritten. Tokens already carrying a `dark:` variant
 * are left alone, and a twin is only added when the surrounding string literal
 * does not already mention the same dark property.
 *
 *   node scripts/dark-migrate.mjs --dry src/pages/Dashboard.jsx
 *   node scripts/dark-migrate.mjs src/pages src/components
 *
 * Hand-pass still required for: dynamic template classes (`text-${tone}-700`),
 * inline style colours, chart hexes, tone maps and anything the light ratios
 * cannot cover (bg-slate-900 tooltips, text-slate-300 decorative icons).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HUES = 'blue|indigo|violet|purple|fuchsia|pink|rose|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky';
const GREYS = 'slate|gray|zinc|neutral|stone';

// --- 1. Direct token replacements (base token only; variants are kept) -------
// [regex on the base token, replacement]. Alpha suffix (/NN) is captured as $<a>.
const ALPHA = '(?<a>\\/(?:\\d{1,3}|\\[[^\\]]+\\]))?';
const DIRECT = [
  // Surfaces
  [new RegExp(`^bg-white${ALPHA}$`), (m) => keepLowAlpha(m, 'bg-white', 'bg-card')],
  [new RegExp(`^(?<p>from|via|to)-white${ALPHA}$`), (m) => keepLowAlpha(m, `${m.groups.p}-white`, `${m.groups.p}-card`)],
  [new RegExp(`^border-white${ALPHA}$`), (m) => keepLowAlpha(m, 'border-white', 'border-card')],
  [new RegExp(`^ring-white${ALPHA}$`), (m) => keepLowAlpha(m, 'ring-white', 'ring-card')],
  [new RegExp(`^bg-(?:${GREYS})-50${ALPHA}$`), (m) => `bg-muted${halfAlpha(m)}`],
  [new RegExp(`^bg-(?:${GREYS})-100${ALPHA}$`), (m) => `bg-muted${alpha(m)}`],
  [new RegExp(`^bg-(?:${GREYS})-200${ALPHA}$`), (m) => `bg-secondary${alpha(m)}`],
  [new RegExp(`^(?<p>from|via|to)-(?:${GREYS})-50${ALPHA}$`), (m) => `${m.groups.p}-muted${halfAlpha(m)}`],
  [new RegExp(`^(?<p>from|via|to)-(?:${GREYS})-100${ALPHA}$`), (m) => `${m.groups.p}-muted${alpha(m)}`],
  [new RegExp(`^(?<p>from|via|to)-(?:${GREYS})-200${ALPHA}$`), (m) => `${m.groups.p}-secondary${alpha(m)}`],
  // Text
  [new RegExp(`^text-(?:${GREYS})-(?:950|900|800)${ALPHA}$`), (m) => `text-foreground${alpha(m)}`],
  [new RegExp(`^text-(?:${GREYS})-700${ALPHA}$`), (m) => `text-foreground${m.groups.a ? alpha(m) : '/85'}`],
  [new RegExp(`^text-(?:${GREYS})-(?:600|500)${ALPHA}$`), (m) => `text-muted-foreground${alpha(m)}`],
  [new RegExp(`^text-(?:${GREYS})-400${ALPHA}$`), (m) => `text-muted-foreground${m.groups.a ? alpha(m) : '/75'}`],
  [new RegExp(`^placeholder-(?:${GREYS})-(?:400|500)$`), () => 'placeholder-muted-foreground/70'],
  // Light-grey decorative text/dots on light surfaces (guarded by darkChrome)
  [new RegExp(`^text-(?:${GREYS})-300$`), (m, o) => (o.darkChrome ? m[0] : 'text-muted-foreground/50')],
  [new RegExp(`^bg-(?:${GREYS})-300${ALPHA}$`), (m, o) => (o.darkChrome ? m[0] : `bg-muted-foreground${m.groups.a ? alpha(m) : '/40'}`)],
  [new RegExp(`^bg-(?:${GREYS})-400${ALPHA}$`), (m, o) => (o.darkChrome ? m[0] : `bg-muted-foreground${m.groups.a ? alpha(m) : '/60'}`)],
  // Borders / dividers / rings
  [new RegExp(`^border(?<side>-[trblxyse])?-(?:${GREYS})-(?:200)${ALPHA}$`), (m) => `border${m.groups.side || ''}-border${alpha(m)}`],
  [new RegExp(`^border(?<side>-[trblxyse])?-(?:${GREYS})-(?:100|50)${ALPHA}$`), (m) => `border${m.groups.side || ''}-border${m.groups.a ? alpha(m) : '/60'}`],
  [new RegExp(`^border(?<side>-[trblxyse])?-(?:${GREYS})-(?:300)${ALPHA}$`), (m) => `border${m.groups.side || ''}-input${alpha(m)}`],
  [new RegExp(`^divide-(?:${GREYS})-(?:200)${ALPHA}$`), (m) => `divide-border${alpha(m)}`],
  [new RegExp(`^divide-(?:${GREYS})-(?:100|50)${ALPHA}$`), (m) => `divide-border${m.groups.a ? alpha(m) : '/60'}`],
  [new RegExp(`^ring-(?:${GREYS})-(?:200|100)${ALPHA}$`), (m) => `ring-border${alpha(m)}`],
  [new RegExp(`^ring-(?:${GREYS})-300${ALPHA}$`), (m) => `ring-input${alpha(m)}`],
  [new RegExp(`^outline-(?:${GREYS})-(?:200|300)$`), () => 'outline-border'],
];

function alpha(m) { return m.groups.a || ''; }
function halfAlpha(m) {
  if (!m.groups.a) return '/50';
  const n = Number(m.groups.a.slice(1));
  if (Number.isFinite(n)) return `/${Math.max(5, Math.round(n / 2 / 5) * 5)}`;
  return m.groups.a;
}
/** Low-alpha whites are overlay tints on coloured surfaces — keep them. */
function keepLowAlpha(m, from, to) {
  const a = m.groups.a;
  if (a) {
    const n = Number(a.slice(1));
    if (Number.isFinite(n) && n <= 30) return `${from}${a}`;
  }
  return `${to}${a || ''}`;
}

// --- 2. Accent tints → add a dark: twin ---------------------------------------
const TWIN = [
  [new RegExp(`^(?<p>bg|from|via|to)-(?<h>${HUES})-50$`), (m) => `${m.groups.p}-${m.groups.h}-500/15`],
  [new RegExp(`^(?<p>bg|from|via|to)-(?<h>${HUES})-100$`), (m) => `${m.groups.p}-${m.groups.h}-500/20`],
  [new RegExp(`^(?<p>bg|from|via|to)-(?<h>${HUES})-200$`), (m) => `${m.groups.p}-${m.groups.h}-500/30`],
  [new RegExp(`^bg-(?<h>${HUES})-50\\/\\d{1,3}$`), (m) => `bg-${m.groups.h}-500/10`],
  [new RegExp(`^bg-(?<h>${HUES})-100\\/\\d{1,3}$`), (m) => `bg-${m.groups.h}-500/15`],
  [new RegExp(`^text-(?<h>${HUES})-600$`), (m) => `text-${m.groups.h}-300`],
  [new RegExp(`^text-(?<h>${HUES})-(?:700|800|900|950)$`), (m) => `text-${m.groups.h}-200`],
  [new RegExp(`^border(?<side>-[trblxyse])?-(?<h>${HUES})-100$`), (m) => `border${m.groups.side || ''}-${m.groups.h}-500/20`],
  [new RegExp(`^border(?<side>-[trblxyse])?-(?<h>${HUES})-200$`), (m) => `border${m.groups.side || ''}-${m.groups.h}-500/30`],
  [new RegExp(`^border(?<side>-[trblxyse])?-(?<h>${HUES})-300$`), (m) => `border${m.groups.side || ''}-${m.groups.h}-500/40`],
  [new RegExp(`^ring-(?<h>${HUES})-(?:100|200)$`), (m) => `ring-${m.groups.h}-500/30`],
  [new RegExp(`^divide-(?<h>${HUES})-(?:100|200)$`), (m) => `divide-${m.groups.h}-500/30`],
];

const PROPERTY_OF = (token) => token.replace(/-(?:\d{2,3}|white|black|transparent|current)(?:\/.*)?$/, '');

/**
 * Rewrite one class token (with variants). Returns the replacement string
 * (possibly with an appended dark twin) or null when untouched.
 */
export function migrateToken(token, { hasDarkTwin = () => false, darkChrome = false } = {}) {
  const parts = token.split(':');
  const base = parts[parts.length - 1];
  const variants = parts.slice(0, -1);
  if (variants.includes('dark')) return null;
  if (base.startsWith('!')) return null;
  for (const [re, fn] of DIRECT) {
    const m = base.match(re);
    if (m) {
      const next = fn(m, { darkChrome });
      if (next === base) return null;
      return [...variants, next].join(':');
    }
  }
  for (const [re, fn] of TWIN) {
    const m = base.match(re);
    if (m) {
      const twinBase = fn(m);
      const twin = ['dark', ...variants, twinBase].join(':');
      const prop = ['dark', ...variants, PROPERTY_OF(twinBase)].join(':');
      if (hasDarkTwin(prop)) return null;
      return `${token} ${twin}`;
    }
  }
  return null;
}

// A class token: letters/digits/-/_/./:/[]/%/ and a leading ! or -.
const TOKEN_RE = /(?<![\w./-])(!?-?[a-z][\w:/\-.[\]%]*)/g;

// Literals that paint dark chrome in BOTH themes (tooltips, hero bands): the
// light-grey text/dot rules must not touch them.
const DARK_CHROME_RE = /\b(?:bg|from|via|to)-(?:slate|gray|zinc|neutral|stone)-(?:700|800|900|950)\b|\btext-white\b/;

/**
 * Walk JS/JSX source, rewriting class-like tokens inside string and template
 * literals only. Template literals are scanned recursively so `${ ... }`
 * expressions (which may hold nested quotes/backticks) are treated as code.
 */
export function migrateSource(source) {
  const state = { count: 0 };
  const { out } = scanCode(source, 0, state, false);
  return { text: out, count: state.count };
}

function scanCode(src, start, state, stopAtBrace) {
  let out = '';
  let i = start;
  let depth = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i];
    if (stopAtBrace) {
      if (ch === '{') depth += 1;
      if (ch === '}') {
        if (depth === 0) return { out, i };
        depth -= 1;
      }
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < len && src[j] !== ch && src[j] !== '\n') {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      const literal = src.slice(i + 1, j);
      out += ch + migrateLiteral(literal, state) + (j < len ? src[j] : '');
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      const res = scanTemplate(src, i + 1, state);
      out += '`' + res.out;
      i = res.i;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      const end = j === -1 ? len : j;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j === -1 ? len : j + 2;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { out, i };
}

/** Scan a template literal body from `start` (after the opening backtick). */
function scanTemplate(src, start, state) {
  let out = '';
  let chunk = '';
  let i = start;
  const len = src.length;
  const flush = () => { out += migrateLiteral(chunk, state); chunk = ''; };
  while (i < len) {
    const ch = src[i];
    if (ch === '\\') { chunk += src.slice(i, i + 2); i += 2; continue; }
    if (ch === '`') { flush(); out += '`'; return { out, i: i + 1 }; }
    if (ch === '$' && src[i + 1] === '{') {
      flush();
      const res = scanCode(src, i + 2, state, true);
      out += '${' + res.out + '}';
      i = res.i + 1;
      continue;
    }
    chunk += ch;
    i += 1;
  }
  flush();
  return { out, i };
}

function migrateLiteral(literal, state) {
  if (!/(?:bg|text|border|divide|ring|from|via|to|placeholder|outline)-/.test(literal)) return literal;
  const hasDarkTwin = (prop) => literal.includes(prop);
  const darkChrome = DARK_CHROME_RE.test(literal);
  return literal.replace(TOKEN_RE, (tok) => {
    const next = migrateToken(tok, { hasDarkTwin, darkChrome });
    if (next === null) return tok;
    state.count += 1;
    return next;
  });
}

function walk(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry), out);
  } else if (/\.(jsx?|tsx?)$/.test(path) && !/\.test\.[jt]sx?$/.test(path)) {
    out.push(path);
  }
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const paths = args.filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('usage: node scripts/dark-migrate.mjs [--dry] <file|dir>…');
    return 2;
  }
  const files = [];
  for (const p of paths) walk(resolve(p), files);
  let total = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const { text, count } = migrateSource(src);
    if (count === 0) continue;
    total += count;
    console.log(`${count.toString().padStart(5)}  ${file}`);
    if (!dry) writeFileSync(file, text);
  }
  console.log(`${dry ? '[dry] ' : ''}${total} class tokens across ${files.length} files`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}
