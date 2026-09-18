-- Saved jobs (candidate side). Mirrors the "Save" table shape (post saves) but
-- keyed to Job, since a job save is not a post save.
CREATE TABLE "JobSave" (
    "personId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobSave_pkey" PRIMARY KEY ("personId","jobId")
);

CREATE INDEX "JobSave_jobId_idx" ON "JobSave"("jobId");

ALTER TABLE "JobSave" ADD CONSTRAINT "JobSave_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobSave" ADD CONSTRAINT "JobSave_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
