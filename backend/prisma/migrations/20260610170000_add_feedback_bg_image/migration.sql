-- Custom background image for the public feedback page (admin "Bring your own" v1).
-- Overrides the theme's built-in background when set; NULL means use the theme default.
ALTER TABLE "public_feedback_settings" ADD COLUMN "bg_image_data_url" TEXT;
