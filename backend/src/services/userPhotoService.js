/**
 * Entra profile photos, lazily fetched with an in-memory cache (nulls cached
 * too — most requesters have no photo and Graph 404s are slow). One cache for
 * the requester-photo route, the public approval page's photo route and the
 * approval e-mails' inline avatars.
 */
const photoCache = new Map(); // email -> { photo, at }
const PHOTO_TTL_MS = 12 * 60 * 60 * 1000;
const PHOTO_CACHE_MAX = 500;

/** Entra photo as a data URI (or null), memoised for 12h per address. */
export async function getCachedUserPhoto(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) return null;
  const cached = photoCache.get(key);
  if (cached && Date.now() - cached.at < PHOTO_TTL_MS) return cached.photo;
  let photo = null;
  try {
    const { default: azureAdService } = await import('./azureAdService.js');
    photo = await azureAdService.getUserPhoto(key); // data URI or null
  } catch { /* Entra unconfigured/unreachable — cache the null */ }
  if (photoCache.size >= PHOTO_CACHE_MAX) {
    photoCache.delete(photoCache.keys().next().value);
  }
  photoCache.set(key, { photo: photo || null, at: Date.now() });
  return photo || null;
}

/** Split a `data:image/...;base64,...` URI into { contentType, buffer } (null when malformed). */
export function decodePhotoDataUri(dataUri) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUri || ''));
  if (!m) return null;
  const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  return buffer.length > 0 ? { contentType: m[1].toLowerCase(), buffer } : null;
}

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * The person's photo as an INLINE mail attachment (`cid:` referenced) — the
 * picture travels inside the message, so it renders with images-off policies
 * and never depends on a URL. Null when the person has no photo.
 */
export async function inlinePhotoAttachment(email, contentId) {
  try {
    const decoded = decodePhotoDataUri(await getCachedUserPhoto(email));
    if (!decoded) return null;
    return {
      name: `${contentId}.${EXT[decoded.contentType] || 'jpg'}`,
      contentType: decoded.contentType,
      contentBytes: decoded.buffer.toString('base64'),
      contentId,
      inline: true,
    };
  } catch {
    return null;
  }
}

export function resetUserPhotoCache() {
  photoCache.clear();
}

export default { getCachedUserPhoto, decodePhotoDataUri, inlinePhotoAttachment, resetUserPhotoCache };
