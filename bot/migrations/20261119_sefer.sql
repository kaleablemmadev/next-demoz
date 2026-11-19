-- Sefers (city places inside a sub-city) for sorting offers and digests. Idempotent.
-- Apply once, before deploying the bot code that uses these tables:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261119_sefer.sql

BEGIN;

-- A sefer belongs to one sub-city. Agency proposals start as PENDING and count for sorting only once APPROVED.
CREATE TABLE IF NOT EXISTS "Sefer" (
    id                      text        PRIMARY KEY DEFAULT (gen_random_uuid())::text,
    name                    text        NOT NULL,
    "subCity"               text        NOT NULL,
    status                  text        NOT NULL DEFAULT 'APPROVED'
                                        CHECK (status IN ('APPROVED', 'PENDING', 'REJECTED')),
    "proposedByTelegramId"  bigint,
    "createdAt"             timestamptz NOT NULL DEFAULT now(),
    "reviewedAt"            timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "Sefer_name_key" ON "Sefer" (lower(name));

-- Nearby sefers are stored in both directions, so each pair has two rows.
CREATE TABLE IF NOT EXISTS "SeferNeighbour" (
    "seferId"     text NOT NULL REFERENCES "Sefer"(id) ON DELETE CASCADE,
    "neighbourId" text NOT NULL REFERENCES "Sefer"(id) ON DELETE CASCADE,
    PRIMARY KEY ("seferId", "neighbourId"),
    CHECK ("seferId" <> "neighbourId")
);

-- An offer's sefer (chosen by the agency) and a tutor's sefer (chosen by the tutor).
ALTER TABLE "TutoringOffer" ADD COLUMN IF NOT EXISTS "seferId" text REFERENCES "Sefer"(id) ON DELETE SET NULL;
ALTER TABLE "TelegramSubscriber" ADD COLUMN IF NOT EXISTS "seferId" text REFERENCES "Sefer"(id) ON DELETE SET NULL;

COMMIT;
