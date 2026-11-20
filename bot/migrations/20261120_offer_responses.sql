-- Tutors tap "Too far" or "Not enough salary" on an offer alert. Used for later analysis.
-- Idempotent. Apply once, before deploying the bot code that uses this table:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261120_offer_responses.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "OfferResponse" (
    "subscriberId" text        NOT NULL REFERENCES "TelegramSubscriber" (id) ON DELETE CASCADE,
    "offerId"      text        NOT NULL REFERENCES "TutoringOffer" (id) ON DELETE CASCADE,
    kind           text        NOT NULL CHECK (kind IN ('TOO_FAR', 'LOW_SALARY')),
    "createdAt"    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("subscriberId", "offerId", kind)
);
CREATE INDEX IF NOT EXISTS "OfferResponse_offerId_idx" ON "OfferResponse" ("offerId");

COMMIT;
