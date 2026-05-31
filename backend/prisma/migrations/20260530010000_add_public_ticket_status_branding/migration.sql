ALTER TABLE "public_ticket_status_settings"
  ADD COLUMN "brand_name" VARCHAR(120),
  ADD COLUMN "logo_data_url" TEXT,
  ADD COLUMN "logo_alt_text" VARCHAR(160),
  ADD COLUMN "trademark_text" VARCHAR(300),
  ADD COLUMN "accent_color" VARCHAR(24);
