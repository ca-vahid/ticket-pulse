-- Gap plan 2 Phase 5: requester sentiment + ticket content embeddings.
-- Additive only.

-- 5.1 Requester sentiment (team-safe: requester state, never agent metrics)
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "sentiment" VARCHAR(16);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "sentiment_computed_at" TIMESTAMP(3);

-- 5.2 Content embeddings for similar-ticket suggestions (float[] cosine;
-- pgvector upgrade deferred until azure.extensions allows CREATE EXTENSION vector)
CREATE TABLE IF NOT EXISTS "ticket_embeddings" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "model" VARCHAR(80) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_embeddings_ticket_id_key" ON "ticket_embeddings"("ticket_id");
CREATE INDEX IF NOT EXISTS "ticket_embeddings_workspace_id_updated_at_idx" ON "ticket_embeddings"("workspace_id", "updated_at");

ALTER TABLE "ticket_embeddings" ADD CONSTRAINT "ticket_embeddings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_embeddings" ADD CONSTRAINT "ticket_embeddings_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
