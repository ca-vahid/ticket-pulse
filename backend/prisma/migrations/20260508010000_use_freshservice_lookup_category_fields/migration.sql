ALTER TABLE "workspaces"
  ALTER COLUMN "tp_skill_custom_field" SET DEFAULT 'lf_ticket_pulse_category',
  ALTER COLUMN "tp_subskill_custom_field" SET DEFAULT 'lf_ticket_pulse_subcategory';

UPDATE "workspaces"
SET
  "tp_skill_custom_field" = 'lf_ticket_pulse_category',
  "tp_subskill_custom_field" = 'lf_ticket_pulse_subcategory'
WHERE "id" = 1 OR "freshservice_workspace_id" = 2;
