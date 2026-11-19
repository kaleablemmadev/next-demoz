-- Admin offers keep the layout they were sent with, so tutor alerts can use it. Idempotent.
-- Apply once, before deploying the bot code that reads this column:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261119_admin_layout.sql

BEGIN;

ALTER TABLE "TutoringOffer" ADD COLUMN IF NOT EXISTS "postTemplate" text;

COMMIT;
