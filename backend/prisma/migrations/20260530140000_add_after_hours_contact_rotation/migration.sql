ALTER TABLE "urgent_escalation_policies"
  ADD COLUMN "after_hours_contact_mode" VARCHAR(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN "after_hours_manual_technician_id" INTEGER,
  ADD COLUMN "after_hours_rotation_order" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "after_hours_rotation_anchor_date" TIMESTAMP(3),
  ADD COLUMN "show_after_hours_phone_in_email" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "urgent_escalation_policies_after_hours_manual_technician_id_idx"
  ON "urgent_escalation_policies"("after_hours_manual_technician_id");
