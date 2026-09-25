-- FS-born notes gap (plans/FS_THREAD_SYNC_GAP_REPORT.md, 24 Sep 2026): when the
-- thread-pull worker last read this ticket's whole FreshService conversation.
-- The preheat cursor could read "caught up" with notes still missing.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "fs_thread_pulled_at" TIMESTAMP(3);
