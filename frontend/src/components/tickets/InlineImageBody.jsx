import { useEffect, useMemo, useRef } from 'react';
import { ticketsAPI } from '../../services/api';
import { plainTextToHtml } from '../../utils/plainTextToHtml';
import { looksLikeRealHtml } from '../../utils/htmlContent';
import { SafeHtml } from './ticketUi';

/**
 * Message bodies with their pictures in place (QA 10-13 #1 and #2).
 *
 * A picture inside an e-mail (a signature logo, a pasted screenshot) is stored
 * as an attachment, and the body keeps the text "[Image: file name]" where the
 * picture was. Until now a reply showed that as a small link and the
 * description showed the bare text. Here the picture itself is shown at that
 * spot, small, and a click opens it in the attachment preview. The full file
 * stays in the attachments list.
 *
 * Safety: the body is sanitised exactly as before (SafeHtml, unchanged). The
 * picture element is created here, after sanitising, and its address is a
 * browser-local object URL made from the app's signed-in attachment download,
 * for an attachment of THIS ticket matched by file name. Nothing in the e-mail
 * can point it at another address.
 */

const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const IMG_REF_RE = /\[Image:\s*([^\]]+?)\]/g;
// Bodies may use non-breaking-space entities inside the ref (e.g. from a paste),
// so normalise those to real spaces before trimming the file name.
const NBSP_RE = new RegExp(`&nbsp;|&#160;|&#xa0;|${String.fromCharCode(160)}`, 'gi');
export const cleanRefName = (s) => String(s || '').replace(NBSP_RE, ' ').trim();
const keyOf = (name) => cleanRefName(name).toLowerCase();

/** Lower-cased file names a body refers to with "[Image: name]". */
export function imageRefNames(...bodies) {
  const names = new Set();
  for (const body of bodies) {
    for (const match of String(body || '').matchAll(IMG_REF_RE)) names.add(keyOf(match[1]));
  }
  return names;
}

/** Of these picture attachments, the ones the body shows in place. */
export function picturesShownInBody(images, ...bodies) {
  const names = imageRefNames(...bodies);
  if (names.size === 0) return [];
  return (images || []).filter((a) => names.has(keyOf(a.fileName)));
}

/**
 * The first conversation entry of a ticket that arrived by e-mail before
 * 13 Oct 2026 holds only the mail client's preview: plain text, cut at 255
 * characters. When the ticket's description still starts with that same text,
 * the entry is shown with the description's own formatted body instead.
 * Display only: the stored entry is not changed. Returns null when it does
 * not apply (the entry has its own HTML, or the description was edited away
 * from the mail).
 */
export function openingMessageHtml(entry, ticket) {
  if (!entry || entry.eventType !== 'original_email' || entry.bodyHtml) return null;
  const description = ticket?.description;
  if (!description || !looksLikeRealHtml(description)) return null;
  const squash = (s) => String(s || '').replace(IMG_REF_RE, '').replace(new RegExp(`[\\s${String.fromCharCode(160)}]+`, 'g'), '');
  const preview = squash(entry.bodyText || entry.content);
  const whole = squash(ticket.descriptionText);
  if (preview.length < 20 || !whole) return null;
  return whole.startsWith(preview.slice(0, 200)) ? description : null;
}

// attachment key -> Promise<object URL>. Shared by every body on the page so a
// picture shown in both the description and the conversation is fetched once.
const URL_CACHE_MAX = 60;
const urlCache = new Map();
function pictureUrl(ticketId, attachmentId) {
  const key = `${ticketId}:${attachmentId}`;
  if (urlCache.has(key)) return urlCache.get(key);
  const pending = ticketsAPI.attachmentObjectUrl(ticketId, attachmentId).then((res) => res.url);
  urlCache.set(key, pending);
  pending.catch(() => urlCache.delete(key));
  if (urlCache.size > URL_CACHE_MAX) {
    const [oldestKey, oldest] = urlCache.entries().next().value;
    urlCache.delete(oldestKey);
    // A picture already on screen keeps its pixels after its URL is released.
    oldest.then((url) => { try { URL.revokeObjectURL(url); } catch { /* not ours to fail on */ } }).catch(() => {});
  }
  return pending;
}

/** Test seam: forget fetched pictures. */
export function _resetPictureCache() {
  urlCache.clear();
}

/**
 * Renders a message body.
 *  - `inlineImages` + `ticketId`: picture attachments that may be shown in
 *    place of their "[Image: name]" text (thumbnail, click to open).
 *  - a reference with no matching picture stays a link that opens the preview
 *    (or tells the agent there is no such file), as before.
 *  - `shownImages`: names already shown as thumbnails under the message; their
 *    link reads "picture" instead of repeating the file name.
 */
export function RichBody({ html, text, onImageRef, className = '', shownImages = null, ticketId = null, inlineImages = null }) {
  const rootRef = useRef(null);
  const inlineByName = useMemo(() => {
    const map = new Map();
    if (ticketId) for (const a of inlineImages || []) map.set(keyOf(a.fileName), a);
    return map;
  }, [inlineImages, ticketId]);

  const source = useMemo(() => {
    const injectRefs = (s) => String(s).replace(IMG_REF_RE, (_m, name) => {
      const plain = cleanRefName(name);
      const clean = escapeHtml(plain);
      if (inlineByName.has(plain.toLowerCase())) {
        return `<span class="tp-img-ref tp-img-ref--inline" data-img="${clean}" title="Open ${clean}" aria-label="Open picture ${clean}" role="button" tabindex="0">🖼 ${clean}</span>`;
      }
      const shown = shownImages && shownImages.has(plain.toLowerCase());
      return `<span class="tp-img-ref" data-img="${clean}" title="${clean}" role="button" tabindex="0">🖼 ${shown ? 'picture' : clean}</span>`;
    });
    // FR 09-11 #3: a text-only body becomes paragraphs, not one <br> per line.
    return (html && looksLikeRealHtml(html))
      ? injectRefs(html)
      : injectRefs(plainTextToHtml(text || html || ''));
  }, [html, text, inlineByName, shownImages]);

  // Put the pictures in. Runs after every render and skips what is already
  // filled, so a body that React re-wrote (theme change, live update) gets its
  // pictures back from the cache without a second download.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !ticketId || inlineByName.size === 0) return;
    root.querySelectorAll('.tp-img-ref--inline:not([data-filled])').forEach((el) => {
      const attachment = inlineByName.get(keyOf(el.getAttribute('data-img')));
      if (!attachment) return;
      el.setAttribute('data-filled', 'pending');
      pictureUrl(ticketId, attachment.id).then((url) => {
        if (!el.isConnected) return;
        const img = document.createElement('img');
        img.src = url;
        img.alt = attachment.fileName || 'picture';
        img.className = 'tp-inline-img';
        img.decoding = 'async';
        el.textContent = '';
        el.appendChild(img);
        el.classList.add('tp-img-ref--shown');
        el.setAttribute('data-filled', 'yes');
      }).catch(() => {
        // The link stays: a click still opens the preview, which says what failed.
        // Marked so a page that re-renders often does not ask again and again.
        el.setAttribute('data-filled', 'failed');
      });
    });
  });

  const open = (el) => onImageRef?.(el.getAttribute('data-img'));
  const handleClick = (e) => {
    const el = e.target.closest?.('.tp-img-ref');
    if (el) { e.preventDefault(); open(el); }
  };
  const handleKey = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('tp-img-ref')) {
      e.preventDefault(); open(e.target);
    }
  };
  return (
    <div ref={rootRef} onClick={handleClick} onKeyDown={handleKey} role="presentation">
      <SafeHtml html={source} className={className} />
    </div>
  );
}

/**
 * The signature that was added to an agent's reply when it was mailed
 * (QA 10-13 #4). The reply's own text is what the agent typed; the signature
 * was added at send time and the conversation used to stop at "Kind regards,".
 * Shown under the message, one line down, exactly as it left. Replies sent
 * before this release have none stored and look as they did.
 */
export function SentSignature({ entry, className = '' }) {
  const signature = entry?.rawPayload?.sentSignature;
  if (!signature || typeof signature !== 'object') return null;
  const html = typeof signature.html === 'string' && signature.html.trim() ? signature.html : null;
  const text = typeof signature.text === 'string' && signature.text.trim() ? signature.text : null;
  if (!html && !text) return null;
  return (
    <div className={`mt-4 ${className}`} data-testid="sent-signature" aria-label="Signature sent with this reply">
      {html
        ? <SafeHtml html={html} />
        : <p className="text-sm text-foreground/85 whitespace-pre-wrap break-words">{text}</p>}
    </div>
  );
}

export default RichBody;
