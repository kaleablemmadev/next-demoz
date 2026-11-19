-- Admin-sent offers (no group or channel post) and named admin templates.
-- Idempotent. Apply once, before deploying the bot code that uses these tables:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261119_admin_direct_offers.sql

BEGIN;

-- Contact username shown to tutors on an offer. Agency offers keep using the agency's own username.
ALTER TABLE "TutoringOffer" ADD COLUMN IF NOT EXISTS "contactUsername" text;

-- Named templates saved by the admin. Each holds the full offer as JSON.
CREATE TABLE IF NOT EXISTS "AdminOfferTemplate" (
    id          text        PRIMARY KEY DEFAULT (gen_random_uuid())::text,
    name        text        NOT NULL,
    fields      jsonb       NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminOfferTemplate_name_key" ON "AdminOfferTemplate" (lower(name));

-- Fixed organization for admin-sent offers. It has no Telegram user and no group or channel,
-- so nothing is posted for it, and no agency can log in as it.
INSERT INTO "Organization" (id, name, "telegramUsername", status, "postDestination", language)
VALUES ('nexttutor-direct', 'NextTutor', 'nexttutor_direct', 'ACTIVE', 'GROUP', 'EN')
ON CONFLICT (id) DO NOTHING;

COMMIT;
