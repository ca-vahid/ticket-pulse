ALTER TABLE "competency_change_requests"
  ADD COLUMN "request_group_id" VARCHAR(64);

CREATE INDEX "competency_change_requests_workspace_id_request_group_id_idx"
  ON "competency_change_requests"("workspace_id", "request_group_id");
