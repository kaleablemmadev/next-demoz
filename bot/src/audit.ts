import type { PoolClient } from 'pg';

export type AuditActorType = 'PARENT' | 'TUTOR' | 'AGENCY' | 'SYSTEM';

export async function recordAuditEvent(
    client: PoolClient,
    event: {
        actorRef: string;
        actorType: AuditActorType;
        action: string;
        entityType?: string;
        entityRef?: string | null;
        metadata?: Record<string, string | number | boolean | null>;
    },
): Promise<void> {
    await client.query(
        `INSERT INTO "AuditEvent"
            ("actorRef", "actorType", action, "entityType", "entityRef", metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
            event.actorRef,
            event.actorType,
            event.action,
            event.entityType ?? null,
            event.entityRef ?? null,
            JSON.stringify(event.metadata ?? {}),
        ],
    );
}

export async function withTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
): Promise<T> {
    // Import the shared pool lazily at module scope to keep all bot transactions
    // on the same configured PostgreSQL pool.
    const { pool } = await import('./db.js');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}
