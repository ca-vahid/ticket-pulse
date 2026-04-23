#!/usr/bin/env node
/**
 * Prepare production brand assets for the Ticket Pulse app.
 *
 * Reads the user's selections (hard-coded below — update when picks change)
 * from frontend/public/branding-mockups/ and:
 *   - chroma-keys the white background out of the wordmark + icons
 *     (gpt-image-2 doesn't produce transparent PNGs, so we strip white here)
 *   - generates favicon sizes (16 / 32 / 48 / 180 / 192 / 512)
 *   - compresses background + hero to webp for fast loading
 *   - copies everything into frontend/public/brand/ with semantic names
 *
 * Usage:
 *   node scripts/prepare-brand-assets.mjs
 *
 * Idempotent — safe to re-run after picking new variants.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'frontend', 'public', 'branding-mockups');
const OUT_ROOT = path.join(REPO_ROOT, 'frontend', 'public', 'brand');

// --- Selections (paste output of mockup studio's "Save selections" here) ----
const SELECTIONS = {
  headerLogo:      'logo/logo-01-wordmark-pulse-v3.png',
  appBadge:        'logo/logo-02-icon-mark-pulse-ticket-v2.png',
  background:      'background/bg-03-topographic-neutral-v4.png',
  panelBackground: 'background/bg-02-light-mesh-gradient-v4.png',
  hero:            'hero/hero-01-isometric-team-v2.png',
  iconPulse:       'icon/icon-01-heartbeat-app-v2.png',
  iconTicket:      'icon/icon-02-ticket-flat-v4.png',
  iconSync:        'icon/icon-03-sync-refresh-v1.png',
  iconTech:        'icon/icon-04-technician-headset-v1.png',
  iconWorkload:    'icon/icon-05-workload-meter-v2.png',
  iconCalendar:    'icon/icon-06-week-calendar-v3.png',
};

// Output names (keep stable so app code doesn't change when picks change)
const OUTPUTS = {
  headerLogo:      'logo-wordmark.png',          // chroma-keyed
  appBadge:        'logo-mark.png',              // chroma-keyed
  background:      'dashboard-background.webp',  // compressed (used behind dashboard)
  panelBackground: 'panel-background.webp',      // compressed (used behind login form, etc.)
  hero:            'hero-welcome.webp',          // compressed
  iconPulse:       'icon-pulse.png',             // chroma-keyed
  iconTicket:      'icon-ticket.png',            // chroma-keyed
  iconSync:        'icon-sync.png',              // chroma-keyed
  iconTech:        'icon-tech.png',              // chroma-keyed
  iconWorkload:    'icon-workload.png',          // chroma-keyed
  iconCalendar:    'icon-calendar.png',          // chroma-keyed
};

const FAVICON_SIZES = [16, 32, 48, 180, 192, 512];

// --- Image helpers ----------------------------------------------------------

/**
 * Remove a near-white background, preserving anti-aliased edges via a
 * luminance-to-alpha ramp.
 *
 * pixels with min(R,G,B) >= upper → fully transparent
 * pixels with min(R,G,B) <= lower → fully opaque
 * pixels in between                → linearly interpolated alpha
 *
 * Using min(R,G,B) (rather than average) catches "tinted-white" pixels (light
 * cyan halos around glowing strokes etc.) without eating colored interior
 * pixels.
 */
async function chromaKeyWhite(srcAbs, destAbs, { lower = 215, upper = 245, padPx = 0 } = {}) {
  let pipeline = sharp(srcAbs).ensureAlpha();
  if (padPx) pipeline = pipeline.extend({ top: padPx, bottom: padPx, left: padPx, right: padPx, background: { r: 255, g: 255, b: 255, alpha: 0 } });
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const span = upper - lower;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const minRgb = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (minRgb >= upper) {
      data[i + 3] = 0;
    } else if (minRgb > lower) {
      const factor = (upper - minRgb) / span;
      data[i + 3] = Math.round(255 * factor);
    }
    // else keep the original alpha (already 255 from ensureAlpha)
  }

  await sharp(data, { raw: { width, height, channels } })
    .png({ compressionLevel: 9 })
    .toFile(destAbs);

  const stat = await fs.stat(destAbs);
  return { width, height, bytes: stat.size };
}

/**
 * Auto-trim transparent padding so an icon scales nicely into a tile UI.
 * Returns the trimmed buffer (kept square if original was square).
 */
async function trimAndSave(srcAbs, destAbs) {
  const buf = await sharp(srcAbs)
    .trim({ threshold: 1 })
    .toBuffer();
  // Re-pad to a square so favicon resizing doesn't distort.
  const meta = await sharp(buf).metadata();
  const max = Math.max(meta.width, meta.height);
  const padX = Math.round((max - meta.width) / 2);
  const padY = Math.round((max - meta.height) / 2);
  await sharp(buf)
    .extend({ top: padY, bottom: max - meta.height - padY, left: padX, right: max - meta.width - padX, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(destAbs);
  return await fs.stat(destAbs).then(s => s.size);
}

async function compressToWebp(srcAbs, destAbs, { width, quality = 82 } = {}) {
  let pipe = sharp(srcAbs);
  if (width) pipe = pipe.resize({ width, withoutEnlargement: true });
  await pipe.webp({ quality }).toFile(destAbs);
  return await fs.stat(destAbs).then(s => s.size);
}

async function generateFavicons(badgeTransparentPath) {
  // The favicon should NOT have empty padding - trim first then resize.
  const trimmedBuf = await sharp(badgeTransparentPath).trim({ threshold: 1 }).toBuffer();
  const meta = await sharp(trimmedBuf).metadata();
  const side = Math.max(meta.width, meta.height);
  // Re-pad to square with a small breathing margin (5% of side).
  const margin = Math.round(side * 0.05);
  const totalSide = side + margin * 2;
  const padX = Math.round((totalSide - meta.width) / 2);
  const padY = Math.round((totalSide - meta.height) / 2);
  const squareBuf = await sharp(trimmedBuf)
    .extend({ top: padY, bottom: totalSide - meta.height - padY, left: padX, right: totalSide - meta.width - padX, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  const sizes = [];
  for (const size of FAVICON_SIZES) {
    const out = path.join(OUT_ROOT, `favicon-${size}.png`);
    await sharp(squareBuf)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    const sz = await fs.stat(out).then(s => s.size);
    sizes.push({ size, file: `favicon-${size}.png`, bytes: sz });
  }
  // Also write a generic favicon.png (32px) for the legacy <link rel="icon">
  await fs.copyFile(path.join(OUT_ROOT, 'favicon-32.png'), path.join(OUT_ROOT, 'favicon.png'));
  return sizes;
}

// --- Main -------------------------------------------------------------------
async function main() {
  await fs.mkdir(OUT_ROOT, { recursive: true });
  console.log(`Preparing brand assets`);
  console.log(`  src: ${SRC_ROOT}`);
  console.log(`  out: ${OUT_ROOT}`);
  console.log('');

  const log = (line) => console.log(`  ${line}`);

  // 1) Wordmark (chroma-key, keep at high resolution for retina headers)
  {
    const src = path.join(SRC_ROOT, SELECTIONS.headerLogo);
    const out = path.join(OUT_ROOT, OUTPUTS.headerLogo);
    const r = await chromaKeyWhite(src, out, { lower: 215, upper: 245 });
    log(`wrote ${OUTPUTS.headerLogo}  (${r.width}x${r.height}, ${(r.bytes / 1024).toFixed(0)} KB)`);
  }

  // 2) App badge / mark (chroma-key)
  {
    const src = path.join(SRC_ROOT, SELECTIONS.appBadge);
    const out = path.join(OUT_ROOT, OUTPUTS.appBadge);
    const r = await chromaKeyWhite(src, out, { lower: 220, upper: 248 });
    log(`wrote ${OUTPUTS.appBadge}  (${r.width}x${r.height}, ${(r.bytes / 1024).toFixed(0)} KB)`);

    // Generate favicons from the chroma-keyed badge
    const sizes = await generateFavicons(out);
    for (const s of sizes) log(`  favicon-${s.size}.png  (${(s.bytes / 1024).toFixed(0)} KB)`);
    log(`  favicon.png (alias of favicon-32.png)`);
  }

  // 3a) Dashboard background (compress to webp, full width 1920)
  {
    const src = path.join(SRC_ROOT, SELECTIONS.background);
    const out = path.join(OUT_ROOT, OUTPUTS.background);
    const bytes = await compressToWebp(src, out, { width: 1920, quality: 78 });
    log(`wrote ${OUTPUTS.background}  (${(bytes / 1024).toFixed(0)} KB)`);
  }

  // 3b) Panel background (light mesh gradient — used as form-pane backdrop)
  {
    const src = path.join(SRC_ROOT, SELECTIONS.panelBackground);
    const out = path.join(OUT_ROOT, OUTPUTS.panelBackground);
    const bytes = await compressToWebp(src, out, { width: 1600, quality: 82 });
    log(`wrote ${OUTPUTS.panelBackground}  (${(bytes / 1024).toFixed(0)} KB)`);
  }

  // 4) Hero illustration (compress to webp)
  {
    const src = path.join(SRC_ROOT, SELECTIONS.hero);
    const out = path.join(OUT_ROOT, OUTPUTS.hero);
    const bytes = await compressToWebp(src, out, { width: 1600, quality: 82 });
    log(`wrote ${OUTPUTS.hero}  (${(bytes / 1024).toFixed(0)} KB)`);
  }

  // 5) Icons (chroma-key, then trim + re-square so they fit tiles cleanly)
  const iconKeys = ['iconPulse', 'iconTicket', 'iconSync', 'iconTech', 'iconWorkload', 'iconCalendar'];
  for (const key of iconKeys) {
    const src = path.join(SRC_ROOT, SELECTIONS[key]);
    const out = path.join(OUT_ROOT, OUTPUTS[key]);
    const tmp = path.join(OUT_ROOT, `_tmp-${OUTPUTS[key]}`);
    await chromaKeyWhite(src, tmp, { lower: 220, upper: 248 });
    const bytes = await trimAndSave(tmp, out);
    await fs.unlink(tmp).catch(() => {});
    log(`wrote ${OUTPUTS[key]}  (${(bytes / 1024).toFixed(0)} KB)`);
  }

  // 6) Manifest (so we can trace which mockup variant is currently in production)
  const manifest = {
    generatedAt: new Date().toISOString(),
    selections: SELECTIONS,
    outputs: OUTPUTS,
    favicons: FAVICON_SIZES.map(s => `favicon-${s}.png`).concat(['favicon.png']),
  };
  await fs.writeFile(
    path.join(OUT_ROOT, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  log(`wrote manifest.json`);

  console.log('');
  console.log(`Done. ${Object.keys(OUTPUTS).length + FAVICON_SIZES.length + 1} file(s) in ${OUT_ROOT}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
