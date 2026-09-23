// Send an HTML file FROM a mailbox via Microsoft Graph sendMail (saveToSentItems: true, so it
// lands in that mailbox's Sent Items exactly like a hand-sent Outlook message).
// Usage: node qa/tools/graph-send-as.mjs <fromMailbox> <to[,to]> "<subject>" <file.html>
// Credentials: AZURE_GRAPH_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET from backend/.env (the app's
// Graph registration, which holds Mail.Send). data:image/*;base64 images (e.g. the logo in a
// Ticket Pulse signature) become inline cid: attachments, because Outlook blocks data URIs.
// Exit 1 on anything but a 202.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = readFileSync(path.join(REPO, 'backend', '.env'), 'utf8');
const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^"|"$/g, '');
const tenant = get('AZURE_GRAPH_TENANT_ID'), clientId = get('AZURE_GRAPH_CLIENT_ID'), secret = get('AZURE_GRAPH_CLIENT_SECRET');
const [from, toCsv, subject, file] = process.argv.slice(2);
if (!from || !toCsv || !subject || !file) { console.error('usage: from to subject file'); process.exit(1); }

const tok = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
  method: 'POST',
  body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
}).then((r) => r.json());
if (!tok.access_token) { console.error('token failed:', tok.error, tok.error_description?.split('\n')[0]); process.exit(1); }

let html = readFileSync(file, 'utf8');
const attachments = [];
const seen = new Map();
html = html.replace(/src="data:(image\/[a-z+]+);base64,([^"]+)"/g, (m, type, b64) => {
  if (!seen.has(b64)) {
    const cid = `img${seen.size + 1}@tp`;
    seen.set(b64, cid);
    attachments.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: `${cid.split('@')[0]}.${type.split('/')[1].replace('+xml', '')}`,
      contentType: type, contentBytes: b64, isInline: true, contentId: cid });
  }
  return `src="cid:${seen.get(b64)}"`;
});

const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: { subject, body: { contentType: 'HTML', content: html },
      toRecipients: toCsv.split(',').map((a) => ({ emailAddress: { address: a.trim() } })), attachments },
    saveToSentItems: true,
  }),
});
if (res.status === 202) console.log(`Graph: 202 ACCEPTED from ${from} -> ${toCsv} (${attachments.length} inline image(s)), saved to Sent Items`);
else { console.error(`Graph: ${res.status}`, (await res.text()).slice(0, 400)); process.exit(1); }
