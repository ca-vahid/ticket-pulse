#!/usr/bin/env node
/**
 * Generate Ticket Pulse brand mockups using the OpenAI Image API.
 *
 * For each "concept" (logo idea, hero illustration, background, icon) the
 * script asks the model for N visual variants in a single call (n=4 by
 * default) so a reviewer can mix-and-match. Outputs land under
 * frontend/public/branding-mockups/<category>/<concept>-v<i>.png plus a
 * manifest.json and an index.html viewer that groups variants by concept.
 *
 * Usage:
 *   $env:OPENAI_API_KEY="sk-..."; node scripts/generate-brand-assets.mjs
 *   OPENAI_API_KEY=sk-... node scripts/generate-brand-assets.mjs --resume
 *   OPENAI_API_KEY=sk-... node scripts/generate-brand-assets.mjs --only logo
 *
 * Flags:
 *   --resume           Skip concepts whose -v1.png already exists.
 *   --only <cat>       Only run a category (logo|hero|background|icon).
 *                      Repeatable (e.g. --only logo --only icon).
 *   --model <name>     Override model (default: gpt-image-2; also: gpt-image-1,
 *                      gpt-image-1-mini, gpt-image-1.5).
 *   --quality <lvl>    low | medium | high | auto  (default: medium)
 *   --variants N       Variants per concept (default 4, max 10).
 *   --concurrency N    Parallel concepts (default 2).
 *   --dry-run          Print the plan and exit (no API calls).
 *
 * Output:
 *   frontend/public/branding-mockups/
 *     logo/*-v1.png ... -v4.png
 *     hero/*-v1.png ... -v4.png
 *     background/*-v1.png ... -v4.png
 *     icon/*-v1.png ... -v4.png
 *     manifest.json
 *     index.html       (review viewer; rewritten on every run)
 *
 * Cost: gpt-image-2 medium-quality is roughly $0.04-$0.05 per image.
 * The default 16-concepts × 4-variants = 64 images run is ~$3.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(REPO_ROOT, 'frontend', 'public', 'branding-mockups');

const args = parseArgs(process.argv.slice(2));

if (!process.env.OPENAI_API_KEY && !args.dryRun) {
  console.error('ERROR: OPENAI_API_KEY env var is required.');
  console.error('  PowerShell:  $env:OPENAI_API_KEY="sk-..."; node scripts/generate-brand-assets.mjs');
  console.error('  bash/zsh:    OPENAI_API_KEY=sk-... node scripts/generate-brand-assets.mjs');
  process.exit(1);
}

const MODEL = args.model || 'gpt-image-2';
const QUALITY = args.quality || 'medium';
const CONCURRENCY = Math.max(1, Number(args.concurrency || 2));
const VARIANTS = Math.min(10, Math.max(1, Number(args.variants || 4)));
const ONLY = new Set((args.only || []).map(s => s.toLowerCase()));

// gpt-image-2 doesn't support background:transparent; the gpt-image-1 family does.
const SUPPORTS_TRANSPARENT = MODEL === 'gpt-image-1' || MODEL === 'gpt-image-1-mini' || MODEL === 'gpt-image-1.5';

// --- Brand vocabulary -------------------------------------------------------
//
// Ticket Pulse = real-time IT helpdesk dashboard. Visual language:
//   * "Pulse" → EKG / heartbeat line, soft glow, motion
//   * "Ticket" → modern flat ticket / tag with notch
//   * Tone   → calm, modern, professional, never cartoony
// Color palette anchored on Tailwind defaults already used in the app:
//   slate-900 (#0f172a) base, indigo-500 (#6366f1), teal-400 (#2dd4bf),
//   plus the workload accents emerald-500/amber-500/red-500.
const PALETTE = 'Color palette: deep slate navy (#0f172a) base, vibrant indigo (#6366f1) and teal (#2dd4bf) accents, soft white highlights. Optional accent dots in emerald (#10b981), amber (#f59e0b), red (#ef4444) suggesting workload levels.';
const STYLE_LOGO = 'Modern, minimal, tech-forward. Crisp vector-style lines, geometric, professional, suitable for a SaaS app. Absolutely no extra text, no taglines, no watermarks beyond what is explicitly described. Pixel-precise edges, high contrast.';
const STYLE_ICON = 'Flat vector-style icon, rounded geometry, no text, no shadows beyond a subtle soft glow if needed, centered composition with even padding, suitable for a dashboard UI at 64-128px display size.';
const STYLE_HERO = 'Modern editorial illustration for a SaaS marketing page hero. Clean composition, generous negative space, soft ambient lighting, no text or labels, no UI mockup chrome, no faces with distorted features.';
const STYLE_BG = 'Subtle abstract background suitable for use behind UI content. Very low visual noise so text remains readable when overlaid. Smooth gradients, no text, no logos, no faces, no central focal point.';

// --- Asset definitions -------------------------------------------------------
// Each entry is one CONCEPT. The script will request N variants per concept
// in a single API call (n=N), so the model produces N different takes on the
// same idea. transparent=true means "should be ready to use as transparent
// PNG" - on gpt-image-2 (which can't do transparent backgrounds) we instead
// instruct the model to put the asset on a clean pure-white background that
// can be keyed out later.
const ASSETS = [
  // ----------------- LOGOS (4 concepts × 4 variants = 16) -----------------
  {
    category: 'logo',
    name: 'logo-01-wordmark-pulse',
    size: '1536x1024',
    transparent: true,
    prompt: `${STYLE_LOGO} ${PALETTE}
Design a horizontal wordmark logo for an app called "Ticket Pulse".
Layout: a clean lowercase wordmark "ticket pulse" in a modern geometric sans-serif (think Inter / Geist), set in dark slate. To the LEFT of the wordmark, a small icon mark: a single continuous EKG heartbeat line passing through the silhouette of a help-desk ticket / tag with a notch on its left edge. The heartbeat line glows softly in indigo-to-teal gradient. Generous padding around all sides. Spell the brand exactly as "ticket pulse" with no extra characters or punctuation.`,
  },
  {
    category: 'logo',
    name: 'logo-02-icon-mark-pulse-ticket',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_LOGO} ${PALETTE}
Design an ICON-ONLY app mark (no text whatsoever) for "Ticket Pulse".
Concept: a rounded-square ticket shape with a notch on its left edge, rendered as a glassy card in deep indigo-to-teal gradient. A bright single-stroke EKG heartbeat line cuts across the middle of the ticket horizontally and extends slightly past the edges. Subtle soft glow. Symmetrical and balanced, suitable as a 512px app icon and favicon.`,
  },
  {
    category: 'logo',
    name: 'logo-03-monogram-tp',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_LOGO} ${PALETTE}
Design a circular monogram emblem for "Ticket Pulse".
A perfect circle filled with a smooth indigo-to-teal radial gradient. Inside, the letters "TP" in a custom geometric sans-serif, set in clean white, with the crossbar of the T extending into a small EKG pulse spike that becomes the top of the P. Minimal, balanced, high contrast. Pixel-crisp edges. The only text shown anywhere is the two-letter monogram "TP".`,
  },
  {
    category: 'logo',
    name: 'logo-04-flat-badge',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_LOGO} ${PALETTE}
Design a bold flat icon badge for "Ticket Pulse" suitable for a favicon and PWA install icon.
Square with strongly rounded corners (iOS-style). Background of the badge: solid deep slate navy (#0f172a) with a faint indigo radial highlight. Foreground: a stylized white ticket silhouette (rounded rectangle with a single notch) and a vivid teal heartbeat line passing through it. No text on the badge. Centered composition, even padding, perfectly symmetrical.`,
  },

  // ----------------- HERO / DASHBOARD GRAPHICS (3 concepts × 4 variants = 12) -----------------
  {
    category: 'hero',
    name: 'hero-01-isometric-team',
    size: '1536x1024',
    transparent: false,
    prompt: `${STYLE_HERO} ${PALETTE}
A modern isometric illustration showing a small team of IT technicians (3-4 people, gender and skin-tone diverse, no detailed faces) collaborating around a large floating semi-transparent dashboard panel that displays glowing rows representing live help desk tickets. Above the dashboard, a continuous EKG heartbeat line floats across the scene, connecting the ticket rows. Soft ambient lighting, gentle drop shadows, light slate background that fades to white at the bottom. No real text on the dashboard - only abstract bars and dots. No logos. Calm, optimistic mood. Wide landscape composition with generous negative space on the right for marketing copy.`,
  },
  {
    category: 'hero',
    name: 'hero-02-abstract-data-flow',
    size: '1536x1024',
    transparent: false,
    prompt: `${STYLE_HERO} ${PALETTE}
An abstract dark-mode hero illustration. Background: deep slate navy with a subtle starfield of tiny indigo dots. Foreground: a smooth, glowing EKG-style pulse line sweeps across the entire frame from left to right. Floating along the line, a series of softly glowing translucent ticket cards (rounded rectangles with notches), each tinted slightly differently in indigo, teal, emerald, and amber, suggesting a stream of incoming help desk tickets being routed in real time. Subtle bokeh and light bloom. No text on the cards. Dramatic but professional, suitable for a dark-mode dashboard hero or marketing site.`,
  },
  {
    category: 'hero',
    name: 'hero-03-friendly-flat-coordinator',
    size: '1536x1024',
    transparent: false,
    prompt: `${STYLE_HERO} ${PALETTE}
A friendly modern flat illustration of a single IT coordinator at a desk, viewed slightly from the side, looking calmly at a large monitor that displays an abstract dashboard: stacked horizontal bars in indigo and teal representing technicians' workloads, with small green/amber/red workload pips. Above the monitor, a faint floating EKG heartbeat line. Soft pastel palette anchored on indigo and teal, light off-white background, subtle plant in the background. Character has no detailed facial features (very minimal flat style, like a Notion or Stripe illustration). No text, no real UI labels. Wide landscape composition, character on the left, generous empty space on the right for headline text.`,
  },

  // ----------------- BACKGROUNDS (3 concepts × 4 variants = 12) -----------------
  {
    category: 'background',
    name: 'bg-01-dark-pulse-waves',
    size: '1536x1024',
    transparent: false,
    prompt: `${STYLE_BG} ${PALETTE}
A seamless dark dashboard background. Base: deep slate navy (#0f172a). Overlaid: 3-5 ultra-thin, low-opacity (around 8-12% opacity) horizontal EKG pulse waves at different vertical positions, each in a slightly different hue (indigo, teal, soft white). Add a barely visible 1px dot grid across the entire image at very low opacity. The image must be calm enough that black or white text and UI cards placed on top remain perfectly legible. No focal point, no logos, no text. Even lighting across the entire frame, edge-to-edge.`,
  },
  {
    category: 'background',
    name: 'bg-02-light-mesh-gradient',
    size: '1536x1024',
    transparent: false,
    prompt: `${STYLE_BG} ${PALETTE}
A soft light-mode dashboard background. A smooth mesh gradient blending pale indigo (#eef2ff), pale teal (#ccfbf1), and white. Add an extremely subtle 1px dot grid overlay at very low opacity for a structured technical feel. Optional: one or two extremely faint ghosted EKG pulse lines crossing horizontally at very low opacity (5-8%). The result must be calm and pale enough that dark text and dashboard cards placed on top stay perfectly readable. No focal point, no logos, no text, no characters.`,
  },
  {
    category: 'background',
    name: 'bg-03-topographic-neutral',
    size: '1536x1024',
    transparent: false,
    prompt: `${STYLE_BG} ${PALETTE}
A neutral abstract background made of very low-contrast topographic contour lines, in slate and faint indigo, on a near-white slate background (#f8fafc). The contour lines should be fluid and organic, evoking subtle data-flow imagery. Extremely low contrast so it works as a UI background under cards and text. No focal point, no logos, no text, no characters. Edge-to-edge coverage with no clear borders or framing.`,
  },

  // ----------------- ICONS (6 concepts × 4 variants = 24) -----------------
  {
    category: 'icon',
    name: 'icon-01-heartbeat-app',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_ICON} ${PALETTE}
A single app-style icon: an EKG heartbeat line (one bold continuous stroke with one or two clear pulse spikes) inside a rounded square card. The card uses an indigo-to-teal gradient. The pulse stroke is bright white with a subtle outer glow. Centered, symmetrical, even padding. No text, no extra decoration.`,
  },
  {
    category: 'icon',
    name: 'icon-02-ticket-flat',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_ICON} ${PALETTE}
A modern flat icon of a single help-desk ticket. The ticket is a horizontally-oriented rounded rectangle with a half-circle notch cut out on the left edge, rendered as a clean indigo-to-teal gradient with a faint inner highlight on top. A pair of subtle thin horizontal lines on the right side suggest text content (no actual text). Centered, symmetrical, generous padding.`,
  },
  {
    category: 'icon',
    name: 'icon-03-sync-refresh',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_ICON} ${PALETTE}
A flat icon of two circular arrows forming a sync / refresh loop. Stroke is medium-thick with rounded ends, gradient indigo-to-teal. A small EKG pulse spike sits at the top of the arc, hinting at "live sync". Perfectly centered, symmetrical, even padding. No text, no shadow.`,
  },
  {
    category: 'icon',
    name: 'icon-04-technician-headset',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_ICON} ${PALETTE}
A flat icon representing an IT technician. A simple rounded silhouette of a person from chest up wearing a headset with a small mic boom. Filled with an indigo-to-teal gradient. No detailed facial features (just a clean silhouette). No text, centered composition, even padding, suitable as a navigation icon.`,
  },
  {
    category: 'icon',
    name: 'icon-05-workload-meter',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_ICON} ${PALETTE}
A flat icon depicting a workload gauge. Three rising vertical bars of increasing height, left-to-right, colored emerald (#10b981), amber (#f59e0b), red (#ef4444), with rounded tops. Behind them, a faint thin EKG pulse line crosses the icon horizontally at mid-height. No text, no axis lines. Centered composition, even padding.`,
  },
  {
    category: 'icon',
    name: 'icon-06-week-calendar',
    size: '1024x1024',
    transparent: true,
    prompt: `${STYLE_ICON} ${PALETTE}
A flat icon of a 7-day week calendar. A rounded rectangle representing the calendar body with two small tabs on top (binding pegs). Inside, a 7-column grid of small rounded squares; one of them, slightly off-center, is filled with a vivid indigo-to-teal gradient to highlight "today". The rest of the squares are a very light slate outline. No numbers or text. Even padding, suitable as a 32-128px UI icon.`,
  },
];

// --- Filtering --------------------------------------------------------------
const planned = ASSETS.filter(a => ONLY.size === 0 || ONLY.has(a.category));

if (planned.length === 0) {
  console.error(`No concepts matched --only filters: ${[...ONLY].join(', ')}`);
  process.exit(1);
}

// --- Background instruction injection ----------------------------------------
// Models without transparent-background support (gpt-image-2) need an explicit
// instruction to put the subject on a clean white surface so it can be keyed
// out later if needed. Models that do support transparency get the explicit
// transparent-background hint.
function backgroundInstruction(asset) {
  if (!asset.transparent) {
    // Hero/background concepts already describe their own background in the prompt.
    return '';
  }
  if (SUPPORTS_TRANSPARENT) {
    return ' Place the design on a fully transparent background (alpha channel), with no surrounding canvas color.';
  }
  return ' Place the design centered on a perfectly solid pure white (#ffffff) background, with no shadows, gradients, or texture in the background, so the subject can be cleanly keyed out later.';
}

// --- Main -------------------------------------------------------------------
async function main() {
  const totalImages = planned.length * VARIANTS;
  console.log(`Ticket Pulse brand asset generator`);
  console.log(`  model:        ${MODEL}`);
  console.log(`  quality:      ${QUALITY}`);
  console.log(`  variants:     ${VARIANTS} per concept`);
  console.log(`  concurrency:  ${CONCURRENCY}`);
  console.log(`  resume:       ${!!args.resume}`);
  console.log(`  only:         ${ONLY.size ? [...ONLY].join(', ') : '(all)'}`);
  console.log(`  output:       ${OUT_ROOT}`);
  console.log(`  planned:      ${planned.length} concept(s) × ${VARIANTS} variant(s) = ${totalImages} image(s)`);
  if (!SUPPORTS_TRANSPARENT) {
    console.log(`  note:         ${MODEL} lacks transparent-bg support; transparent assets generated on white for keying.`);
  }
  console.log('');

  if (args.dryRun) {
    for (const a of planned) {
      console.log(`[dry-run] ${a.category}/${a.name}-v1..${VARIANTS}.png  size=${a.size}  transparent-target=${a.transparent}`);
    }
    return;
  }

  for (const cat of new Set(planned.map(a => a.category))) {
    await fs.mkdir(path.join(OUT_ROOT, cat), { recursive: true });
  }

  let nextIdx = 0;
  let completedConcepts = 0;
  let completedImages = 0;
  let failedConcepts = 0;

  async function worker(workerId) {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= planned.length) return;
      const asset = planned[myIdx];
      const variantPath = i => path.join(OUT_ROOT, asset.category, `${asset.name}-v${i}.png`);

      // Resume = if v1 exists, assume the whole concept was generated previously.
      if (args.resume) {
        try {
          await fs.access(variantPath(1));
          completedConcepts++;
          console.log(`[concept ${completedConcepts + failedConcepts}/${planned.length}] (skip) ${asset.category}/${asset.name}`);
          continue;
        } catch { /* not present, generate */ }
      }

      try {
        const prompt = asset.prompt + backgroundInstruction(asset);
        const buffers = await generateImages({ ...asset, prompt }, VARIANTS);
        for (let i = 0; i < buffers.length; i++) {
          await fs.writeFile(variantPath(i + 1), buffers[i]);
          completedImages++;
        }
        completedConcepts++;
        console.log(`[concept ${completedConcepts + failedConcepts}/${planned.length}] (worker ${workerId}) ${asset.category}/${asset.name}  → ${buffers.length} variant(s)`);
      } catch (err) {
        failedConcepts++;
        console.error(`[fail] ${asset.category}/${asset.name}: ${err.message || err}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)),
  );

  // Build manifest from what's actually on disk so resume runs stay accurate.
  const onDisk = [];
  for (const cat of new Set(ASSETS.map(a => a.category))) {
    const dir = path.join(OUT_ROOT, cat);
    let files = [];
    try { files = await fs.readdir(dir); } catch { /* dir absent */ }
    for (const f of files.filter(f => f.endsWith('.png')).sort()) {
      const m = f.match(/^(.*)-v(\d+)\.png$/);
      if (!m) continue;
      const conceptName = m[1];
      const variant = Number(m[2]);
      const meta = ASSETS.find(a => a.name === conceptName);
      onDisk.push({
        category: cat,
        concept: conceptName,
        variant,
        file: `${cat}/${f}`,
        size: meta?.size || null,
        transparent: meta?.transparent ?? null,
      });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    quality: QUALITY,
    variantsRequested: VARIANTS,
    count: onDisk.length,
    assets: onDisk,
  };
  await fs.writeFile(
    path.join(OUT_ROOT, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  await ensureViewerHtml();

  console.log('');
  console.log(`Done. ${onDisk.length} file(s) in ${OUT_ROOT}`);
  console.log(`  Concepts: ${completedConcepts}/${planned.length} (${failedConcepts} failed)`);
  console.log(`  Open frontend/public/branding-mockups/index.html (or visit /branding-mockups/ in dev) to review.`);
  if (failedConcepts > 0) {
    console.log(`Re-run with --resume to retry only the missing concepts.`);
    process.exit(2);
  }
}

// --- OpenAI Image API call --------------------------------------------------
async function generateImages(asset, n) {
  const body = {
    model: MODEL,
    prompt: asset.prompt,
    n,
    size: asset.size,
    quality: QUALITY,
    output_format: 'png',
    moderation: 'low',
  };
  if (asset.transparent && SUPPORTS_TRANSPARENT) {
    body.background = 'transparent';
  }

  // Up to 3 attempts with exponential backoff for transient 429/5xx.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
        if (!isRetryable) throw err;
        lastErr = err;
      } else {
        const json = await res.json();
        const data = json?.data;
        if (!Array.isArray(data) || data.length === 0) {
          throw new Error(`response missing data[]: ${JSON.stringify(json).slice(0, 400)}`);
        }
        const buffers = [];
        for (const d of data) {
          if (!d?.b64_json) {
            throw new Error(`response missing b64_json on a data entry: ${JSON.stringify(d).slice(0, 200)}`);
          }
          buffers.push(Buffer.from(d.b64_json, 'base64'));
        }
        return buffers;
      }
    } catch (err) {
      lastErr = err;
    }
    const delayMs = 3000 * attempt; // 3s, 6s, 9s
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastErr || new Error('unknown error');
}

// --- Mockup viewer HTML -----------------------------------------------------
async function ensureViewerHtml() {
  const viewerPath = path.join(OUT_ROOT, 'index.html');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Ticket Pulse — Brand Mockup Review</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #111c33;
      --panel-2: #0b1226;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #6366f1;
      --accent2: #2dd4bf;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
      background: linear-gradient(180deg, #0b1226 0%, #0f172a 100%);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      padding: 28px 40px 16px;
      border-bottom: 1px solid rgba(148,163,184,.15);
      background: rgba(15,23,42,.8);
      backdrop-filter: blur(8px);
      position: sticky; top: 0; z-index: 5;
    }
    header h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -.01em; }
    header p  { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
    main { padding: 24px 40px 80px; }
    section { margin-top: 40px; }
    section h2 {
      margin: 0 0 4px;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: .12em;
      color: var(--accent2);
    }
    section p.cat-desc { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
    .concept {
      background: var(--panel);
      border: 1px solid rgba(148,163,184,.15);
      border-radius: 14px;
      padding: 16px 18px 18px;
      margin-bottom: 22px;
    }
    .concept h3 {
      margin: 0 0 12px;
      font-size: 14px;
      letter-spacing: .02em;
      color: #cbd5e1;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .concept h3 .pill {
      font-size: 11px;
      font-weight: 500;
      color: var(--muted);
      background: rgba(148,163,184,.1);
      padding: 2px 8px;
      border-radius: 999px;
      letter-spacing: 0;
      text-transform: none;
    }
    .variant-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    }
    .variant {
      background: var(--panel-2);
      border: 1px solid rgba(148,163,184,.12);
      border-radius: 10px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: transform .15s ease, border-color .15s ease;
    }
    .variant:hover { transform: translateY(-2px); border-color: rgba(99,102,241,.5); }
    .preview {
      aspect-ratio: 3/2;
      display: grid;
      place-items: center;
      background:
        linear-gradient(45deg, #1e293b 25%, transparent 25%),
        linear-gradient(-45deg, #1e293b 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #1e293b 75%),
        linear-gradient(-45deg, transparent 75%, #1e293b 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0;
      background-color: #0b1226;
    }
    body.light-preview .preview { background: #f8fafc; }
    .preview img { max-width: 100%; max-height: 100%; display: block; }
    .meta {
      padding: 8px 10px 10px;
      border-top: 1px solid rgba(148,163,184,.08);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: var(--muted);
    }
    .meta .v {
      font-weight: 600; color: #cbd5e1;
      background: rgba(99,102,241,.18);
      padding: 2px 8px; border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    a.dl { color: var(--accent2); text-decoration: none; font-size: 11px; }
    a.dl:hover { text-decoration: underline; }
    .toggle {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 12px; color: var(--muted);
      cursor: pointer; user-select: none;
    }
    .toggle input { accent-color: var(--accent); }
    .empty {
      padding: 60px 20px; text-align: center; color: var(--muted);
      border: 1px dashed rgba(148,163,184,.25); border-radius: 14px;
    }
    code { background: rgba(148,163,184,.12); padding: 1px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <header>
    <h1>Ticket Pulse — Brand Mockup Review</h1>
    <p id="subtitle">Loading manifest&hellip;</p>
    <p style="margin: 4px 0 8px;">
      <a href="mockup.html" style="color: var(--accent2); font-weight: 600;">→ Open the interactive Brand Mockup Studio</a>
      <span style="color: var(--muted); margin-left: 8px; font-size: 12px;">(swap variants in a live dashboard mockup and export your picks)</span>
    </p>
    <label class="toggle">
      <input type="checkbox" id="lightBg" /> Preview transparent assets on a light surface
    </label>
  </header>
  <main id="root">
    <p class="empty">If nothing appears, run <code>npm run generate-brand-assets</code> first.</p>
  </main>
  <script>
    const CATEGORY_LABEL = {
      logo: 'Logos',
      hero: 'Dashboard / Hero Graphics',
      background: 'Backgrounds',
      icon: 'Icons',
    };
    const CATEGORY_DESC = {
      logo: 'Header logo and app mark candidates. Pick one wordmark + one icon-only mark.',
      hero: 'Larger illustrations for the dashboard empty/loading state and marketing surfaces.',
      background: 'Subtle textures behind the dashboard. Lower-contrast variants are usually safer.',
      icon: 'UI icons (24-128px). Pick a coherent set across categories.',
    };
    const ORDER = ['logo', 'hero', 'background', 'icon'];

    async function load() {
      try {
        const res = await fetch('manifest.json', { cache: 'no-store' });
        if (!res.ok) throw new Error('manifest.json missing');
        const data = await res.json();
        document.getElementById('subtitle').textContent =
          \`\${data.count} mockup(s) • \${countConcepts(data.assets)} concept(s) • model \${data.model} • quality \${data.quality} • generated \${new Date(data.generatedAt).toLocaleString()}\`;
        render(data.assets || []);
      } catch (err) {
        document.getElementById('subtitle').textContent = 'No manifest yet. Generate assets first.';
      }
    }

    function countConcepts(assets) {
      return new Set(assets.map(a => a.concept)).size;
    }

    function render(assets) {
      const root = document.getElementById('root');
      root.innerHTML = '';
      const byCatThenConcept = {};
      for (const a of assets) {
        (byCatThenConcept[a.category] ||= {});
        (byCatThenConcept[a.category][a.concept] ||= []).push(a);
      }

      for (const cat of ORDER) {
        const concepts = byCatThenConcept[cat];
        if (!concepts) continue;
        const section = document.createElement('section');
        section.innerHTML = \`
          <h2>\${CATEGORY_LABEL[cat] || cat}</h2>
          <p class="cat-desc">\${CATEGORY_DESC[cat] || ''}</p>
        \`;
        const conceptNames = Object.keys(concepts).sort();
        for (const name of conceptNames) {
          const variants = concepts[name].sort((a, b) => a.variant - b.variant);
          const meta = variants[0];
          const wrap = document.createElement('div');
          wrap.className = 'concept';
          wrap.innerHTML = \`
            <h3>
              \${name}
              <span class="pill">\${meta.size || ''} • \${meta.transparent ? 'transparent target' : 'opaque'} • \${variants.length} variant(s)</span>
            </h3>
            <div class="variant-grid"></div>
          \`;
          const grid = wrap.querySelector('.variant-grid');
          for (const v of variants) {
            const card = document.createElement('div');
            card.className = 'variant';
            card.innerHTML = \`
              <div class="preview">
                <img src="\${v.file}" alt="\${v.concept} v\${v.variant}" loading="lazy" />
              </div>
              <div class="meta">
                <span class="v">v\${v.variant}</span>
                <a class="dl" href="\${v.file}" download>download</a>
              </div>
            \`;
            grid.appendChild(card);
          }
          section.appendChild(wrap);
        }
        root.appendChild(section);
      }
    }

    document.getElementById('lightBg').addEventListener('change', e => {
      document.body.classList.toggle('light-preview', e.target.checked);
    });

    load();
  </script>
</body>
</html>
`;
  await fs.writeFile(viewerPath, html, 'utf8');
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const out = { only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') out.resume = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--quality') out.quality = argv[++i];
    else if (a === '--concurrency') out.concurrency = argv[++i];
    else if (a === '--variants') out.variants = argv[++i];
    else if (a === '--only') out.only.push(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('See header comment in scripts/generate-brand-assets.mjs');
      process.exit(0);
    }
  }
  return out;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
