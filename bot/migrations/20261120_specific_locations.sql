-- Specific locations inside a sefer, plus admin merges of typed wording and per-user saved names.
-- Idempotent. Apply once, before deploying the bot code that uses these tables:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261120_specific_locations.sql

BEGIN;

-- A specific location belongs to one sefer. Typed locations start PENDING until the admin reviews them.
CREATE TABLE IF NOT EXISTS "SpecificLocation" (
    id                      text        PRIMARY KEY DEFAULT (gen_random_uuid())::text,
    name                    text        NOT NULL,
    "seferId"               text        NOT NULL REFERENCES "Sefer" (id) ON DELETE CASCADE,
    status                  text        NOT NULL DEFAULT 'APPROVED'
                                        CHECK (status IN ('APPROVED', 'PENDING', 'REJECTED')),
    "proposedByTelegramId"  bigint,
    "createdAt"             timestamptz NOT NULL DEFAULT now(),
    "reviewedAt"            timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "SpecificLocation_sefer_name_key" ON "SpecificLocation" ("seferId", lower(name));

-- When the admin merges typed wording into an existing place, every future typing of that wording resolves to the target.
CREATE TABLE IF NOT EXISTS "PlaceAlias" (
    kind        text        NOT NULL CHECK (kind IN ('SEFER', 'LOCATION')),
    "typedName" text        NOT NULL,
    "targetId"  text        NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, "typedName")
);

-- Each person keeps the names they typed, so they can pick them again later.
CREATE TABLE IF NOT EXISTS "SavedPlace" (
    "telegramId" bigint      NOT NULL,
    kind         text        NOT NULL CHECK (kind IN ('SEFER', 'LOCATION')),
    name         text        NOT NULL,
    "targetId"   text,
    "createdAt"  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("telegramId", kind, name)
);

ALTER TABLE "TutoringOffer" ADD COLUMN IF NOT EXISTS "locationId" text REFERENCES "SpecificLocation" (id) ON DELETE SET NULL;

COMMIT;
