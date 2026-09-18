-- ModerationCase_targetType_targetId_status_key was a FULL unique index over
-- (targetType, targetId, status). That means a target could only ever have ONE
-- case reach a given status in its lifetime: a second repeat-offender case that
-- resolves to ACTIONED would collide with the first one that also resolved to
-- ACTIONED, months earlier. The real invariant ("only one OPEN/IN_REVIEW case
-- per target at a time") is already enforced separately by the PARTIAL unique
-- index ModerationCase_one_open_per_target (status IN ('OPEN','IN_REVIEW')),
-- so the full index is dropped and replaced with a plain (non-unique) index to
-- keep the queue's lookups fast.
DROP INDEX IF EXISTS "ModerationCase_targetType_targetId_status_key";

CREATE INDEX IF NOT EXISTS "ModerationCase_targetType_targetId_status_idx" ON "ModerationCase"("targetType", "targetId", "status");
