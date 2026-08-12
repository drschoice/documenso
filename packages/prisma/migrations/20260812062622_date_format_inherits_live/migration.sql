-- `DocumentMeta.dateFormat` changes meaning: NULL now means "inherit the current organisation/team
-- date format", resolved on read instead of being frozen at document creation. Dropping the column
-- default is what lets NULL survive a bare insert.
ALTER TABLE "DocumentMeta" ALTER COLUMN "dateFormat" DROP DEFAULT;

-- Existing templates, drafts and in-flight documents were snapshotted with whatever the org default
-- happened to be when they were created, which is exactly the staleness this change fixes — null
-- them so they start following the organisation setting.
--
-- Completed/rejected envelopes are deliberately left alone: their date fields are already stamped
-- with the old pattern and must keep re-displaying under it.
UPDATE "DocumentMeta" dm
SET "dateFormat" = NULL
FROM "Envelope" e
WHERE e."documentMetaId" = dm."id"
  AND e."status" NOT IN ('COMPLETED', 'REJECTED');

-- Orphaned meta rows (no envelope) are unreachable; null them too so nothing is left half-migrated.
UPDATE "DocumentMeta" dm
SET "dateFormat" = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "Envelope" e WHERE e."documentMetaId" = dm."id"
);
