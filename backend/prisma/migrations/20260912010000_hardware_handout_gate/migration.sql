-- Assetron hardware handout gate (09-12).
-- Marks the internal categories where a laptop/desktop is handed to a person.
-- Ticket Pulse owns this list so an integrator never has to name a category.
ALTER TABLE "competency_categories"
  ADD COLUMN IF NOT EXISTS "gates_hardware" BOOLEAN NOT NULL DEFAULT false;

-- Partial index: the gate only ever reads the flagged rows.
CREATE INDEX IF NOT EXISTS "competency_categories_gates_hardware_idx"
  ON "competency_categories" ("workspace_id")
  WHERE "gates_hardware" = true;
