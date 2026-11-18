# Telegram bot operations

## Process roles

The bot supports three process modes through `BOT_PROCESS_ROLE`:

- `all` (default): webhook server and scheduled jobs in one process. Keeps the existing deployment working.
- `webhook`: serves Telegram webhook updates and health checks only.
- `worker`: runs scheduled jobs and health checks; it does not register or accept the Telegram webhook.

For a split Render deployment:

1. Keep the existing Web Service and set `BOT_PROCESS_ROLE=webhook`.
2. Add one Render Background Worker from the same repository and start command, with `BOT_PROCESS_ROLE=worker`.
3. Give both services the same `TELEGRAM_BOT_TOKEN` and `DATABASE_URL`. The webhook service also needs `PUBLIC_URL`, `WEBHOOK_PATH_SECRET`, and `WEBHOOK_TOKEN_SECRET`.
4. Keep exactly one worker instance for now. Some scheduled jobs use process-local guards and are not yet safe to run in multiple worker replicas.
5. Set `PG_POOL_MAX` with the total database connection budget in mind. Each process has its own pool; for example, a pool maximum of 5 on one webhook and one worker can use up to 10 connections.

The default pool maximum is 5 connections per process. Optional settings:

- `PG_POOL_MAX` (1–50, default 5)
- `PG_IDLE_TIMEOUT_MS` (default 30000)
- `PG_CONNECTION_TIMEOUT_MS` (default 5000)
- `PG_STATEMENT_TIMEOUT_MS` (default 15000)
- `PG_QUERY_TIMEOUT_MS` (default 20000)

Do not increase pool size without checking the Neon plan's connection limit and the number of deployed instances.

## Deploying safely

- Apply SQL migrations manually after taking a database backup. The bot does not run migrations automatically.
- Deploy the webhook service first with `BOT_PROCESS_ROLE=webhook`, then start the worker.
- Verify `/health` on both services. It reports the process role.
- Watch Render logs for PostgreSQL timeouts, Telegram 429 responses, and failed delivery receipts.
- Do not treat a successful build as proof of capacity. Load-test a staging bot and database before advertising a concurrency target.

## Delivery guarantees

Offer notifications are sent with bounded concurrency (five at a time). Telegram message delivery and PostgreSQL receipt insertion cannot be made atomic together; if Telegram accepts a message and the database write then fails, a later retry can send a duplicate. The bot logs this case explicitly. A durable outbox with delivery states and retries is the next step before operating at large scale.
