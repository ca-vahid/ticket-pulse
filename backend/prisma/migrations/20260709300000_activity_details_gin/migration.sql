-- Gap plan P3.3: push the technician-activity JSON filter into SQL. GIN
-- (jsonb_path_ops) supports the @> containment queries the repository now
-- issues instead of scanning recent rows and filtering in JS.

CREATE INDEX IF NOT EXISTS "ticket_activities_details_gin"
    ON "ticket_activities" USING GIN ("details" jsonb_path_ops);
