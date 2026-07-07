/**
 * One-off similar-tickets embedding backfill against PROD (gap plan 2 P5.2
 * post-deploy warm-up). Read-only against tickets; writes only
 * ticket_embeddings rows. Uses the local OPENAI_API_KEY.
 *
 * Run from backend/: node scripts/backfill-embeddings-prod.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prodUrl = fs.readFileSync(path.join(__dirname, '.env.prod'), 'utf8')
  .match(/PROD_DATABASE_URL=(.*)/)[1].trim().replace(/^["']|["']$/g, '');
process.env.DATABASE_URL = prodUrl;

const { default: prisma } = await import('../src/services/prisma.js');
const { default: ticketEmbeddingService } = await import('../src/services/ticketEmbeddingService.js');

const workspaces = await prisma.workspace.findMany({ where: { isActive: true }, select: { id: true, name: true } });
for (const ws of workspaces) {
  const result = await ticketEmbeddingService.backfillWorkspace(ws.id, { max: 800, sinceDays: 90 });
  console.log(`[${ws.name}] embedded ${result.embedded}/${result.scanned ?? 0}`);
}
const total = await prisma.ticketEmbedding.count();
console.log(`ticket_embeddings rows on prod: ${total}`);
process.exit(0);
