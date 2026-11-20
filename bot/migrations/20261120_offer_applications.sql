-- Tutors tap "I applied" on an offer alert; agencies and the admin see the counts.
-- Idempotent. Apply once, before deploying the bot code that uses this table:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261120_offer_applications.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "OfferApplication" (
    "subscriberId" text        NOT NULL REFERENCES "TelegramSubscriber" (id) ON DELETE CASCADE,
    "offerId"      text        NOT NULL REFERENCES "TutoringOffer" (id) ON DELETE CASCADE,
    "appliedAt"    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("subscriberId", "offerId")
);
CREATE INDEX IF NOT EXISTS "OfferApplication_offerId_idx" ON "OfferApplication" ("offerId");

COMMIT;
