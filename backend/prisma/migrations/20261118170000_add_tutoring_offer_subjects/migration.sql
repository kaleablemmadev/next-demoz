-- Add multi-subject support to agency tutoring offers.
-- Preserve the legacy single-subject column and backfill it for existing offers.
ALTER TABLE "TutoringOffer"
  ADD COLUMN IF NOT EXISTS "subjects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "TutoringOffer"
SET "subjects" = ARRAY["subject"]::TEXT[]
WHERE cardinality("subjects") = 0
  AND "subject" IS NOT NULL
  AND btrim("subject") <> '';

