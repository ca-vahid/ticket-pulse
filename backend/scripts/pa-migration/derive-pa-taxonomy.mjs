// PA taxonomy derivation — propose ADDITIONAL top-level categories for the
// Project Accounting workspace from real ticket content (adapted from
// scripts/derive-ar-taxonomy.mjs). READ-ONLY: pulls ticket data + calls the
// app's Anthropic provider; writes ONLY reviewable proposal files.
//
// The starting set is fixed (QA-provided): "Project Setup", "Proposal Setup",
// plus the "General / Other" catch-all (lib.mjs DEFAULT_CATEGORIES). The LLM
// is asked what ELSE the real ticket volume needs. Output:
//   reports/pa-migration[-dev]/proposed-extra-categories.md    (human review)
//   reports/pa-migration[-dev]/proposed-extra-categories.json  (append-ready:
//     after orchestrator/business-owner approval, copy the approved entries
//     into scripts/pa-migration/extra-categories.json — p1 merges that file)
//
//   node scripts/pa-migration/derive-pa-taxonomy.mjs           (dev data)
//   node scripts/pa-migration/derive-pa-taxonomy.mjs --prod    (prod data — orchestrator only; READ-ONLY either way)
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspace, DEFAULT_CATEGORIES, REPORT_DIR } from './lib.mjs';

const { default: prisma } = await import('../../src/services/prisma.js');
const { default: anthropicProvider } = await import('../../src/services/aiProviders/anthropicProvider.js');
const ws = await resolveWorkspace(prisma);

// ---- 1. current signals ----
const legacyDist = await prisma.$queryRawUnsafe(
  `SELECT COALESCE(ticket_category, '(none)') AS cat, count(*)::int AS n
   FROM tickets WHERE workspace_id=$1 GROUP BY 1 ORDER BY n DESC`, ws.id,
);

const tickets = await prisma.$queryRawUnsafe(
  'SELECT id, subject, description_text AS "descText" FROM tickets WHERE workspace_id=$1 ORDER BY id', ws.id,
);
if (tickets.length === 0) throw new Error('workspace has no tickets to derive from');

// ---- 2. subject frequency patterns (normalize away ids/dates/numbers) ----
const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/\b[a-z]*\d[\w.-]*\b/g, ' ') // drop tokens containing digits (project/proposal numbers)
  .replace(/[^a-z\s]/g, ' ')
  .replace(/\b(re|fw|fwd)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const freq = new Map();
for (const t of tickets) {
  const key = normalize(t.subject);
  if (!key || key.length < 3) continue;
  const cur = freq.get(key) || { n: 0, example: t.subject };
  cur.n += 1;
  freq.set(key, cur);
}
const topPatterns = [...freq.entries()]
  .map(([pattern, v]) => ({ pattern, n: v.n, example: v.example }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 300);

// ---- 3. description sample (spread across the base, truncated) ----
const withDesc = tickets.filter((t) => t.descText && t.descText.trim().length > 30);
const step = Math.max(1, Math.floor(withDesc.length / 140));
const descSample = withDesc.filter((_, i) => i % step === 0).slice(0, 140)
  .map((t) => `• [${t.subject?.slice(0, 80) || ''}] ${t.descText.replace(/\s+/g, ' ').trim().slice(0, 380)}`);

console.log(`PA data: ${tickets.length} tickets, ${topPatterns.length} subject patterns, ${descSample.length} description samples`);

// ---- 4. prompt ----
const systemPrompt = `You are an information architect extending a ticket category taxonomy for a corporate **Project Accounting** team's operations support queue in Ticket Pulse.

The taxonomy is FLAT (top-level categories only, no subcategories) and already contains a FIXED starting set that you must NOT rename, remove, or duplicate. Your job is to propose the ADDITIONAL top-level categories (if any) that the real ticket volume clearly needs.

Rules:
- Propose 0–8 additional top-level categories. Fewer, well-grounded categories beat many speculative ones; propose NONE if the fixed set plus the catch-all genuinely covers the volume.
- Every proposal must be grounded in the supplied subject patterns / description samples — cite the evidence.
- Do not propose anything whose tickets would naturally belong in "Project Setup" (post-award project creation/config, cost codes, budgets, project admin) or "Proposal Setup" (pre-award proposals, bids, pursuits) — those exist already.
- Names: concise, human, Title Case, distinct. Definitions: one clear sentence each, phrased so an AI classifier can apply it.
- Provide an approximate ticket-share percentage per proposed category and an overall estimate of how much volume would remain in "General / Other" after your additions.`;

const userMessage = `## Fixed starting set (do not change; propose only ADDITIONS)
${JSON.stringify(DEFAULT_CATEGORIES, null, 1)}

## Current legacy category distribution (raw ticketCategory strings)
${legacyDist.map((c) => `${c.cat}: ${c.n}`).join('\n')}

## Top subject patterns (normalized) with counts and an example
${topPatterns.map((p) => `${p.n}\t${p.pattern}\t(e.g. "${p.example}")`).join('\n')}

## Description samples (${descSample.length})
${descSample.join('\n')}

Return the additions as JSON via the tool.`;

const jsonSchema = {
  type: 'object',
  properties: {
    additions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          est_ticket_share_pct: { type: 'number' },
          evidence: { type: 'string' },
        },
        required: ['name', 'description', 'est_ticket_share_pct', 'evidence'],
      },
    },
    est_general_other_share_pct: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['additions', 'est_general_other_share_pct', 'notes'],
};

console.log('Calling Anthropic to derive additional categories…');
const res = await anthropicProvider.sendJson({
  systemPrompt,
  userMessage,
  maxTokens: 4000,
  temperature: 0.2,
  extra: { jsonSchema },
});
const out = res.parsed;
if (!out || !Array.isArray(out.additions)) {
  console.error('No proposal returned. Raw content:', String(res.content || '').slice(0, 500));
  process.exit(1);
}

// ---- 5. reviewable outputs ----
let md = `# Proposed ADDITIONAL Project Accounting categories (workspace ${ws.id}) — FOR REVIEW\n\n`;
md += `_Derived from ${tickets.length} tickets (${topPatterns.length} subject patterns + ${descSample.length} description samples). `
  + `Fixed set: ${DEFAULT_CATEGORIES.map((c) => c.name).join(', ')}. Nothing has been written to the DB._\n\n`;
md += `> **Model notes:** ${out.notes}\n>\n> Estimated remaining "General / Other" share after additions: ~${Math.round(out.est_general_other_share_pct)}%\n\n`;
if (out.additions.length === 0) {
  md += 'The model proposes **no additional categories** — the fixed set covers the observed volume.\n';
} else {
  md += '| # | Proposed category | ~Share | Definition | Evidence |\n|---|---|---|---|---|\n';
  out.additions.forEach((c, i) => {
    md += `| ${i + 1} | **${c.name}** | ${Math.round(c.est_ticket_share_pct)}% | ${c.description} | ${c.evidence} |\n`;
  });
  md += '\n## To adopt\nCopy the approved entries from `proposed-extra-categories.json` into `backend/scripts/pa-migration/extra-categories.json` (name + description only) and re-run p1.\n';
}

fs.writeFileSync(path.join(REPORT_DIR, 'proposed-extra-categories.md'), md);
fs.writeFileSync(
  path.join(REPORT_DIR, 'proposed-extra-categories.json'),
  JSON.stringify(out.additions.map((c) => ({ name: c.name, description: c.description })), null, 2),
);
console.log(`\nDONE — ${out.additions.length} proposed addition(s).`);
console.log(`Proposal: ${path.join(REPORT_DIR, 'proposed-extra-categories.md')}`);
console.log(`Append-ready JSON: ${path.join(REPORT_DIR, 'proposed-extra-categories.json')}`);
console.log(`Tokens: in=${res.usage?.inputTokens} out=${res.usage?.outputTokens}`);
await prisma.$disconnect();
