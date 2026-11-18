// src/db.ts

import 'dotenv/config';
import pg from 'pg';

function positiveInteger(name: string, fallback: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new Error(`${name} must be an integer between 1 and ${max}.`);
    }
    return value;
}

// Keep each process bounded. When running separate webhook and worker services,
// configure PG_POOL_MAX so the sum of all replicas stays below the database limit.
export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: positiveInteger('PG_POOL_MAX', 5, 50),
    idleTimeoutMillis: positiveInteger('PG_IDLE_TIMEOUT_MS', 30_000, 300_000),
    connectionTimeoutMillis: positiveInteger('PG_CONNECTION_TIMEOUT_MS', 5_000, 60_000),
    statement_timeout: positiveInteger('PG_STATEMENT_TIMEOUT_MS', 15_000, 120_000),
    query_timeout: positiveInteger('PG_QUERY_TIMEOUT_MS', 20_000, 120_000),
    keepAlive: true,
});

pool.on('error', (error) => {
    console.error('Unexpected idle PostgreSQL client error:', error);
});
