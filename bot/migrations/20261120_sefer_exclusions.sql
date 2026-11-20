-- Turned-down sefers per tutor. "Too far" hides that sefer's offers for the tutor.
-- "Not enough salary" hides that sefer's offers paying at or below the amount the tutor rejected.
-- Tutors remove an exclusion with /turneddown. Idempotent. Apply once, before deploying the bot code that uses this table:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261120_sefer_exclusions.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "SeferExclusion" (
    "subscriberId"   text          NOT NULL REFERENCES "TelegramSubscriber" (id) ON DELETE CASCADE,
    "seferId"        text          NOT NULL REFERENCES "Sefer" (id) ON DELETE CASCADE,
    kind             text          NOT NULL CHECK (kind IN ('TOO_FAR', 'LOW_SALARY')),
    "salaryBelowEtb" numeric(12,2),
    "createdAt"      timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY ("subscriberId", "seferId", kind)
);

COMMIT;
