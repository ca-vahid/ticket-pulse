import crypto from 'node:crypto';
import OpenAI from 'openai';
import prisma from './prisma.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Ticket content embeddings for similar-ticket suggestions (gap plan 2 P5.2).
 *
 * Embeddings are 256-dim OpenAI text-embedding-3-small vectors stored as
 * float[]; similarity is cosine computed app-side over a bounded candidate
 * set (the workspace's most recently embedded tickets). pgvector is available
 * on the prod server (0.8.2) but not allow-listed in azure.extensions yet —
 * this design upgrades to an indexed pgvector column without an API change.
 *
 * Everything here is best-effort: no OpenAI key → feature quietly off.
 */

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 256;
const MAX_CONTENT_CHARS = 6000;
const CANDIDATE_POOL = 800; // newest embeddings scanned per similarity query
const BACKFILL_BATCH = 64;
const BACKFILL_PAUSE_MS = 500;

let client = null;

function getClient() {
  if (client) return client; // also the test seam (_setClient)
  if (!config.openai.apiKey) return null;
  client = new OpenAI({ apiKey: config.openai.apiKey });
  return client;
}

export function isEmbeddingConfigured() {
  return !!(client || config.openai.apiKey);
}

function contentOf(ticket) {
  const text = [ticket.subject, ticket.descriptionText].filter(Boolean).join('\n').trim();
  return text.slice(0, MAX_CONTENT_CHARS);
}

function hashOf(text) {
  return crypto.createHash('sha256').update(`${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}:${text}`).digest('hex');
}

export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function embedTexts(texts) {
  const api = getClient();
  if (!api) return null;
  const res = await api.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return res.data
    .sort((x, y) => x.index - y.index)
    .map((d) => d.embedding);
}

class TicketEmbeddingService {
  /**
   * (Re)generate the embedding for one ticket. Skips silently when the
   * content hash is unchanged, the ticket has no text, or no key is set.
   * Never throws — call fire-and-forget from write paths.
   */
  async upsertForTicket(ticketId, workspaceId) {
    try {
      if (!isEmbeddingConfigured()) return null;
      const ticket = await prisma.ticket.findFirst({
        where: { id: ticketId, workspaceId },
        select: { id: true, subject: true, descriptionText: true },
      });
      if (!ticket) return null;
      const content = contentOf(ticket);
      if (!content) return null;
      const contentHash = hashOf(content);

      const existing = await prisma.ticketEmbedding.findUnique({
        where: { ticketId },
        select: { contentHash: true, model: true },
      });
      if (existing && existing.contentHash === contentHash && existing.model === EMBEDDING_MODEL) return null;

      const [embedding] = await embedTexts([content]) || [];
      if (!embedding) return null;

      await prisma.ticketEmbedding.upsert({
        where: { ticketId },
        create: { ticketId, workspaceId, embedding, model: EMBEDDING_MODEL, contentHash },
        update: { embedding, model: EMBEDDING_MODEL, contentHash },
      });
      return { ticketId, dims: embedding.length };
    } catch (err) {
      logger.warn(`Ticket embedding upsert failed for ${ticketId} (non-fatal): ${err.message}`);
      return null;
    }
  }

  /**
   * Top-N tickets similar by content. Returns [{ticketId, score}] sorted by
   * score desc; empty when unconfigured or the ticket has no embedding yet.
   */
  async similarByContent(ticketId, workspaceId, { limit = 5, minScore = 0.5 } = {}) {
    try {
      if (!isEmbeddingConfigured()) return [];
      let own = await prisma.ticketEmbedding.findUnique({
        where: { ticketId },
        select: { embedding: true, workspaceId: true },
      });
      if (!own) {
        await this.upsertForTicket(ticketId, workspaceId);
        own = await prisma.ticketEmbedding.findUnique({
          where: { ticketId },
          select: { embedding: true, workspaceId: true },
        });
      }
      if (!own || own.workspaceId !== workspaceId) return [];

      const candidates = await prisma.ticketEmbedding.findMany({
        where: { workspaceId, ticketId: { not: ticketId }, model: EMBEDDING_MODEL },
        orderBy: { updatedAt: 'desc' },
        take: CANDIDATE_POOL,
        select: { ticketId: true, embedding: true },
      });

      return candidates
        .map((c) => ({ ticketId: c.ticketId, score: cosineSimilarity(own.embedding, c.embedding) }))
        .filter((c) => c.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (err) {
      logger.warn(`Similar-ticket query failed for ${ticketId} (non-fatal): ${err.message}`);
      return [];
    }
  }

  /**
   * Backfill sweep: embed recent tickets that have no embedding row yet.
   * Rate-limited (batched + paused); safe to run nightly.
   */
  async backfillWorkspace(workspaceId, { max = 500, sinceDays = 90 } = {}) {
    if (!isEmbeddingConfigured()) return { embedded: 0, skipped: 'unconfigured' };
    const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
    const missing = await prisma.ticket.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since },
        embedding: null,
      },
      orderBy: { createdAt: 'desc' },
      take: max,
      select: { id: true, subject: true, descriptionText: true },
    });

    let embedded = 0;
    for (let i = 0; i < missing.length; i += BACKFILL_BATCH) {
      const batch = missing.slice(i, i + BACKFILL_BATCH)
        .map((t) => ({ id: t.id, content: contentOf(t) }))
        .filter((t) => t.content);
      if (!batch.length) continue;
      try {
        const vectors = await embedTexts(batch.map((t) => t.content));
        if (!vectors) break;
        for (let j = 0; j < batch.length; j++) {
          await prisma.ticketEmbedding.upsert({
            where: { ticketId: batch[j].id },
            create: {
              ticketId: batch[j].id,
              workspaceId,
              embedding: vectors[j],
              model: EMBEDDING_MODEL,
              contentHash: hashOf(batch[j].content),
            },
            update: {
              embedding: vectors[j],
              model: EMBEDDING_MODEL,
              contentHash: hashOf(batch[j].content),
            },
          });
          embedded++;
        }
      } catch (err) {
        logger.warn(`Embedding backfill batch failed for workspace ${workspaceId}: ${err.message}`);
        break; // rate-limit or outage — the next sweep resumes
      }
      if (i + BACKFILL_BATCH < missing.length) {
        await new Promise((r) => setTimeout(r, BACKFILL_PAUSE_MS));
      }
    }
    if (embedded > 0) logger.info(`Embedding backfill: ${embedded} tickets embedded in workspace ${workspaceId}`);
    return { embedded, scanned: missing.length };
  }

  /** Test hook. */
  _setClient(fake) {
    client = fake;
  }
}

const ticketEmbeddingService = new TicketEmbeddingService();
export default ticketEmbeddingService;
