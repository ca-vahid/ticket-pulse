-- Reports show who generated them: store the display name alongside the
-- audit email (feedback 07-14: 'vhaeri' -> 'Vahid Haeri').
ALTER TABLE "analytics_reports" ADD COLUMN "created_by_name" VARCHAR(255);
