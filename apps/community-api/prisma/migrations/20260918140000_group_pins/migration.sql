-- Pinned post ids for a group's Feed tab (small, ordered list — no separate pin table).
ALTER TABLE "Group" ADD COLUMN "pinnedPostIds" TEXT[] NOT NULL DEFAULT '{}';
