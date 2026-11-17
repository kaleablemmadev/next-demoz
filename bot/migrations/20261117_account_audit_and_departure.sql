BEGIN;

-- NextTutor account audit trail and privacy-preserving account references.
-- Apply once to the same PostgreSQL database used by the Telegram bot.

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "auditRef" uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE "Parent"
  ADD COLUMN IF NOT EXISTS "auditRef" uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE "TelegramSubscriber"
  ADD COLUMN IF NOT EXISTS "auditRef" uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE IF NOT EXISTS "AuditEvent" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actorRef" uuid NOT NULL,
  "actorType" text NOT NULL CHECK ("actorType" IN ('PARENT', 'TUTOR', 'AGENCY', 'SYSTEM')),
  action text NOT NULL,
  "entityType" text,
  "entityRef" uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "AuditEvent_actor_created_idx"
  ON "AuditEvent" ("actorRef", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AuditEvent_action_created_idx"
  ON "AuditEvent" (action, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AuditEvent_created_idx"
  ON "AuditEvent" ("createdAt" DESC);

-- Audit records are append-only. Retention/deletion must be handled by an explicit
-- compliance policy, not by ordinary account-departure code.
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS "AuditEvent_immutable" ON "AuditEvent";
CREATE TRIGGER "AuditEvent_immutable"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

CREATE UNIQUE INDEX IF NOT EXISTS "Organization_auditRef_key" ON "Organization" ("auditRef");
CREATE UNIQUE INDEX IF NOT EXISTS "Parent_auditRef_key" ON "Parent" ("auditRef");
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramSubscriber_auditRef_key" ON "TelegramSubscriber" ("auditRef");

COMMIT;
