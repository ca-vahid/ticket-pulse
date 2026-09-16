// Send a Ticket Pulse brief (daily Global / IT memo or weekly insights) via SendGrid.
// Usage: node qa/tools/send-brief.mjs "<subject>" <html-file> [--to a@x,b@y]
//   - Sends the HTML as the body AND as an attachment (the memo is self-contained).
//   - Key: SENDGRID_API_KEY env, else SMTP_PASSWORD in backend/.env, else the app's
//     SMTP_PASSWORD app setting (az webapp config appsettings list). Never printed.
//   - Default recipient vhaeri@bgcengineering.ca (Vahid only, 15 Sep 2026 decision).
// Exit 1 on anything but a 202 so a cron prompt can retry once and report loudly.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const toIdx = argv.indexOf('--to');
const to = (toIdx > -1 ? argv.splice(toIdx, 2)[1] : 'vhaeri@bgcengineering.ca').split(',').map((e) => e.trim()).filter(Boolean);
const [subject, file] = argv;
if (!subject || !file) { console.error('usage: send-brief.mjs "<subject>" <html-file> [--to a@x,b@y]'); process.exit(1); }

function findKey() {
  if (process.env.SENDGRID_API_KEY) return process.env.SENDGRID_API_KEY.trim();
  try {
    const m = readFileSync(path.join(REPO, 'backend', '.env'), 'utf8').match(/^SMTP_PASSWORD=(.+)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, '');
  } catch { /* no local .env */ }
  try {
    const out = execSync('az webapp config appsettings list -n ticket-pulse-app -g ticket-pulse-rg --query "[?name==\'SMTP_PASSWORD\'].value | [0]" -o tsv', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out && out !== 'None') return out;
  } catch { /* az unavailable */ }
  return null;
}

const key = findKey();
if (!key) { console.error('send-brief: no SendGrid key (SENDGRID_API_KEY, backend/.env SMTP_PASSWORD, or the app setting)'); process.exit(1); }
let html;
try { html = readFileSync(file, 'utf8'); } catch { console.error(`send-brief: cannot read ${file}`); process.exit(1); }
const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: { email: 'ticketpulse@bgcengineering.ca', name: 'Ticket Pulse Briefs' },
    personalizations: [{ to: to.map((email) => ({ email })) }],
    subject,
    content: [{ type: 'text/html', value: html }],
    attachments: [{
      content: Buffer.from(html, 'utf8').toString('base64'),
      filename: path.basename(file),
      type: 'text/html',
      disposition: 'attachment',
    }],
  }),
});
console.log('SendGrid:', resp.status, resp.status === 202 ? `ACCEPTED → ${to.join(', ')}` : (await resp.text()).slice(0, 300));
if (resp.status !== 202) process.exit(1);
