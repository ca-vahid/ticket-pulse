-- Impact + urgency as optional separate fields (gap plan P2.5). TP-side
-- annotations: 1=Low 2=Medium 3=High. Priority stays the operative field;
-- these add ITSM-style nuance and workflow-condition inputs.

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "impact" SMALLINT;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "urgency" SMALLINT;
