-- CreateTable: Requesters table to cache FreshService requester data
CREATE TABLE "requesters" (
    "id" SERIAL NOT NULL,
    "freshservice_id" BIGINT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(50),
    "mobile" VARCHAR(50),
    "department" VARCHAR(255),
    "job_title" VARCHAR(255),
    "time_zone" VARCHAR(100),
    "language" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requesters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "requesters_freshservice_id_key" ON "requesters"("freshservice_id");
CREATE INDEX "requesters_freshservice_id_idx" ON "requesters"("freshservice_id");
CREATE INDEX "requesters_email_idx" ON "requesters"("email");

-- AlterTable: Drop old requester columns from tickets and add new relationship
ALTER TABLE "tickets" DROP COLUMN IF EXISTS "requester_name";
ALTER TABLE "tickets" DROP COLUMN IF EXISTS "requester_email";

-- AlterTable: Rename requester_id to requester_freshservice_id to store FreshService ID
ALTER TABLE "tickets" RENAME COLUMN "requester_id" TO "requester_freshservice_id";

-- AlterTable: Add new requester_id column for internal relationship
ALTER TABLE "tickets" ADD COLUMN "requester_id" INTEGER;

-- CreateIndex
CREATE INDEX "tickets_requester_freshservice_id_idx" ON "tickets"("requester_freshservice_id");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "requesters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
