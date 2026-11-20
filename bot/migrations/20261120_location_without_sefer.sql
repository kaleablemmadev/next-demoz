-- Specific locations may be typed without a sefer; the admin files them under a sefer later.
-- Each location keeps its sub-city so it can be reviewed and matched. Idempotent.
-- Apply once, before deploying the bot code that uses these columns:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261120_location_without_sefer.sql

BEGIN;

ALTER TABLE "SpecificLocation" ALTER COLUMN "seferId" DROP NOT NULL;
ALTER TABLE "SpecificLocation" ADD COLUMN IF NOT EXISTS "subCity" text;

UPDATE "SpecificLocation" l SET "subCity" = s."subCity"
FROM "Sefer" s
WHERE s.id = l."seferId" AND l."subCity" IS NULL;

-- Same name is allowed under different sefers, and under no sefer in each sub-city.
DROP INDEX IF EXISTS "SpecificLocation_sefer_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "SpecificLocation_place_key"
    ON "SpecificLocation" (COALESCE("seferId", ''), COALESCE("subCity", ''), lower(name));

COMMIT;
