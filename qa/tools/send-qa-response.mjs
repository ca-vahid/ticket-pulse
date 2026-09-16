// E-mail a QA response PDF to the QA team via the app's SendGrid sender (the template Vahid approved on 14 Sep 2026).
// Usage (from backend/ so app imports resolve):
//   node ../qa/tools/send-qa-response.mjs --pdf "<path.pdf>" --package 09-15 --version 3.8.89-preview \
//        --content ../qa/evidence-0915/email_content.mjs [--to vhaeri@bgcengineering.ca] [--dry]
// email_content.mjs must `export default { headline, intro, rows, retest, questions, extra, thanks }`
//   rows: [{ n, what, verdict: 'FIXED'|'BUILT'|'EXPLAINED'|'YOUR CALL'|'PLANNED'|'NOT REPRODUCED'|'THANK YOU', tone: 'ok'|'info'|'warn'|'you', cause }]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import settingsRepository from '../../backend/src/services/settingsRepository.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const PDF = arg('--pdf'); const PKG = arg('--package'); const VERSION = arg('--version'); const CONTENT = arg('--content');
const TO = arg('--to', 'sxu@bgcengineering.ca'); const DRY = process.argv.includes('--dry');
if (!PDF || !PKG || !VERSION || !CONTENT) { console.error('usage: --pdf <pdf> --package MM-DD --version X.Y.Z --content <email_content.mjs> [--to email] [--dry]'); process.exit(1); }
const { default: C } = await import(pathToFileURL(path.resolve(CONTENT)).href);

const cfg = await settingsRepository.getSendGridConfig();
const apiKey = cfg.apiKey || cfg.sendgridApiKey || cfg.key;
const fromEmail = cfg.fromEmail || cfg.sendgridFromEmail || 'ticketpulse@bgcengineering.ca';
if (!apiKey && !DRY) { console.error('no SendGrid key in app settings'); process.exit(1); }

const tones = { ok: { bg: '#dcfce7', fg: '#166534' }, info: { bg: '#dbeafe', fg: '#1e40af' }, warn: { bg: '#fef3c7', fg: '#92400e' }, you: { bg: '#fce7f3', fg: '#9d174d' } };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const row = (r) => { const t = tones[r.tone] || tones.info; return `
<tr>
  <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:700;width:28px">${r.n}</td>
  <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#0f172a">${r.what}</td>
  <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap"><span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;padding:2px 9px;border-radius:999px;background:${t.bg};color:${t.fg}">${esc(r.verdict)}</span></td>
  <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:13px">${r.cause}</td>
</tr>`; };
const li = (items) => items.map((s) => `<li>${s}</li>`).join('\n      ');
const pdfName = path.basename(PDF);
const n = C.rows.length;

const html = `
<div style="margin:0;padding:24px;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;color:#0f172a">
<div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
  <div style="background:linear-gradient(135deg,#1d4ed8 0%,#6d28d9 100%);color:#fff;padding:26px 30px">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Ticket Pulse &middot; QA response</div>
    <div style="font-size:24px;font-weight:700;margin-top:6px">Your ${PKG} package &mdash; all ${n} answered</div>
    <div style="font-size:14px;opacity:.92;margin-top:6px">${C.headline}</div>
  </div>
  <div style="padding:22px 30px 8px">
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55">Hi Susan,</p>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55">${C.intro || `The full response to your ${PKG} package is attached as a PDF, with screenshots and the production data behind each verdict. Here is the short version.`}</p>
    <table style="border-collapse:collapse;width:100%;margin:6px 0 18px;font-size:14px">
      <tr style="background:#f8fafc"><th style="text-align:left;padding:8px 10px;font-size:12px;color:#64748b">#</th><th style="text-align:left;padding:8px 10px;font-size:12px;color:#64748b">What you reported</th><th style="text-align:left;padding:8px 10px;font-size:12px;color:#64748b">Verdict</th><th style="text-align:left;padding:8px 10px;font-size:12px;color:#64748b">Cause</th></tr>
      ${C.rows.map(row).join('')}
    </table>
    ${C.retest?.length ? `<h3 style="font-size:15px;margin:18px 0 8px;color:#1d4ed8">Worth re-testing</h3>
    <ol style="margin:0 0 18px;padding-left:20px;font-size:14px;line-height:1.6;color:#0f172a">
      ${li(C.retest)}
    </ol>` : ''}
    ${C.questions?.length ? `<h3 style="font-size:15px;margin:18px 0 8px;color:#1d4ed8">${C.questions.length === 1 ? 'One question for you' : `${C.questions.length} questions for you`}</h3>
    <ol style="margin:0 0 18px;padding-left:20px;font-size:14px;line-height:1.6;color:#0f172a">
      ${li(C.questions)}
    </ol>` : ''}
    ${C.extra ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin:0 0 18px;font-size:13px;line-height:1.5;color:#475569">${C.extra}</div>` : ''}
    <p style="font-size:14px;line-height:1.55;margin:0 0 6px">${C.thanks || 'Thank you for the screenshots &mdash; they are what let us find the causes rather than the symptoms.'}</p>
    <p style="font-size:14px;line-height:1.55;margin:0 0 22px">Vahid</p>
  </div>
  <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:12px 30px;font-size:12px;color:#94a3b8">Attachment: ${esc(pdfName)} &middot; Ticket Pulse v${esc(VERSION)} &middot; Sent by Ticket Pulse on behalf of Vahid Haeri</div>
</div>
</div>`;

const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&mdash;/g, '-').replace(/&middot;/g, '.').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = `Hi Susan,

The full response to your ${PKG} package is attached (${pdfName}).

Short version:
${C.rows.map((r) => `${r.n}. ${strip(r.what)} - ${r.verdict}: ${strip(r.cause)}`).join('\n')}
${C.retest?.length ? `\nWorth re-testing:\n${C.retest.map((s, i) => `${i + 1}. ${strip(s)}`).join('\n')}\n` : ''}${C.questions?.length ? `\nQuestions:\n${C.questions.map((s, i) => `${i + 1}. ${strip(s)}`).join('\n')}\n` : ''}
Vahid`;

const to = [{ email: TO, name: TO === 'sxu@bgcengineering.ca' ? 'Susan Xu' : undefined }];
const cc = TO === 'vhaeri@bgcengineering.ca' ? [] : [{ email: 'vhaeri@bgcengineering.ca', name: 'Vahid Haeri' }];
const msg = {
  personalizations: [{ to, ...(cc.length ? { cc } : {}) }],
  from: { email: fromEmail, name: 'Ticket Pulse' },
  reply_to: { email: 'vhaeri@bgcengineering.ca', name: 'Vahid Haeri' },
  subject: `Ticket Pulse - your ${PKG} QA package: all ${n} answered (PDF attached)`,
  content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
  attachments: [{ content: fs.readFileSync(PDF).toString('base64'), type: 'application/pdf', filename: pdfName, disposition: 'attachment' }],
};
const preview = path.join(path.dirname(path.resolve(CONTENT)), 'email-preview.html');
fs.writeFileSync(preview, html);
if (DRY) { console.log('dry run: preview written to', preview, '| to', TO, cc.length ? '| cc vhaeri' : ''); process.exit(0); }
const res = await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
console.log('SendGrid ->', res.status, res.headers.get('x-message-id') || '', res.status >= 300 ? (await res.text()).slice(0, 300) : 'accepted', '| to', TO, cc.length ? '| cc vhaeri' : '', '| from', fromEmail);
