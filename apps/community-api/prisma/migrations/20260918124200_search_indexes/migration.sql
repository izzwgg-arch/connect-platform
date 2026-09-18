-- Search: Postgres full-text (tsvector generated columns) + trigram for typo
-- tolerance. pgvector is an optional seam (see search/semantic.ts); it is
-- created only when the extension is present.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE "Profile"      ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;
ALTER TABLE "Organization" ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;
ALTER TABLE "Post"         ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;
ALTER TABLE "Job"          ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;
ALTER TABLE "Listing"      ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;
ALTER TABLE "Rfq"          ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;
ALTER TABLE "Opportunity"  ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;
ALTER TABLE "Group"        ADD COLUMN "searchText" text;
ALTER TABLE "Group"        ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;
ALTER TABLE "Event"        ADD COLUMN "searchText" text;
ALTER TABLE "Event"        ADD COLUMN "searchTsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("searchText", ''))) STORED;

CREATE INDEX "Profile_searchTsv_idx"      ON "Profile"      USING GIN ("searchTsv");
CREATE INDEX "Organization_searchTsv_idx" ON "Organization" USING GIN ("searchTsv");
CREATE INDEX "Post_searchTsv_idx"         ON "Post"         USING GIN ("searchTsv");
CREATE INDEX "Job_searchTsv_idx"          ON "Job"          USING GIN ("searchTsv");
CREATE INDEX "Listing_searchTsv_idx"      ON "Listing"      USING GIN ("searchTsv");
CREATE INDEX "Rfq_searchTsv_idx"          ON "Rfq"          USING GIN ("searchTsv");
CREATE INDEX "Opportunity_searchTsv_idx"  ON "Opportunity"  USING GIN ("searchTsv");
CREATE INDEX "Group_searchTsv_idx"        ON "Group"        USING GIN ("searchTsv");
CREATE INDEX "Event_searchTsv_idx"        ON "Event"        USING GIN ("searchTsv");

CREATE INDEX "Profile_searchText_trgm"      ON "Profile"      USING GIN ("searchText" gin_trgm_ops);
CREATE INDEX "Organization_searchText_trgm" ON "Organization" USING GIN ("searchText" gin_trgm_ops);
CREATE INDEX "Job_searchText_trgm"          ON "Job"          USING GIN ("searchText" gin_trgm_ops);
CREATE INDEX "Listing_searchText_trgm"      ON "Listing"      USING GIN ("searchText" gin_trgm_ops);

-- One accepted quote per RFQ, enforced by the database, not by code paths.
CREATE UNIQUE INDEX "Quote_one_accepted_per_rfq" ON "Quote" ("rfqId") WHERE "status" = 'ACCEPTED';

-- Only one open moderation case per target (the @@unique in the schema covers
-- (target, status); this stops two OPEN/IN_REVIEW cases at once).
CREATE UNIQUE INDEX "ModerationCase_one_open_per_target" ON "ModerationCase" ("targetType", "targetId") WHERE "status" IN ('OPEN','IN_REVIEW');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
    EXECUTE 'ALTER TABLE "Profile" ADD COLUMN "embedding" vector(768)';
    EXECUTE 'ALTER TABLE "Organization" ADD COLUMN "embedding" vector(768)';
  END IF;
END $$;
