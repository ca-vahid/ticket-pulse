-- Several Assetron devices on one approval request (Vahid, 29 Sep 2026: up to
-- 5 hardware items, each from Assetron or entered by hand). One hold per item.
ALTER TABLE "assetron_reservations" ADD COLUMN IF NOT EXISTS "item_index" INTEGER NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS "assetron_reservations_request_group_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "assetron_reservations_request_group_id_item_index_key" ON "assetron_reservations"("request_group_id", "item_index");
