/**
 * Brand pictograms for transactional e-mail (17 Sep 2026).
 *
 * Mail clients block remote images and data URIs by default, so every picture
 * travels INSIDE the message as an inline (`cid:`) attachment. Templates call
 * `brandImg(name, …)` which emits `<img src="cid:tp-<name>">`; the mail lane
 * calls `brandAttachmentsFor(html)` right before sending and attaches exactly
 * the files the HTML references. PNGs live in `backend/assets/email/` — flat
 * matte gpt-image-2 pictograms, 128 px, transparent — and are cached in memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASSET_DIR = path.resolve(HERE, '../../assets/email');
const CID_PREFIX = 'tp-';

const cache = new Map(); // name → { contentBytes(base64), size } | null

export function assetNames() {
  try {
    return fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort();
  } catch { return []; }
}

function load(name) {
  if (cache.has(name)) return cache.get(name);
  let entry = null;
  try {
    const buf = fs.readFileSync(path.join(ASSET_DIR, `${name}.png`));
    entry = { contentBytes: buf.toString('base64'), size: buf.length };
  } catch { entry = null; }
  cache.set(name, entry);
  return entry;
}

export function hasBrandAsset(name) {
  return Boolean(load(name));
}

/** `<img>` for a brand pictogram, referenced by cid. Falls back to nothing when the file is missing. */
export function brandImg(name, { size = 64, alt = '', style = '' } = {}) {
  if (!load(name)) return '';
  const safeAlt = String(alt || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<img src="cid:${CID_PREFIX}${name}" width="${size}" height="${size}" alt="${safeAlt}" style="display:block;width:${size}px;height:${size}px;border:0;outline:none;text-decoration:none;${style}">`;
}

/** The approval-category pictogram for a category name (keyword match; generic clipboard otherwise). */
export function categoryArt(categoryName) {
  const s = String(categoryName || '').toLowerCase();
  if (/computer|laptop|workstation|desktop|hardware|monitor|dock/.test(s)) return 'cat-computer';
  if (/cyber|security|permission|access|risk|firewall|admin/.test(s)) return 'cat-security';
  if (/mobile|phone|ipad|tablet|cell/.test(s)) return 'cat-mobile';
  if (/software|licen|subscription|saas|app\b/.test(s)) return 'cat-software';
  if (/travel|expense|purchase|budget|amount|cost|payment|spend|invoice/.test(s)) return 'cat-money';
  return 'cat-generic';
}

/**
 * Inline attachments for every `cid:tp-*` the HTML references (deduplicated),
 * skipping any the caller already attached under the same contentId.
 */
export function brandAttachmentsFor(html, existing = []) {
  const have = new Set((existing || []).map((a) => a?.contentId).filter(Boolean));
  const out = [];
  const seen = new Set();
  const re = new RegExp(`cid:(${CID_PREFIX}[a-z0-9-]+)`, 'g');
  let m;
  while ((m = re.exec(String(html || '')))) {
    const cid = m[1];
    if (seen.has(cid) || have.has(cid)) continue;
    seen.add(cid);
    const entry = load(cid.slice(CID_PREFIX.length));
    if (!entry) continue;
    out.push({ name: `${cid}.png`, contentType: 'image/png', contentBytes: entry.contentBytes, contentId: cid, inline: true });
  }
  return out;
}

/** Attachments the mail lane should send: the caller's plus the brand pictograms the HTML needs. */
export function withBrandAttachments(attachments, html) {
  const base = Array.isArray(attachments) ? attachments : [];
  const extra = brandAttachmentsFor(html, base);
  return extra.length ? [...base, ...extra] : base;
}

export function resetBrandAssetCache() { cache.clear(); }

export default { brandImg, categoryArt, brandAttachmentsFor, withBrandAttachments, hasBrandAsset, assetNames, resetBrandAssetCache, ASSET_DIR };
