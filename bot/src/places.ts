// src/places.ts
// Sefers and specific locations as people type them. Known places are matched, typed wording the admin
// merged into a place is matched to that place, and anything new is kept as PENDING for admin review.

import { pool } from './db.js';

export type PlaceKind = 'SEFER' | 'LOCATION';

export function cleanName(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Resolves typed wording to a place id. Creates a PENDING place when nothing matches, and remembers the wording for this person.
export async function resolvePlace(opts: {
    kind: PlaceKind;
    typed: string;
    telegramId: number;
    subCity?: string;   // sefers
    seferId?: string;   // specific locations
}): Promise<{ id: string; name: string; status: string; created: boolean }> {
    const name = cleanName(opts.typed);
    const key = name.toLowerCase();

    // 1. The admin already merged this wording into a place.
    const { rows: aliased } = await pool.query<{ id: string; name: string; status: string }>(
        opts.kind === 'SEFER'
            ? `SELECT s.id, s.name, s.status FROM "PlaceAlias" a JOIN "Sefer" s ON s.id = a."targetId"
               WHERE a.kind = 'SEFER' AND a."typedName" = $1`
            : `SELECT l.id, l.name, l.status FROM "PlaceAlias" a JOIN "SpecificLocation" l ON l.id = a."targetId"
               WHERE a.kind = 'LOCATION' AND a."typedName" = $1`,
        [key]
    );
    if (aliased[0]) return remember(opts, { ...aliased[0], created: false });

    // 2. Same name already exists.
    const { rows: existing } = await pool.query<{ id: string; name: string; status: string }>(
        opts.kind === 'SEFER'
            ? `SELECT id, name, status FROM "Sefer" WHERE lower(name) = $1`
            : `SELECT id, name, status FROM "SpecificLocation" WHERE "seferId" = $2 AND lower(name) = $1`,
        opts.kind === 'SEFER' ? [key] : [key, opts.seferId]
    );
    if (existing[0]) return remember(opts, { ...existing[0], created: false });

    // 3. New wording: keep it as PENDING for the admin.
    const { rows: created } = await pool.query<{ id: string }>(
        opts.kind === 'SEFER'
            ? `INSERT INTO "Sefer" (name, "subCity", status, "proposedByTelegramId")
               VALUES ($1, $2, 'PENDING', $3) RETURNING id`
            : `INSERT INTO "SpecificLocation" (name, "seferId", status, "proposedByTelegramId")
               VALUES ($1, $2, 'PENDING', $3) RETURNING id`,
        opts.kind === 'SEFER'
            ? [name, opts.subCity, opts.telegramId]
            : [name, opts.seferId, opts.telegramId]
    );
    return remember(opts, { id: created[0].id, name, status: 'PENDING', created: true });
}

// Keeps the wording for this person, so they can pick it again later.
async function remember(
    opts: { kind: PlaceKind; telegramId: number },
    place: { id: string; name: string; status: string; created: boolean }
) {
    await pool.query(
        `INSERT INTO "SavedPlace" ("telegramId", kind, name, "targetId")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("telegramId", kind, name) DO UPDATE SET "targetId" = EXCLUDED."targetId"`,
        [opts.telegramId, opts.kind, cleanName(place.name), place.id]
    );
    return place;
}

// Approved specific locations inside a sefer, for buttons.
export async function approvedLocations(seferId: string): Promise<{ id: string; name: string }[]> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM "SpecificLocation" WHERE "seferId" = $1 AND status = 'APPROVED' ORDER BY name`,
        [seferId]
    );
    return rows;
}

// Admin: approve a pending place as it is.
export async function approvePlace(kind: PlaceKind, id: string): Promise<boolean> {
    const table = kind === 'SEFER' ? '"Sefer"' : '"SpecificLocation"';
    const { rowCount } = await pool.query(
        `UPDATE ${table} SET status = 'APPROVED', "reviewedAt" = now() WHERE id = $1 AND status = 'PENDING'`,
        [id]
    );
    return (rowCount ?? 0) > 0;
}

// Admin: make a pending place the same as an existing one. Offers move to the target, and its wording becomes an alias.
export async function mergePlace(kind: PlaceKind, pendingId: string, targetId: string): Promise<string | null> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const table = kind === 'SEFER' ? '"Sefer"' : '"SpecificLocation"';
        const { rows: pending } = await client.query<{ name: string }>(
            `SELECT name FROM ${table} WHERE id = $1 AND status = 'PENDING'`,
            [pendingId]
        );
        if (!pending[0]) { await client.query('ROLLBACK'); return null; }
        const { rows: target } = await client.query<{ name: string }>(
            `SELECT name FROM ${table} WHERE id = $1 AND status = 'APPROVED'`,
            [targetId]
        );
        if (!target[0]) { await client.query('ROLLBACK'); return null; }

        if (kind === 'SEFER') {
            await client.query(`UPDATE "TutoringOffer" SET "seferId" = $2 WHERE "seferId" = $1`, [pendingId, targetId]);
            await client.query(`UPDATE "TelegramSubscriber" SET "seferId" = $2 WHERE "seferId" = $1`, [pendingId, targetId]);
        } else {
            await client.query(`UPDATE "TutoringOffer" SET "locationId" = $2 WHERE "locationId" = $1`, [pendingId, targetId]);
        }
        await client.query(
            `INSERT INTO "PlaceAlias" (kind, "typedName", "targetId")
             VALUES ($1, $2, $3)
             ON CONFLICT (kind, "typedName") DO UPDATE SET "targetId" = EXCLUDED."targetId"`,
            [kind, pending[0].name.toLowerCase(), targetId]
        );
        await client.query(
            `UPDATE "SavedPlace" SET "targetId" = $2 WHERE kind = $1 AND "targetId" = $3`,
            [kind, targetId, pendingId]
        );
        await client.query(
            `UPDATE ${table} SET status = 'REJECTED', "reviewedAt" = now() WHERE id = $1`,
            [pendingId]
        );
        await client.query('COMMIT');
        return target[0].name;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Admin: pending places waiting for review.
export async function pendingPlaces(): Promise<{ id: string; kind: PlaceKind; name: string; context: string }[]> {
    const { rows } = await pool.query<{ id: string; kind: PlaceKind; name: string; context: string }>(
        `SELECT id, 'SEFER'::text AS kind, name, "subCity" AS context FROM "Sefer" WHERE status = 'PENDING'
         UNION ALL
         SELECT l.id, 'LOCATION'::text AS kind, l.name, s.name AS context
         FROM "SpecificLocation" l JOIN "Sefer" s ON s.id = l."seferId" WHERE l.status = 'PENDING'
         ORDER BY kind, name`
    );
    return rows;
}
