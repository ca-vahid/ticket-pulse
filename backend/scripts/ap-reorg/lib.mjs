// Shared plumbing for the AP category reorg scripts (ws2, PROD).
// Import FIRST in every phase script — it wires DATABASE_URL to prod (from
// scripts/.env.prod) BEFORE prisma is loaded, and provides snapshot helpers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WS = 2;
export const SOURCE = 'ap_reorg_2026_07';
export const REPORT_DIR = path.resolve(__dirname, '../../../reports/ap-reorg');
fs.mkdirSync(REPORT_DIR, { recursive: true });

// Load local .env (Anthropic key etc.) then FORCE the prod DB URL.
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
const prodEnv = dotenv(path.resolve(__dirname, '../.env.prod'));
const prodUrl = prodEnv.PROD_DATABASE_URL;
if (!prodUrl) throw new Error('PROD_DATABASE_URL missing from backend/scripts/.env.prod');
process.env.DATABASE_URL = prodUrl;

export const APPLY = process.argv.includes('--apply');
export const mode = () => (APPLY ? 'APPLY' : 'DRY-RUN');

export const snap = (name, data) => {
  const file = path.join(REPORT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  console.log(`  snapshot: ${path.basename(file)} (${Array.isArray(data) ? data.length : 'obj'})`);
  return file;
};
export const readSnap = (name) => JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${name}.json`), 'utf8'));
export const writeReport = (name, text) => {
  fs.writeFileSync(path.join(REPORT_DIR, name), text);
  console.log(`  report: ${name}`);
};

// The 11 new AP top categories (client-provided, verbatim).
export const NEW_CATEGORIES = [
  { name: 'Vendor Invoices', description: 'General supplier invoices received for goods or services that require review, coding, and payment.' },
  { name: 'Vendor Statements & Reconciliation', description: 'Vendor account statements, balance verification, reconciliation activities, and follow-up on outstanding items.' },
  { name: 'Vendor Onboarding & Banking', description: 'New vendor setup, banking information changes, EFT enrollment, and vendor account maintenance.' },
  { name: 'Payment Processing', description: 'Payment execution, payment confirmations, EFTs, credit card transactions, and related payment notifications.' },
  { name: 'Invoice Approval Workflow', description: 'Invoice approval requests, coding reviews, approval routing, and payment authorization processes.' },
  { name: 'Expense Reports', description: 'Employee expense submissions, approvals, reimbursements, and expense system support.' },
  { name: 'Travel & Accommodation', description: 'Travel-related invoices, bookings, accommodations, rentals, and travel expense administration.' },
  { name: 'Software & Technology Billing', description: 'Software subscriptions, cloud services, technology vendor invoices, renewals, and licensing costs.' },
  { name: 'Facilities & Office Operations', description: 'Office-related expenses including leases, building services, office supplies, cleaning services, and workplace operations.' },
  { name: 'Shipping & Logistics', description: 'Shipping, courier, freight, customs, brokerage, and transportation-related invoices and charges.' },
  { name: 'Inbox Management', description: 'General email triage, spam & marketing, internal requests, notifications, and non-financial correspondence.' },
];

// Old top-category id → new category NAME for the deterministic 1:1 buckets.
// AI-mode old ids (ambiguous content) are classified per ticket instead.
export const DETERMINISTIC_MAP = {
  163: 'Vendor Invoices',                       // Instacart Business Invoices & Payments
  164: 'Vendor Invoices',                       // Amazon Business Invoices & Credits
  165: 'Shipping & Logistics',                  // Shipping & Courier Invoices
  166: 'Travel & Accommodation',                // Corporate Travel Invoices
  168: 'Facilities & Office Operations',        // Office Supply & Facilities Vendor Invoices
  169: 'Software & Technology Billing',         // SaaS, Software & Subscription Invoices
  170: 'Vendor Invoices',                       // Professional Services & Contractor Invoices
  172: 'Vendor Statements & Reconciliation',    // Vendor Statements & Account Reconciliation
  173: 'Payment Processing',                    // Payment Processing & EFT Confirmations
  174: 'Invoice Approval Workflow',             // Vendor Invoice Approval Workflow
  175: 'Expense Reports',                       // Expense Report Management
  177: 'Inbox Management',                      // Email Triage & Inbox Management
  178: 'Facilities & Office Operations',        // Facility & Lease Billing
  179: 'Vendor Invoices',                       // Hardware, Equipment & Field Supply Invoices
};
// AI-mode buckets: 167 Telecom & Utility, 171 Professional Licensing,
// 176 AR & Collections, 180 System & Tool Support, plus strays + uncategorized.
export const AI_MODE_IDS = [167, 171, 176, 180];

// Competency remap targets for ALL old ids (competencies don't get per-row AI;
// ambiguous ones take the plan's chosen home).
export const COMPETENCY_MAP = {
  ...DETERMINISTIC_MAP,
  167: 'Facilities & Office Operations',
  171: 'Vendor Invoices',
  176: 'Vendor Statements & Reconciliation',
  180: 'Software & Technology Billing',
};

export const RANK = { basic: 1, intermediate: 2, advanced: 3, expert: 4 };
export const bestLevel = (a, b) => (RANK[a] >= RANK[b] ? a : b);
