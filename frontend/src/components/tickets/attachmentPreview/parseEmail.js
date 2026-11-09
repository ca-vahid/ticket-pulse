/**
 * Read an attached e-mail (.eml / message/rfc822 via postal-mime, Outlook
 * .msg via msgreader — both lazy chunks) into one plain shape for EmailView:
 *
 *   { subject, from, to: [], cc: [], date, html, text, attachments: [{ name, size }] }
 *
 * Inline pictures (cid: references) become data: URLs so the body shows them;
 * those pictures are left out of the attachment list. The HTML is NOT
 * sanitized here — EmailView renders it through SafeHtml (DOMPurify).
 */

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Outlook .msg files are OLE compound files, whatever their name or label says. */
export function isOutlookMsg(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  return head.length === 8 && OLE_MAGIC.every((b, i) => head[i] === b);
}

const person = (name, address) => {
  const n = String(name || '').trim().replace(/^"|"$/g, '');
  const a = String(address || '').trim();
  if (n && a && n.toLowerCase() !== a.toLowerCase()) return `${n} <${a}>`;
  return n || a;
};

function postalList(list) {
  const out = [];
  for (const entry of list || []) {
    if (Array.isArray(entry?.group)) out.push(...postalList(entry.group));
    else {
      const p = person(entry?.name, entry?.address);
      if (p) out.push(p);
    }
  }
  return out;
}

const base64Size = (b64) => {
  const s = String(b64 || '').replace(/\s/g, '');
  return Math.max(0, Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0));
};

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

const cidKey = (id) => String(id || '').trim().replace(/^<|>$/g, '').toLowerCase();

/** Swap `cid:` picture references for data: URLs; returns the html and the cids used. */
export function inlineCidImages(html, images) {
  const used = new Set();
  if (!html || !images.size) return { html, used };
  const out = html.replace(/(["'(])cid:([^"')\s>]+)/gi, (m, lead, id) => {
    let key = cidKey(id);
    try { key = cidKey(decodeURIComponent(id)); } catch { /* keep raw */ }
    const src = images.get(key);
    if (!src) return m;
    used.add(key);
    return `${lead}${src}`;
  });
  return { html: out, used };
}

async function parseEml(buffer) {
  const mod = await import('postal-mime');
  const PostalMime = mod.default || mod.PostalMime;
  const email = await PostalMime.parse(buffer, { attachmentEncoding: 'base64' });
  const images = new Map();
  for (const a of email.attachments || []) {
    if (a.contentId && /^image\//i.test(a.mimeType || '') && base64Size(a.content) <= MAX_INLINE_IMAGE_BYTES) {
      images.set(cidKey(a.contentId), `data:${a.mimeType};base64,${a.content}`);
    }
  }
  const { html, used } = inlineCidImages(email.html || '', images);
  return {
    subject: email.subject || '',
    from: postalList(email.from ? [email.from] : [])[0] || '',
    to: postalList(email.to),
    cc: postalList(email.cc),
    date: email.date || '',
    html,
    text: email.text || '',
    attachments: (email.attachments || [])
      .filter((a) => !(a.contentId && used.has(cidKey(a.contentId))))
      .map((a) => ({ name: a.filename || (a.mimeType === 'message/rfc822' ? 'Attached message.eml' : 'Unnamed attachment'), size: base64Size(a.content) })),
  };
}

const isX500 = (addr) => String(addr || '').startsWith('/');

async function parseMsg(buffer) {
  const mod = await import('@kenjiuno/msgreader');
  const MsgReader = [mod.default?.default, mod.default, mod.MsgReader].find((c) => typeof c === 'function');
  const reader = new MsgReader(buffer);
  const d = reader.getFileData();
  if (!d || d.error) throw new Error(d?.error || 'Not an Outlook message');

  const recipients = (d.recipients || []).map((r) => ({
    kind: r.recipType || 'to',
    label: person(r.name, r.smtpAddress || (isX500(r.email) ? '' : r.email)),
  })).filter((r) => r.label);

  let html = d.bodyHtml || '';
  if (!html && d.html?.length) {
    try { html = new TextDecoder(d.internetCodepage === 1252 ? 'windows-1252' : 'utf-8').decode(d.html); } catch { html = ''; }
  }

  const visible = (d.attachments || []).filter((a) => !a.attachmentHidden);
  const images = new Map();
  for (const a of visible) {
    if (!a.pidContentId || !/^image\//i.test(a.attachMimeTag || '') || (a.contentLength || 0) > MAX_INLINE_IMAGE_BYTES) continue;
    try {
      const { content } = reader.getAttachment(a);
      if (content?.length) images.set(cidKey(a.pidContentId), `data:${a.attachMimeTag};base64,${bytesToBase64(content)}`);
    } catch { /* leave the cid picture broken */ }
  }
  const inlined = inlineCidImages(html, images);

  return {
    subject: d.subject || '',
    from: person(d.senderName, d.senderSmtpAddress || (isX500(d.senderEmail) ? '' : d.senderEmail)),
    to: recipients.filter((r) => r.kind === 'to').map((r) => r.label),
    cc: recipients.filter((r) => r.kind === 'cc').map((r) => r.label),
    date: d.messageDeliveryTime || d.clientSubmitTime || d.creationTime || '',
    html: inlined.html,
    text: d.body || '',
    attachments: visible
      .filter((a) => !(a.pidContentId && inlined.used.has(cidKey(a.pidContentId))))
      .map((a) => ({
        name: a.fileName || a.fileNameShort || (a.innerMsgContent ? `${a.name || 'Attached message'}.msg` : a.name || 'Unnamed attachment'),
        size: a.contentLength || 0,
      })),
  };
}

export async function parseEmailFile(buffer) {
  return isOutlookMsg(buffer) ? parseMsg(buffer) : parseEml(buffer);
}
