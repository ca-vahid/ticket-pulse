-- Idempotency: key on the credential BUCKET (API key OR OAuth client) and allow
-- a reservation row (NULL status_code / response_body) written BEFORE execution.
--
-- Before: unique was (api_key_id, idem_key) with api_key_id NOT NULL, so OAuth
-- callers (no api_key_id) threw and the error was swallowed → no idempotency at
-- all. And the replay row was only written on finish, so two concurrent retries
-- both executed. Keying on a principal string + a pre-execution reservation
-- fixes both.

ALTER TABLE "api_idempotency_keys" ADD COLUMN "principal" VARCHAR(120);
UPDATE "api_idempotency_keys" SET "principal" = 'key:' || "api_key_id" WHERE "principal" IS NULL;
ALTER TABLE "api_idempotency_keys" ALTER COLUMN "principal" SET NOT NULL;

ALTER TABLE "api_idempotency_keys" ALTER COLUMN "api_key_id" DROP NOT NULL;
ALTER TABLE "api_idempotency_keys" ALTER COLUMN "status_code" DROP NOT NULL;
ALTER TABLE "api_idempotency_keys" ALTER COLUMN "response_body" DROP NOT NULL;

DROP INDEX IF EXISTS "api_idempotency_keys_api_key_id_idem_key_key";
CREATE UNIQUE INDEX "api_idempotency_keys_principal_idem_key_key"
  ON "api_idempotency_keys" ("principal", "idem_key");
