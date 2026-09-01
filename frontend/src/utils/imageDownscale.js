/**
 * Client-side image prep for the Autofill intake call (Mega 08-31 Phase AF).
 *
 * Screenshots leave the browser for a third-party vision model, so we shrink
 * them first: longest edge capped at 1568 px (the sweet spot for Anthropic's
 * image tokeniser — anything bigger is downscaled server-side anyway) and
 * re-encoded as JPEG q0.85 on a white ground. Always JPEG — a transparent PNG
 * screenshot is vanishingly rare and the model doesn't care about alpha.
 *
 * Returns a NEW File; the caller keeps the ORIGINAL for attachment staging so
 * the ticket gets the full-resolution picture. Anything that can't be decoded
 * (SVG in some browsers, a corrupt file, no canvas in the runtime) falls back
 * to the original untouched — the server enforces the hard caps regardless.
 */

export const MAX_EDGE = 1568;
export const JPEG_QUALITY = 0.85;

function baseName(name) {
  return String(name || 'image').replace(/\.[^.]+$/, '') || 'image';
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch { /* fall through to the <img> path */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
    img.src = url;
  });
}

/**
 * @param {File} file
 * @param {{ maxEdge?: number, quality?: number }} [opts]
 * @returns {Promise<File>} a JPEG File no larger than maxEdge on its longest side
 */
export async function downscaleImage(file, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  if (!file || !(file.type || '').startsWith('image/')) return file;
  if (typeof document === 'undefined') return file;
  try {
    const bitmap = await loadBitmap(file);
    const srcW = bitmap.naturalWidth || bitmap.width;
    const srcH = bitmap.naturalHeight || bitmap.height;
    if (!srcW || !srcH) return file;
    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // JPEG has no alpha — paint a white ground so transparent regions don't
    // come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (typeof bitmap.close === 'function') bitmap.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return file;
    // Nothing gained (small JPEG already) — keep the original bytes.
    if (scale === 1 && file.type === 'image/jpeg' && blob.size >= file.size) return file;
    return new File([blob], `${baseName(file.name)}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
}

/** Downscale a batch; each failure falls back to its original. */
export async function downscaleAll(files, opts) {
  return Promise.all(Array.from(files || []).map((f) => downscaleImage(f, opts)));
}
