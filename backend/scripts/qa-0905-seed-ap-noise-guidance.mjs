#!/usr/bin/env node
/**
 * Seed the Accounts Payable noise guidance (QA 09-05, Accounting option 2).
 *
 * The AI called 1,535 Accounting tickets non-actionable in 180 days and a
 * person was assigned 844 of them anyway. The cause is not a bad model, it is
 * a heuristic learned in the wrong room: in IT a no-reply sender usually IS
 * noise, and in Accounts Payable the vendor robots are the customers.
 *
 * This writes the workspace's own definition of noise, which the pipeline
 * injects into the system prompt as an OVERRIDING section. The same text is
 * one click away in Settings → Noise Rules ("Insert Accounts Payable
 * wording"), so Accounting can edit it afterwards without a deploy — this
 * script only makes it live on day one.
 *
 *   node scripts/qa-0905-seed-ap-noise-guidance.mjs                 # dry run
 *   node scripts/qa-0905-seed-ap-noise-guidance.mjs --apply
 *   node scripts/qa-0905-seed-ap-noise-guidance.mjs --workspace 2 --apply
 *   node scripts/qa-0905-seed-ap-noise-guidance.mjs --clear --apply
 */
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const after = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = has('--apply');
const workspaceId = Number(after('--workspace') || 2);

// Kept character-for-character in step with AP_GUIDANCE_TEMPLATE in
// frontend/src/components/NoiseRulesPanel.jsx.
const AP_GUIDANCE = [
  'This is an Accounts Payable / Accounts Receivable mailbox. Automated senders are our CUSTOMERS here, not noise.',
  '',
  'TREAT AS REAL WORK (never noise), even from a no-reply or automated address:',
  '- Invoices, statements, remittance advice, payment confirmations and receipts',
  '- Purchase orders, credit notes, dunning and past-due notices',
  '- Vendor account, banking or tax-detail changes',
  '- Anything naming an invoice number, account number or an amount to be actioned',
  '',
  'TREAT AS NOISE:',
  '- Marketing, newsletters, product announcements, webinar and event invitations',
  '- Conference, giveaway and survey invitations',
  '- Phishing and spoofed payment-change requests (flag rather than dismiss when money is involved)',
  '- Delivery/read receipts and out-of-office auto-replies',
  '',
  'When one sender sends both kinds of mail from the same address, judge the message, not the sender.',
].join('\n');

const prisma = new PrismaClient();

try {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
  if (!ws) { console.error(`No workspace ${workspaceId}.`); process.exit(1); }

  const cfg = await prisma.assignmentConfig.findUnique({
    where: { workspaceId },
    select: { noiseGuidance: true, autoCloseNoise: true },
  });
  if (!cfg) { console.error(`Workspace ${workspaceId} has no assignment config.`); process.exit(1); }

  const next = has('--clear') ? null : AP_GUIDANCE;
  console.log(`Workspace ${ws.id} "${ws.name}"`);
  console.log(`  auto-close noise: ${cfg.autoCloseNoise ? 'ON' : 'off'}${cfg.autoCloseNoise ? '  <-- careful: a wrong verdict CLOSES tickets here' : '  (a wrong verdict costs a label, not a ticket)'}`);
  console.log(`  current guidance: ${cfg.noiseGuidance ? `${cfg.noiseGuidance.length} chars` : '(none — using the built-in guidance)'}`);
  console.log(`  new guidance:     ${next ? `${next.length} chars` : '(cleared)'}`);

  if (cfg.noiseGuidance && next && cfg.noiseGuidance !== next) {
    console.log('\n  NOTE: this workspace already has its OWN guidance, which this would replace:');
    console.log(`  ${cfg.noiseGuidance.slice(0, 200).replace(/\n/g, '\n  ')}…`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write.');
    if (next) console.log(`\n--- guidance to be written ---\n${next}`);
  } else {
    await prisma.assignmentConfig.update({ where: { workspaceId }, data: { noiseGuidance: next } });
    console.log('\nWritten. It takes effect on the next pipeline run — no restart needed.');
  }
} finally {
  await prisma.$disconnect();
}
