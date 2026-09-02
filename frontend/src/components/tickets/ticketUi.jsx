import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { Link } from 'react-router-dom';
import { ExternalLink, Ticket as TicketIcon, Ban, ClipboardList, Cloud, CloudOff, CloudUpload, Globe, Sparkles, UserCog, UserPlus, UserRound, Zap } from 'lucide-react';
import { PRIORITY_STRIP_COLORS, PRIORITY_LABELS, STATUS_COLORS, FRESHSERVICE_DOMAIN } from '../tech-detail/constants';
import { useTicketTypes } from '../../hooks/useTicketTypes';
import { useTheme } from '../../contexts/ThemeContext';

export { PRIORITY_STRIP_COLORS, PRIORITY_LABELS, STATUS_COLORS };

/**
 * A thread entry that is an actual MESSAGE (reply/note/email), not the FS
 * activity feed — FS caches system lines ("executed workflow…") as entries
 * with bodies, and those belong on the History tab, never in Conversation.
 */
export function isConversationEntry(e) {
  if (!e || e.source === 'freshservice_activity') return false;
  return Boolean(e.bodyText || e.content || e.bodyHtml);
}

/**
 * Category labels with the CORRECT precedence: the Ticket Pulse taxonomy is
 * the primary system — canonical internal categories first, then the raw
 * TP-category custom fields from FS (tp_skill/tp_subskill), and only then
 * the legacy single-box FS category ("security" era) as a last resort.
 */
export function ticketCategoryLabels(t) {
  return {
    category: t?.internalCategory?.name || t?.tpSkill || t?.ticketCategory || null,
    subcategory: t?.internalSubcategory?.name || t?.tpSubskill || null,
  };
}

/** Human labels for AI pipeline runs (shared by detail sidebar + peek). */
export function pipelineRunLabel(run) {
  if (!run) return null;
  if (run.status === 'queued') return 'Queued';
  const raw = run.decision || run.status || '';
  if (raw === 'priority_only') return 'Priority & category assessed';
  return String(raw).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function pipelineTriggerLabel(source) {
  const map = {
    poll: 'business-hours queue',
    priority_assessment_after_hours: 'after-hours assessment',
    manual: 'manual trigger',
    app_native: 'created in Ticket Pulse',
  };
  return map[source] || String(source || '').replace(/_/g, ' ');
}

// Ticket arrival channel (QA 07-10 #6/#7). Mirrors the backend's
// TICKET_SOURCE_LABELS numeric space: 1–10 = FreshService codes, 100+ = TP
// extensions. SOURCE_OPTIONS = the channels an agent can pick when logging
// or editing a TP-born ticket.
export const TICKET_SOURCE_LABELS = {
  1: 'Email', 2: 'Portal', 3: 'Phone', 4: 'Chat', 5: 'Feedback widget',
  6: 'Yammer', 7: 'AWS CloudWatch', 8: 'PagerDuty', 9: 'Walk-up', 10: 'Slack',
  // 11–19 and 1000+ are this FS instance's custom source choices (QA 07-14 #5).
  13: 'Employee Onboarding', 14: 'Alerts', 15: 'MS Teams (FS)',
  18: 'Employee Offboarding', 19: 'Journey',
  100: 'API', 101: 'Webhook', 102: 'MS Teams', 103: 'Agent',
  1001: 'API (FreshService)', 1002: 'Company Portal',
};
export function ticketSourceLabel(source) {
  if (source === null || source === undefined) return null;
  return TICKET_SOURCE_LABELS[Number(source)] || `Source ${source}`;
}
export const SOURCE_OPTIONS = [
  { value: 103, label: 'Agent (logged in app)' },
  { value: 1, label: 'Email' },
  { value: 3, label: 'Phone' },
  { value: 9, label: 'Walk-up' },
  { value: 102, label: 'MS Teams' },
  { value: 2, label: 'Portal' },
];

// Email bodies reference inline images by `cid:` (Content-ID) — those can
// never resolve in a browser and render as broken-image icons. Drop them; the
// actual bytes surface via the attachment strip/rail instead (QA 07-06 #9).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG' && /^cid:/i.test(node.getAttribute('src') || '')) node.remove();
});

// ---------------------------------------------------------------------------
// Inline-colour neutraliser (Phase DW v3.8.11 → v2, QA 09-01 #6).
//
// Email HTML arrives soaked in colours that carry ZERO authorial intent —
// Outlook stamps quoted headers `color:black`/`windowtext`, disclaimers get a
// grey `#A6A6A6` footer, hyperlinks carry the Office default `#0563C1`, cells
// get `bgcolor="#ffffff"`. If those survive, nearly every body counts as
// "has author colours" and lands on the dimmed PAPER panel in dark mode
// (FS #240242: its only surviving colour was the grey footer). Rules:
//
//   LIGHT mode — exactly the v3.8.11 behaviour: only near-black text colours
//   (`black`, `windowtext`, every channel ≤ 29) are dropped. Nothing else is
//   touched (there is no well on a white card, so the variant is moot).
//
//   DARK mode — every colour is classified with isNonAuthorialColor():
//   keywords, anything on/inside a link, Office defaults, ANY grayscale
//   (max−min ≤ 24 at any lightness), white/near-white → dropped, not counted.
//   Authorial TEXT colours are MAPPED, never switched: dark ones (navy
//   signatures `#0C1975`, `#1F497D`) are rewritten to the same hue at 70%
//   lightness so they read on the dark ground; light ones (`#EE0000`,
//   `#5B9BD5`) stay verbatim. Neither counts. ONLY saturated BACKGROUNDS
//   (`bgcolor`, `background(-color)`) are paper triggers — a coloured table
//   was designed against its own ground and must keep it. The legacy
//   `background="x.png"` image attribute is always stripped.
//
// Hooks are global on the DOMPurify singleton, so everything below is gated
// by `neutralizeMode`, set only around SafeHtml's sanitize call (the
// composer's paste sanitizer must NOT rewrite outgoing HTML).
// ---------------------------------------------------------------------------

const NAMED_COLORS = {
  black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128],
  silver: [192, 192, 192], darkgray: [169, 169, 169], darkgrey: [169, 169, 169],
  lightgray: [211, 211, 211], lightgrey: [211, 211, 211], dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105], gainsboro: [220, 220, 220], whitesmoke: [245, 245, 245],
  blue: [0, 0, 255], red: [255, 0, 0], green: [0, 128, 0], navy: [0, 0, 128],
  maroon: [128, 0, 0], purple: [128, 0, 128], orange: [255, 165, 0], yellow: [255, 255, 0],
  teal: [0, 128, 128], olive: [128, 128, 0], lime: [0, 255, 0], aqua: [0, 255, 255],
  cyan: [0, 255, 255], fuchsia: [255, 0, 255], magenta: [255, 0, 255],
  darkblue: [0, 0, 139], darkred: [139, 0, 0], darkgreen: [0, 100, 0],
};
// System / CSS-wide keywords: never a design choice.
const COLOR_KEYWORDS = new Set([
  'windowtext', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'transparent',
  'currentcolor', 'buttontext', 'canvastext', 'graytext', 'highlighttext', 'none', 'auto',
]);
// Office's default hyperlink / followed-hyperlink / legacy-blue stamps.
const OFFICE_DEFAULT_HEX = new Set(['#0563c1', '#954f72', '#0000ff']);
const GRAYSCALE_SPREAD = 24;
const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const toHex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Parse a CSS/HTML colour → `{ rgb, a }`, `{ keyword }`, or null (unknown —
 * hsl(), var(), exotic names — treated as an author choice by callers).
 * Hex 3/4/6/8, rgb()/rgba() (comma or space syntax, % channels, alpha 0 →
 * transparent) and the named colours above.
 */
export function parseColor(value) {
  const v = String(value ?? '').trim().toLowerCase().replace(/\s*!important$/, '');
  if (!v) return null;
  if (COLOR_KEYWORDS.has(v)) return { keyword: v };
  const hex = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if (a === 0) return { keyword: 'transparent' };
    return { rgb: [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((c) => parseInt(c, 16)), a };
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (rgb) {
    const chan = (s) => clamp255(s.endsWith('%') ? parseFloat(s) * 2.55 : parseFloat(s));
    const a = rgb[4] === undefined ? 1 : (rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]));
    if (a === 0) return { keyword: 'transparent' };
    return { rgb: [chan(rgb[1]), chan(rgb[2]), chan(rgb[3])], a };
  }
  if (NAMED_COLORS[v]) return { rgb: NAMED_COLORS[v], a: 1 };
  return null;
}

/**
 * Does this colour carry NO authorial intent? `ctx.tag` is the element's tag,
 * `ctx.inLink` whether it sits on/inside an <a> (link colours are the mail
 * client's, never the writer's), `ctx.prop` the property it came from
 * (`color`, `background-color`, `background`, `bgcolor` — informational).
 * Unknown/unparseable values are treated as authorial (return false).
 */
export function isNonAuthorialColor(value, ctx = {}) {
  const c = parseColor(value);
  if (!c) return false;
  if (c.keyword) return true;
  if (ctx.inLink || String(ctx.tag || '').toLowerCase() === 'a') return true;
  if (OFFICE_DEFAULT_HEX.has(toHex(c.rgb))) return true;
  const [r, g, b] = c.rgb;
  // Any grayscale — black, greys at every lightness, white — including the
  // near-white cell backgrounds Word/Outlook stamp on tables.
  return Math.max(r, g, b) - Math.min(r, g, b) <= GRAYSCALE_SPREAD;
}

// The v3.8.11 near-black rule, kept verbatim for LIGHT mode.
function isNearBlackColor(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return false;
  if (v === 'black' || v === 'windowtext') return true;
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1];
    const chans = h.length === 3
      ? [...h].map((c) => parseInt(c + c, 16))
      : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((c) => parseInt(c, 16));
    return chans.every((n) => n <= 29);
  }
  const rgb = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/);
  if (rgb) return Number(rgb[1]) <= 29 && Number(rgb[2]) <= 29 && Number(rgb[3]) <= 29;
  return false;
}

const relativeLuminance = ([r, g, b]) => {
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const hslOf = ([r, g, b]) => {
  const R = r / 255; const G = g / 255; const B = b / 255;
  const max = Math.max(R, G, B); const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return { h, s, l };
};
// "Dark" text = it would sink into the dark ground: relative luminance under
// 0.35 (navy/teal/forest signatures), EXCEPT vivid mid-lightness primaries
// (HSL lightness ≥ 45% — `#EE0000`) whose luminance is low only because of
// channel weighting; those already read on a dark ground and stay verbatim.
const DARK_TEXT_LUMINANCE = 0.35;
const DARK_TEXT_MAX_LIGHTNESS = 0.45;
const LIFTED_LIGHTNESS = 70;
function isDarkTextColor(rgb) {
  return relativeLuminance(rgb) < DARK_TEXT_LUMINANCE && hslOf(rgb).l < DARK_TEXT_MAX_LIGHTNESS;
}
/** Same hue and saturation, lifted to 70% lightness (CSS Color 4 syntax). */
export function liftColorForDark(rgb) {
  const { h, s } = hslOf(rgb);
  return `hsl(${h} ${Math.round(s * 100)}% ${LIFTED_LIGHTNESS}%)`;
}

// Text colour → null (drop), a rewritten value, or the value verbatim.
function mapTextColor(value, ctx) {
  if (isNonAuthorialColor(value, { ...ctx, prop: 'color' })) {
    // Mid greys are the author's way of de-emphasising (disclaimer footers,
    // "Sent from my iPhone", quoted headers). Keep that intent in dark mode by
    // mapping them to the muted token instead of flattening to full foreground.
    // Near-black / near-white greys and colours on links simply drop.
    const g = parseColor(value);
    if (g?.rgb && !ctx?.inLink && ctx?.tag !== 'A') {
      const { l } = hslOf(g.rgb);
      const chroma = Math.max(...g.rgb) - Math.min(...g.rgb);
      if (chroma <= 24 && l >= 0.35 && l <= 0.85) return 'hsl(var(--muted-foreground))';
    }
    return null;
  }
  const c = parseColor(value);
  if (c?.rgb && isDarkTextColor(c.rgb)) return liftColorForDark(c.rgb);
  return value;
}

// `background` shorthand: split into whitespace tokens (parens kept intact so
// `rgb(1, 2, 3)` / `url(a b)` survive) and look for a colour word that is an
// author choice. Images, `none`, `transparent`, white → no authorial colour.
function backgroundHasAuthorialColor(value, ctx) {
  const tokens = [];
  let depth = 0; let cur = '';
  for (const ch of String(value)) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) { if (cur) tokens.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens.some((t) => {
    const c = parseColor(t);
    return Boolean(c?.rgb) && !isNonAuthorialColor(t, { ...ctx, prop: 'background' });
  });
}

// Split a style attribute on `;` at paren/quote depth 0 so `url(data:…;base64,…)`
// and quoted font names stay whole (the v3.8.11 naive split would have
// shredded them once we started dropping `background` declarations).
function splitDeclarations(style) {
  const out = [];
  let depth = 0; let quote = null; let cur = '';
  for (const ch of String(style)) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const PAPER_PROPS = new Set(['color', 'background', 'background-color']);

let neutralizeMode = null; // null | 'light' | 'dark' — only during SafeHtml's sanitize
let paperTriggers = 0;

function neutralizeNode(node) {
  const dark = neutralizeMode === 'dark';
  const tag = node.tagName;
  const ctx = {
    tag,
    inLink: dark && typeof node.closest === 'function' && Boolean(node.closest('a')),
  };

  // A lifted <font color> moves to an inline style: the legacy attribute only
  // parses names/hex (an `hsl()` value would be mangled by the legacy colour
  // parser), and `style` wins over the attribute anyway.
  let liftedFontColor = null;
  if (tag === 'FONT' && node.hasAttribute('color')) {
    const v = node.getAttribute('color');
    if (dark) {
      const next = mapTextColor(v, ctx);
      if (next === null) node.removeAttribute('color');
      else if (next !== v) { node.removeAttribute('color'); liftedFontColor = next; }
    } else if (isNearBlackColor(v)) {
      node.removeAttribute('color');
    } else {
      paperTriggers += 1;
    }
  }
  if (node.hasAttribute('bgcolor')) {
    if (dark && isNonAuthorialColor(node.getAttribute('bgcolor'), { ...ctx, prop: 'bgcolor' })) node.removeAttribute('bgcolor');
    else paperTriggers += 1;
  }
  if (node.hasAttribute('background')) {
    if (dark) node.removeAttribute('background');
    else paperTriggers += 1;
  }

  const style = node.getAttribute('style') || '';
  if (!liftedFontColor && (!style || !/color|background/i.test(style))) return;
  let changed = Boolean(liftedFontColor);
  const kept = [];
  for (const decl of style ? splitDeclarations(style) : []) {
    const i = decl.indexOf(':');
    if (i < 0) { if (decl.trim() !== '') kept.push(decl); continue; }
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!PAPER_PROPS.has(prop)) { kept.push(decl); continue; }
    if (!dark) {
      // v3.8.11: only near-black `color:` is dropped; everything else stays and counts.
      if (prop === 'color' && isNearBlackColor(value)) { changed = true; continue; }
      paperTriggers += 1;
      kept.push(decl);
      continue;
    }
    if (prop === 'color') {
      const next = mapTextColor(value, ctx);
      if (next === null) { changed = true; continue; }
      if (next !== value) { kept.push(`color:${next}`); changed = true; } else kept.push(decl);
      continue;
    }
    if (prop === 'background-color') {
      if (isNonAuthorialColor(value, { ...ctx, prop })) { changed = true; continue; }
      paperTriggers += 1;
      kept.push(decl);
      continue;
    }
    // background shorthand
    if (backgroundHasAuthorialColor(value, ctx)) { paperTriggers += 1; kept.push(decl); } else changed = true;
  }
  if (liftedFontColor) kept.push(`color:${liftedFontColor}`);
  if (!changed) return;
  const next = kept.join(';');
  if (next.replace(/[;\s]/g, '') === '') node.removeAttribute('style');
  else node.setAttribute('style', next);
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!neutralizeMode || !node.getAttribute) return;
  neutralizeNode(node);
});

/**
 * Sanitized HTML rendering for email/description bodies. Theme-gated: in dark
 * mode the neutraliser v2 above maps/drops non-authorial colours and the
 * body is stamped `--themed` (no paper triggers) or `--paper`; in light mode
 * only near-black text is dropped (v3.8.11). Memoised on [html, isDark] so a
 * theme flip re-sanitises exactly once.
 */
export function SafeHtml({ html, className = '' }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  // Memoized: parents re-render often (SSE ticks, composer keystrokes) and
  // re-sanitizing a long thread body each time was pure waste.
  const { clean, variantClass } = useMemo(() => {
    let sanitized;
    let triggers = 0;
    neutralizeMode = isDark ? 'dark' : 'light';
    paperTriggers = 0;
    try {
      sanitized = DOMPurify.sanitize(String(html || ''), {
        FORBID_TAGS: ['style', 'form', 'input', 'button'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload'],
        ADD_ATTR: ['target'],
      });
      triggers = paperTriggers;
    } finally {
      neutralizeMode = null;
      paperTriggers = 0;
    }
    return {
      clean: sanitized,
      variantClass: triggers > 0 ? 'tp-rich-body--paper' : 'tp-rich-body--themed',
    };
  }, [html, isDark]);
  return (
    <div
      // Dark mode (Phase DW, QA 08-31 #5 / QA 09-01 #6): conditional rendering.
      // Bodies with no surviving author BACKGROUNDS get `--themed` (fully
      // dark-themed via index.css; author text colours were mapped to read on
      // the dark ground); bodies with real coloured backgrounds get `--paper`
      // (dimmed slate panel — never pure white). The base `tp-rich-body` class
      // keeps the shared layout rules (overflow containment, data tables).
      // Light mode is unchanged. The `[&_a]` blue is the light value; the
      // themed dark link colour comes from `.dark .tp-rich-body--themed a`.
      className={`tp-rich-body ${variantClass} text-sm text-foreground/85 break-words [&_a]:text-blue-600 [&_a]:underline [&_img]:max-w-full [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ${className}`}
      // Sanitized above with DOMPurify — the only way to render email HTML faithfully.
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

const STATE_CHIP_STYLES = {
  new: { label: 'New', dot: 'bg-blue-500' },
  response_due: { label: 'Response due', dot: 'bg-amber-500' },
  requester_responded: { label: 'Requester replied', dot: 'bg-sky-500' },
  overdue: { label: 'Overdue', dot: 'bg-red-500' },
};

/**
 * Derived at-a-glance state (computed server-side as `stateChip`). Rendered as a
 * small colored dot with a tooltip — the verbose "RESPONSE DUE" pill was noise
 * on the subject line; the color carries the signal, the title carries the word.
 */
export function StateChip({ state, className = '' }) {
  const def = STATE_CHIP_STYLES[state];
  if (!def) return null;
  return (
    <span
      title={def.label}
      aria-label={def.label}
      role="img"
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${def.dot} ${className}`}
    />
  );
}

/**
 * Queue "State" column (Mega 08-30 Phase QX — QA 08-27 #3): the FS-style
 * "who acts next" state, computed server-side as `state` with the precedence
 * requester_responded > response_due > new (see ticketService
 * deriveQueueState — NOT the SLA-clock precedence of `stateChip` above).
 * Tones stay in the STATE_CHIP_STYLES family so the dot and the pill agree.
 */
export const QUEUE_STATE_STYLES = {
  new: { label: 'New', tone: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200', hint: 'unassigned and no agent reply yet' },
  response_due: { label: 'Response due', tone: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200', hint: 'a first response is still owed to the requester' },
  requester_responded: { label: 'Requester replied', tone: 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-200', hint: 'the last public message came from the requester' },
};
export const QUEUE_STATE_NOTE = 'First-response history is incomplete for some older FreshService tickets — those show "—" rather than a guess.';

/**
 * Labelled pill for the queue State column — StatusPill geometry so the two
 * columns sit at the same height. Null/unknown state renders a quiet "—"
 * (terminal, paused, or unknowable history) with the caveat in its tooltip.
 */
export function QueueStatePill({ state, className = '' }) {
  const def = QUEUE_STATE_STYLES[state];
  if (!def) {
    return (
      <span
        className={`text-xs text-muted-foreground/50 ${className}`}
        title={`No state — resolved, closed, paused, or the reply history is unknown. ${QUEUE_STATE_NOTE}`}
        aria-label="No state"
      >
        —
      </span>
    );
  }
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${def.tone} ${className}`}
      title={`${def.label} — ${def.hint}. ${QUEUE_STATE_NOTE}`}
    >
      <span className="truncate">{def.label}</span>
    </span>
  );
}

/**
 * Featured custom-field chip (Custom Fields Activation Phase 2): the ONE
 * per-workspace definition flagged isFeatured renders as a quiet slate
 * "Label: value" chip on queue rows (compact + roomy) and in the peek
 * Details. Truncated to ~24 chars with the full text in the tooltip.
 */
export function FeaturedFieldChip({ def, value, className = '' }) {
  if (!def || value === null || value === undefined || value === '') return null;
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  const full = `${def.label}: ${text}`;
  const shown = full.length > 24 ? `${full.slice(0, 23)}…` : full;
  return (
    <span
      title={full}
      data-testid="featured-field-chip"
      className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full bg-muted border border-border text-[10px] font-medium text-muted-foreground whitespace-nowrap ${className}`}
    >
      {shown}
    </span>
  );
}

// Registry color tokens → tile/text tones. Keep keys in sync with the backend
// ticketTypeService COLORS whitelist.
export const TYPE_COLOR_TONES = {
  slate: { tile: 'bg-muted text-muted-foreground', text: 'text-muted-foreground' },
  orange: { tile: 'bg-orange-100 dark:bg-orange-500/20 text-orange-600 dark:text-orange-300', text: 'text-orange-600 dark:text-orange-300' },
  violet: { tile: 'bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-300', text: 'text-violet-600 dark:text-violet-300' },
  red: { tile: 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-300', text: 'text-red-600 dark:text-red-300' },
  blue: { tile: 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300', text: 'text-blue-600 dark:text-blue-300' },
  emerald: { tile: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300', text: 'text-emerald-600 dark:text-emerald-300' },
  amber: { tile: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200', text: 'text-amber-700 dark:text-amber-200' },
  cyan: { tile: 'bg-cyan-100 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-300', text: 'text-cyan-600 dark:text-cyan-300' },
  pink: { tile: 'bg-pink-100 dark:bg-pink-500/20 text-pink-600 dark:text-pink-300', text: 'text-pink-600 dark:text-pink-300' },
};

/**
 * Ticket type as a Linear-style glyph tile + plain text — no pill (pills wrap
 * and read as noise at row density; a small colored glyph scans faster).
 * Styling (color + abbreviation) comes from the workspace's ticket-type
 * registry; unknown/legacy values fall back to the old INC/REQ heuristic so
 * historical strings still render.
 */
export function TypePill({ type, full = false }) {
  const { typeByName } = useTicketTypes();
  if (!type) return null;
  const def = typeByName(type);
  const isIncident = /incident/i.test(type);
  const tone = TYPE_COLOR_TONES[def?.color]
    || (isIncident ? TYPE_COLOR_TONES.orange : TYPE_COLOR_TONES.violet);
  const Icon = (def ? def.color === 'orange' || def.color === 'red' : isIncident) ? Zap : ClipboardList;
  // Rows use short codes (INC/CASE/REQ…) so the column stays tiny; the glyph
  // and tooltip carry the meaning. `full` spells it out where space allows.
  const abbrev = def?.abbreviation || (isIncident ? 'INC' : 'REQ');
  const label = full ? type : abbrev;
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 whitespace-nowrap" title={type}>
      <span
        aria-hidden="true"
        className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-[5px] flex-shrink-0 ${tone.tile}`}
      >
        <Icon className="w-3 h-3" strokeWidth={2.4} />
      </span>
      <span className={full
        ? 'truncate text-[11px] font-medium text-muted-foreground'
        : `text-[10px] font-bold tracking-widest ${tone.text}`}
      >
        {label}
      </span>
    </span>
  );
}

// Tag palette (gap plan P1) — named keys map to soft chip tones. Keep in sync
// with the backend TAG_COLORS whitelist.
export const TAG_CHIP_TONES = {
  slate: 'bg-muted text-muted-foreground border-border',
  red: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30',
  orange: 'bg-orange-50 dark:bg-orange-500/15 text-orange-700 dark:text-orange-200 border-orange-200 dark:border-orange-500/30',
  amber: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30',
  emerald: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30',
  sky: 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-200 border-sky-200 dark:border-sky-500/30',
  blue: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-500/30',
  violet: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-200 dark:border-violet-500/30',
  pink: 'bg-pink-50 dark:bg-pink-500/15 text-pink-700 dark:text-pink-200 border-pink-200 dark:border-pink-500/30',
};

export function TagChip({ tag, size = 'sm', onRemove = null, className = '' }) {
  if (!tag) return null;
  const tone = TAG_CHIP_TONES[tag.color] || TAG_CHIP_TONES.slate;
  const pad = size === 'xs' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap ${pad} ${tone} ${className}`}>
      {tag.name}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(tag); }}
          aria-label={`Remove tag ${tag.name}`}
          className="tp-focus-ring rounded-full leading-none opacity-60 hover:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Countdown label + tone for an SLA deadline. */
export function dueIn(value) {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return null;
  const diffMin = Math.round((target - Date.now()) / 60000);
  const abs = Math.abs(diffMin);
  const span = abs < 60 ? `${abs}m` : abs < 48 * 60 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  if (diffMin < 0) return { label: `Overdue ${span}`, state: 'over' };
  if (diffMin < 4 * 60) return { label: `${span} left`, state: 'warn' };
  return { label: `${span} left`, state: 'ok' };
}

export function SlaChip({ value, paused = false, calendarAware = false, className = '' }) {
  // Pending tickets pause the SLA clock: neutral "Paused" chip, no countdown,
  // no overdue red — the requester (or a third party) holds the ball.
  if (paused) {
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap bg-muted text-muted-foreground ${className}`} title="SLA paused while the ticket is pending">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" aria-hidden="true" />
        Paused
      </span>
    );
  }
  const info = dueIn(value);
  if (!info) return null;
  // Calendar-aware workspaces (Phase SLA): the stored due date already skips
  // weekends/holidays, so the tooltip just explains WHICH clock stamped it.
  const clockTitle = calendarAware
    ? 'Business-hours clock — this due date only counts business hours (weekends and holidays don’t)'
    : undefined;
  // Softer, borderless urgency pills with a leading colored dot (mockup style):
  // red overdue, amber due-soon, green plenty-of-time.
  const tone = info.state === 'over'
    ? 'bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-300'
    : info.state === 'warn'
      ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200'
      : 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200';
  const dot = info.state === 'over' ? 'bg-red-500' : info.state === 'warn' ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${tone} ${className}`} title={clockTitle}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {info.label}
    </span>
  );
}

/**
 * Terminal-aware state for one SLA target row (first response / resolution).
 *
 * States:
 *  - 'met'     → fulfilled at/before the target (fulfillment time known)
 *  - 'late'    → fulfilled after the target — a historical fact, not an alarm
 *  - 'unknown' → ticket already resolved/closed but we never learned when (or
 *                whether) the target was met (sparse FS data) — never "Overdue"
 *  - 'live'    → ticket still open; the countdown/overdue chip applies
 */
export function slaTargetState({ target, metAt = null, isTerminal = false }) {
  if (!target) return null;
  const targetMs = new Date(target).getTime();
  if (Number.isNaN(targetMs)) return null;
  if (metAt) {
    const metMs = new Date(metAt).getTime();
    if (!Number.isNaN(metMs)) {
      return { state: metMs <= targetMs ? 'met' : 'late', deltaMs: metMs - targetMs };
    }
  }
  return { state: isTerminal ? 'unknown' : 'live' };
}

/** Compact duration label for tooltip deltas ("45m", "7h", "3d"). */
function slaSpan(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

const SLA_TARGET_DATETIME = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };

/**
 * SLA chip for a target row that knows about terminal tickets. Live tickets
 * defer to SlaChip (countdown / overdue / paused); once the target is met or
 * the ticket is closed, the chip freezes into a historical outcome — a closed
 * ticket must never show a running "Overdue Nd".
 *
 * kind: 'response' (first response) | 'resolution'.
 */
export function SlaTargetChip({ target, metAt = null, status, kind = 'response', className = '', terminal = null, paused = null, calendarAware = false }) {
  // `terminal` / `paused` (optional, Phase 8b): base-aware overrides from the
  // workspace status registry so a custom Resolved-base status freezes the
  // chip and a custom Pending-base status pauses it. `calendarAware` (Phase
  // SLA) only decorates the LIVE countdown with the business-hours tooltip.
  const isTerminal = terminal ?? ['Resolved', 'Closed'].includes(status);
  const info = slaTargetState({ target, metAt, isTerminal });
  if (!info) return null;
  if (info.state === 'live') {
    return <SlaChip value={target} paused={paused ?? status === 'Pending'} calendarAware={calendarAware} className={className} />;
  }
  const base = `inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap border ${className}`;
  const targetLabel = new Date(target).toLocaleString(undefined, SLA_TARGET_DATETIME);
  const noun = kind === 'resolution' ? 'Resolution' : 'First response';
  if (info.state === 'unknown') {
    const title = `${noun} target was ${targetLabel}. The ticket is ${String(status).toLowerCase()} and this timestamp wasn't tracked, so it can't be marked met or missed.`;
    return (
      <span className={`${base} bg-muted/50 text-muted-foreground/75 border-border`} title={title} aria-label={title}>
        —
      </span>
    );
  }
  const metLabel = new Date(metAt).toLocaleString(undefined, SLA_TARGET_DATETIME);
  const verb = kind === 'resolution' ? 'Resolved' : 'Responded';
  if (info.state === 'met') {
    return (
      <span
        className={`${base} bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30`}
        title={`${verb} ${metLabel} — ${slaSpan(info.deltaMs)} before the ${targetLabel} target`}
      >
        {kind === 'resolution' ? 'Done' : 'Met'}
      </span>
    );
  }
  return (
    <span
      className={`${base} bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30`}
      title={`${verb} ${metLabel} — ${slaSpan(info.deltaMs)} after the ${targetLabel} target`}
    >
      {kind === 'resolution' ? 'Resolved late' : 'Met late'}
    </span>
  );
}

export function timeAgo(value) {
  if (!value) return '—';
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '—';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/**
 * Relative-only sibling of timeAgo: keeps counting past the 7-day mark
 * ("9d ago", "3w ago", "5mo ago", "2y ago") instead of falling back to a
 * date. For surfaces that already show the absolute date on another line —
 * the queue's Created column paired this with a date-only primary and, once
 * a ticket was a week old, both lines read "Aug 17" (QA 08-24 #2).
 */
export function timeAgoShort(value) {
  if (!value) return '—';
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '—';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * "Jul 27, 3:42 PM" — with the year spelled out ("Jul 27, 2025, 3:42 PM")
 * whenever the date isn't in the current year (QA 08-04 #17a: a year-less
 * "Jul 27" on an old ticket read as this year). Same rule timeAgo uses.
 */
export function formatDayTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleString(undefined, opts);
}

/** Date-only sibling of formatDayTime: "Jul 27", or "Jul 27, 2025" off-year. */
export function formatDay(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';
}

/**
 * Status pill. `tone` (optional) is a resolved bg/text class pair from the
 * workspace status registry — see statusDefs.statusToneFromDefs (Phase 8b):
 * custom statuses and recolored system rows pass their token tone here;
 * absent/null keeps the classic STATUS_COLORS palette with the tolerant
 * slate fallback for unknown labels.
 */
export function StatusPill({ status, className = '', size = 'md', tone: toneOverride = null }) {
  const tone = toneOverride || STATUS_COLORS[status] || 'bg-muted text-muted-foreground';
  // Deleted/Spam are terminal removals — solid red/orange + icon so they read as
  // "removed", not a quiet grey chip. `size='sm'` (dense queue rows) keeps it
  // compact so it fits its column; `md` (headers) is more prominent.
  const isRemoved = status === 'Deleted' || status === 'Spam';
  if (isRemoved) {
    const sm = size === 'sm';
    return (
      <span className={`inline-flex items-center ${sm ? 'gap-0.5 px-1.5 text-[10px]' : 'gap-1 px-2.5 text-xs tracking-wide shadow-sm'} py-0.5 rounded-full font-bold uppercase whitespace-nowrap ${tone} ${className}`}>
        <Ban className={sm ? 'w-3 h-3' : 'w-3.5 h-3.5'} aria-hidden="true" />
        {status}
      </span>
    );
  }
  // Custom FS statuses can be long ("Waiting on Customer") — clamp to the
  // pill's container instead of bleeding into the neighbouring column.
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${tone} ${className}`}
      title={status}
    >
      <span className="truncate">{status}</span>
    </span>
  );
}

export function PriorityDot({ priority, withLabel = false, title = null }) {
  const color = PRIORITY_STRIP_COLORS[priority] || 'bg-muted-foreground/40';
  const label = PRIORITY_LABELS[priority] || `P${priority}`;
  return (
    <span className="inline-flex items-center gap-1.5" title={title || `Priority: ${label}`}>
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${color}`} />
      {withLabel && <span className="text-xs font-medium text-muted-foreground">{label}</span>}
      {!withLabel && <span className="sr-only">{label} priority</span>}
    </span>
  );
}

/**
 * Agent name that renders first-name-only below xl (the tablet band shrinks the
 * assignee column to ~120px — QA 08-04 #5/#6 asked for first names on iPad) and
 * the full name at xl+. Purely a display treatment: the full name always lives
 * in the title tooltip and the underlying data is untouched.
 */
export function AgentFirstName({ name, className = '' }) {
  const full = String(name || '').trim();
  if (!full) return null;
  const first = full.split(/\s+/)[0];
  return (
    <span className={`min-w-0 truncate ${className}`} title={full}>
      <span className="xl:hidden">{first}</span>
      <span className="hidden xl:inline">{full}</span>
    </span>
  );
}

/** Where a ticket was born: Ticket Pulse or FreshService. */
// Requester email domain is outside the workspace's trusted list — flag it so
// agents treat links/attachments with more care (QA 07-27 #4). Amber, not red:
// external ≠ malicious, it just deserves a second look.
export function ExternalChip() {
  // shrink-0 + nowrap: in tight queue rows (iPad band) the chip must wrap as a
  // unit, never compress letter-by-letter into the category column (QA 08-04 #5).
  return (
    <span
      className="shrink-0 whitespace-nowrap inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-500/40"
      title="The requester's email domain is outside this workspace's trusted domains (Settings → Ticket Ops → Trusted domains)"
    >
      <Globe className="w-3 h-3" aria-hidden="true" />
      External
    </span>
  );
}

export function OriginChip({ origin }) {
  if (origin === 'ticketpulse') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-200 border border-sky-200 dark:border-sky-500/30">
        <TicketIcon className="w-3 h-3" aria-hidden="true" />
        Ticket Pulse
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-muted text-muted-foreground border border-border">
      FreshService
    </span>
  );
}

// How the current assignee got there: self-pickup, AI auto-assign, a manual
// assignment in FreshService, or a manual assignment by a coordinator in TP.
// Best-effort from assignedBy/isSelfPicked/origin (mirrors analyticsService's
// assignmentSource classification). Renders nothing when unassigned.
export function assignmentProvenance(ticket) {
  if (!ticket?.assignedTechId) return null;
  const by = String(ticket.assignedBy || '').trim();
  const name = ticket.assignedTech?.name || '';
  if (ticket.isSelfPicked || (by && name && by === name)) {
    return { key: 'self', label: 'Self-assigned', Icon: UserRound, cls: 'bg-muted text-muted-foreground border-border', title: `${name || 'The assignee'} picked this ticket up` };
  }
  if (by === 'Ticket Pulse') {
    return { key: 'ai', label: 'AI-assigned', Icon: Sparkles, cls: 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 border-indigo-200 dark:border-indigo-500/30', title: 'Auto-assigned by the Ticket Pulse AI pipeline' };
  }
  if (ticket.origin !== 'ticketpulse' && !by) {
    return { key: 'fs', label: 'Assigned in FreshService', Icon: Cloud, cls: 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-200 border-sky-200 dark:border-sky-500/30', title: 'This assignment came from FreshService' };
  }
  if (by) {
    return { key: 'manual', label: `Assigned by ${by}`, Icon: UserCog, cls: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-500/30', title: `Manually assigned by ${by}` };
  }
  return null;
}

export function ProvenanceChip({ ticket, iconOnly = false }) {
  const p = assignmentProvenance(ticket);
  if (!p) return null;
  const { label, Icon, cls, title } = p;
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cls}`}>
      <Icon className="w-3 h-3" aria-hidden="true" />
      {!iconOnly && label}
    </span>
  );
}

/** Fallback-mirror state for TP-born tickets. */
export function MirrorChip({ ticket }) {
  if (ticket?.origin !== 'ticketpulse') return null;
  const state = ticket.mirrorState;
  if (state === 'mirrored') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-500/30" title="A fallback copy exists in FreshService">
        <Cloud className="w-3 h-3" aria-hidden="true" /> Mirrored
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border border-red-200 dark:border-red-500/30" title={ticket.mirrorError || 'Mirroring to FreshService failed'}>
        <CloudOff className="w-3 h-3" aria-hidden="true" /> Mirror error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted/50 text-muted-foreground border border-border" title="Queued for the FreshService fallback mirror (arrives with the mirror phase)">
      <CloudUpload className="w-3 h-3" aria-hidden="true" /> Mirror pending
    </span>
  );
}

/**
 * "Empty seat" marker: unassigned should pull the eye, not read as body text.
 * Amber dashed ring + UserPlus glyph, optional label.
 */
// Unassigned indicator. Two moods, driven by whether assignment is actionable here:
//  - 'interactive' (default): reads as a call-to-action ("Assign"), neutral slate
//    that warms to blue on the parent's hover (the picker button carries `group`).
//  - 'muted': a quiet, passive "Unassigned" for read-only rows (e.g. FS-born in the
//    queue) where you can't assign inline — no hover, dimmer, clearly non-actionable.
// Deliberately not amber: in an all-unassigned view the old yellow pill on every row
// was noisy and repetitive.
export function UnassignedBadge({ size = 'h-6 w-6', withLabel = true, labelClass = 'text-xs', variant = 'interactive' }) {
  const muted = variant === 'muted';
  return (
    <span
      className="inline-flex items-center gap-1.5 min-w-0"
      title={muted ? 'Unassigned — managed in FreshService' : 'Unassigned — click to assign'}
    >
      <span
        aria-hidden="true"
        className={`${size} rounded-full border-[1.5px] border-dashed inline-flex items-center justify-center flex-shrink-0 transition-colors ${
          muted
            ? 'border-input text-muted-foreground/50'
            : 'border-input text-muted-foreground/75 group-hover:border-blue-400 group-hover:text-blue-500'
        }`}
      >
        <UserPlus className="w-3 h-3" strokeWidth={2.2} />
      </span>
      {withLabel
        ? (
          <span className={`${labelClass} font-medium truncate ${muted ? 'text-muted-foreground/75' : 'text-muted-foreground group-hover:text-blue-600 dark:group-hover:text-blue-300'}`}>
            {muted ? 'Unassigned' : 'Assign'}
          </span>
        )
        : <span className="sr-only">Unassigned</span>}
    </span>
  );
}

export function PersonAvatar({ name, photoUrl, size = 'h-6 w-6', textSize = 'text-[10px]' }) {
  // A photo URL that fails to load (no directory photo, expired token, offline) must not leave an empty
  // circle — fall back to initials, exactly as if no photo had been supplied.
  const [failedUrl, setFailedUrl] = useState(null);
  if (photoUrl && failedUrl !== photoUrl) {
    return <img src={photoUrl} alt="" onError={() => setFailedUrl(photoUrl)} className={`${size} rounded-full object-cover ring-1 ring-border`} />;
  }
  if (!name) {
    return (
      <span className={`${size} rounded-full bg-muted text-muted-foreground/75 inline-flex items-center justify-center`}>
        <UserRound className="w-3.5 h-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={`${size} rounded-full bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border border-blue-100 dark:border-blue-500/20 inline-flex items-center justify-center font-semibold ${textSize}`}>
      {initials(name)}
    </span>
  );
}

// ── Ticket reference link ─────────────────────────────────────────────────────
// The in-app /tickets/:id page is the PRIMARY destination (migration off
// FreshService); FS is kept one click away as a small external icon, and is the
// only target when there's no internal id. Ref label mirrors the server's
// ticketDisplayRef rule (TP-<n> for TP-born, #<fsId> otherwise).

export function ticketRefLabel(ticket) {
  if (!ticket) return '—';
  if (ticket.origin === 'ticketpulse' && ticket.nativeNumber !== null && ticket.nativeNumber !== undefined) {
    return `TP-${ticket.nativeNumber}`;
  }
  if (ticket.freshserviceTicketId) return `#${ticket.freshserviceTicketId}`;
  return ticket.id ? `TP-ID-${ticket.id}` : '—';
}

export function ticketFsUrl(ticket) {
  return ticket?.freshserviceTicketId
    ? `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`
    : null;
}

export function TicketRefLink({
  ticket,
  label,
  className = 'text-[11px]',
  linkClassName = 'font-medium text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200',
  showFsIcon = true,
  iconClassName = 'h-2.5 w-2.5',
  onNavigate,
  // Optional router location state passed to the internal link — lets origin
  // pages (e.g. the agent page) hand /tickets/:id a `{ from }` return address.
  state,
}) {
  const internalHref = ticket?.id ? `/tickets/${ticket.id}` : null;
  const fsUrl = ticketFsUrl(ticket);
  const text = label ?? ticketRefLabel(ticket);
  const stop = (e) => { e.stopPropagation(); onNavigate?.(); };
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      {internalHref ? (
        <Link to={internalHref} state={state} title="Open in Ticket Pulse" className={`min-w-0 truncate ${linkClassName}`} onClick={stop}>
          {text}
        </Link>
      ) : (
        <a href={fsUrl || '#'} target="_blank" rel="noopener noreferrer" className={`min-w-0 truncate ${linkClassName}`} onClick={(e) => e.stopPropagation()}>
          {text}
        </a>
      )}
      {showFsIcon && fsUrl && internalHref && (
        <a
          href={fsUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in FreshService"
          className="flex-shrink-0 text-blue-300 dark:text-blue-500/60 hover:text-blue-600 dark:hover:text-blue-300"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className={iconClassName} aria-hidden="true" />
        </a>
      )}
    </span>
  );
}
