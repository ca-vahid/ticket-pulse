-- Add ticket_category field to tickets table (custom field: security)
ALTER TABLE "tickets" ADD COLUMN "ticket_category" VARCHAR(100);
