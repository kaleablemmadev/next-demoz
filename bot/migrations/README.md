# Telegram bot database migrations

Apply migrations to the same PostgreSQL database used by the Telegram bot.

Before applying a migration, take a database backup. Apply each migration once, in filename order, and stop if PostgreSQL reports an error.

For the account audit/departure migration:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bot/migrations/20261117_account_audit_and_departure.sql
```

Apply this migration **before deploying the bot code that reads or writes `auditRef` and `AuditEvent`**. The bot does not run schema migrations automatically at startup.

The migration adds opaque account references to the Telegram bot's parent, tutor-subscriber, and agency tables; creates an append-only audit table; and adds indexes. It does not alter the application website's separate `User` accounts.
