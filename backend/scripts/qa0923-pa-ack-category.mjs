// QA 09-23 #1: Project Accounting's "Ticket arrived" mail (workflow 11369)
// showed an empty "Request Type" — the field only Power Apps sets. Replace it
// with the category, and fix the text part's ticket number (FreshService id is
// blank for Ticket Pulse tickets). Publishes a new version through the
// repository (history kept). Refuses when the draft has unpublished edits.
// Dry run by default.
//
//   DATABASE_URL="<prod>&connection_limit=1" node --env-file=.env scripts/qa0923-pa-ack-category.mjs [--apply]
/* eslint-disable no-console */
import prisma from '../src/services/prisma.js';
import { saveDraft, publishWorkflow } from '../src/services/notificationWorkflowRepository.js';

const WORKFLOW_ID = 11369;
const WORKSPACE_ID = 5;
const APPLY = process.argv.includes('--apply');
const SWAPS = [
  ['{{ ticket.customFields.source_request_type }}', '{{ ticket.internalCategory.name | default: "Being triaged" }}'],
  ['Request Type', 'Category'],
  ['#{{ ticket.freshserviceTicketId }}', '#{{ ticket.displayRef }}'],
];

const w = await prisma.notificationWorkflow.findFirst({ where: { id: WORKFLOW_ID, workspaceId: WORKSPACE_ID } });
if (!w) throw new Error('workflow not found');
if (JSON.stringify(w.draftDefinition) !== JSON.stringify(w.publishedDefinition)) {
  throw new Error('The draft has unpublished edits — not touching it. Publish or discard them first.');
}
const counts = SWAPS.map(() => 0);
const walk = (v) => {
  if (typeof v === 'string') {
    let out = v;
    SWAPS.forEach(([from, to], i) => { const n = out.split(from).length - 1; counts[i] += n; out = out.split(from).join(to); });
    return out;
  }
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  return v;
};
const next = walk(w.publishedDefinition);
SWAPS.forEach(([from, to], i) => console.log(`${counts[i]} × "${from}" → "${to}"`));
if (!counts[0]) throw new Error('source_request_type not found — already changed?');
if (!APPLY) { console.log(`Dry run (v${w.publishedVersion}). Pass --apply to publish v${w.publishedVersion + 1}.`); await prisma.$disconnect(); process.exit(0); }

const actor = { email: 'ticketpulse-qa-0923@bgcengineering.ca', name: 'QA 09-23 #1' };
await saveDraft(WORKSPACE_ID, WORKFLOW_ID, { definition: next }, actor);
const out = await publishWorkflow(WORKSPACE_ID, WORKFLOW_ID, { enabled: w.isEnabled, changeNote: 'QA 09-23 #1: category instead of the Power-Apps-only request type; text part uses the TP ticket number' }, actor);
console.log(`Published v${out.publishedVersion ?? out.workflow?.publishedVersion ?? '?'} (enabled: ${w.isEnabled})`);
await prisma.$disconnect();
process.exit(0);
