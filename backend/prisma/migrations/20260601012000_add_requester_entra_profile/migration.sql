ALTER TABLE "requesters"
ADD COLUMN "entra_office_location" VARCHAR(255),
ADD COLUMN "entra_city" VARCHAR(255),
ADD COLUMN "entra_state" VARCHAR(100),
ADD COLUMN "entra_country" VARCHAR(100),
ADD COLUMN "entra_country_code" VARCHAR(10),
ADD COLUMN "entra_department" VARCHAR(255),
ADD COLUMN "entra_job_title" VARCHAR(255),
ADD COLUMN "entra_preferred_language" VARCHAR(50),
ADD COLUMN "entra_profile_synced_at" TIMESTAMP(3);

CREATE INDEX "requesters_entra_office_location_idx" ON "requesters"("entra_office_location");
CREATE INDEX "requesters_entra_country_idx" ON "requesters"("entra_country");
