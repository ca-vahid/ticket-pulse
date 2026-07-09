// Shared plumbing for the AR onboarding scripts (ws2).
// Import FIRST in every phase script. DEV by default; pass --prod to run
// against production (loads backend/scripts/.env.prod). Mirrors the proven
// ap-reorg script pattern: dry-run default, --apply to execute, snapshots
// under reports/ar-onboarding.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WS = 2;
export const SOURCE = 'ar_onboarding_2026_07';
export const REPORT_DIR = path.resolve(__dirname, '../../../reports/ar-onboarding');
fs.mkdirSync(REPORT_DIR, { recursive: true });

const dotenv = (file) => {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );
};
const localEnv = dotenv(path.resolve(__dirname, '../../.env'));
for (const [k, v] of Object.entries(localEnv)) if (!(k in process.env)) process.env[k] = v;

export const PROD = process.argv.includes('--prod');
if (PROD) {
  const prodEnv = dotenv(path.resolve(__dirname, '../.env.prod'));
  if (!prodEnv.PROD_DATABASE_URL) throw new Error('PROD_DATABASE_URL missing from backend/scripts/.env.prod');
  process.env.DATABASE_URL = prodEnv.PROD_DATABASE_URL;
}

export const APPLY = process.argv.includes('--apply');
export const mode = () => `${APPLY ? 'APPLY' : 'DRY-RUN'} on ${PROD ? 'PROD' : 'DEV'}`;

export const snap = (name, data) => {
  const file = path.join(REPORT_DIR, `${PROD ? 'prod' : 'dev'}-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  console.log(`  snapshot: ${path.basename(file)} (${Array.isArray(data) ? data.length : 'obj'})`);
  return file;
};

// The 10 AR categories — names VERBATIM from Alexa Faerber's list (2026-07-09).
// Descriptions are IT drafts to steer the AI classifier; flagged for Alexa's
// review before prod apply (names must not change without her sign-off).
export const AR_CATEGORIES = [
  { name: 'Remittances', description: 'Payment remittance advices — a client notifies that a deposit, EFT, or wire has been sent to our account; posting and confirmation of received payments.' },
  { name: 'Collection Notes', description: 'Collection notices for outstanding balances and the follow-up threads with project managers and clients, including escalations and legal involvement.' },
  { name: 'Client Portal Inquiry', description: 'Questions about client payment or invoicing portals — registration, access, and submitting or retrieving invoices through a client’s portal.' },
  { name: 'Banking Details Inquiry', description: 'Requests to confirm or update our banking details for client payments — bank letters, EFT setup, and payment-instruction verification.' },
  { name: 'Credit Memos/Client Refunds', description: 'Issuing credit memos to clients and refunding client overpayments on project invoices.' },
  { name: 'Non-Project Related Refunds', description: 'Refunds not tied to project billing — miscellaneous receipts, deposits, and other non-project reimbursements to external parties.' },
  { name: 'Tax Inquiry', description: 'Client questions about taxes on invoices — GST/PST/HST, withholding, tax registration numbers, and tax documentation requests.' },
  { name: 'Invoice Inquiry', description: 'Client questions about an issued invoice — copies, backup or supporting detail, PO references, and invoice disputes. (AR-side: invoices WE issued to clients.)' },
  { name: 'Payment Status Inquiry', description: 'Questions about the status of client payments and outstanding balances — has a payment been received, what remains owing on an account.' },
  { name: 'Client Paid Incorrect Company/Currency', description: 'Payments received into the wrong BGC entity or in the wrong currency — reallocation and correction handling.' },
];

// Skill seeding plan (edit before running p3). Levels: basic|intermediate|advanced|expert.
// 'ALL' expands to every AR category. Missing technicians are skipped with a warning
// (Alexa is not onboarded yet — rerun p3 after her technician row exists).
export const SKILL_SEED = [
  { email: 'afaerber@bgcengineering.ca', level: 'expert', categories: 'ALL' }, // Alexa — AR owner (verify email before prod apply)
  { email: 'brabel@bgcengineering.ca', level: 'advanced', categories: ['Collection Notes'] }, // Ben — collections stream (verify email)
];
