/**
 * An attached e-mail comes from a stranger (UI Design review, QA 11-06 #3):
 * pictures loaded from the internet are hidden until the reader asks (they are
 * how senders track that a mail was opened), and every link opens in a new tab
 * without telling the other site where it came from. Pictures carried inside
 * the e-mail itself (cid:, turned into data: URLs by parseEmail) always show.
 * Runs before SafeHtml's own sanitising, which still removes scripts and forms.
 */
const REMOTE = /^\s*(https?:)?\/\//i;
const REMOTE_URL_IN_CSS = /url\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi;

export function prepareEmailHtml(html, { showImages = false } = {}) {
  if (!html) return { html: '', blocked: 0 };
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  let blocked = 0;
  if (!showImages) {
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      const srcset = img.getAttribute('srcset') || '';
      if (REMOTE.test(src) || /(https?:)?\/\//i.test(srcset)) {
        img.removeAttribute('src');
        img.removeAttribute('srcset');
        img.setAttribute('data-tp-blocked', '1');
        blocked += 1;
      }
    });
    doc.querySelectorAll('[background]').forEach((el) => {
      if (REMOTE.test(el.getAttribute('background') || '')) { el.removeAttribute('background'); blocked += 1; }
    });
    doc.querySelectorAll('[style]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      if (REMOTE_URL_IN_CSS.test(style)) {
        REMOTE_URL_IN_CSS.lastIndex = 0;
        el.setAttribute('style', style.replace(REMOTE_URL_IN_CSS, 'none'));
        blocked += 1;
      }
      REMOTE_URL_IN_CSS.lastIndex = 0;
    });
  }
  doc.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return { html: doc.body.innerHTML, blocked };
}
