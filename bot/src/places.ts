// src/places.ts
// Sefers and specific locations as people type them. Known places are matched, typed wording the admin
// merged into a place is matched to that place, and anything new is kept as PENDING for admin review.
// A specific location can be typed without a sefer; the admin files it under one later.

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
    subCity: string;
    seferId?: string | null; // locations only; null means no sefer yet
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

    // 2. Same name already exists in the same place.
    const { rows: existing } = await pool.query<{ id: string; name: string; status: string }>(
        opts.kind === 'SEFER'
            ? `SELECT id, name, status FROM "Sefer" WHERE lower(name) = $1`
            : `SELECT id, name, status FROM "SpecificLocation"
               WHERE lower(name) = $1 AND COALESCE("seferId", '') = $2 AND COALESCE("subCity", '') = $3`,
        opts.kind === 'SEFER' ? [key] : [key, opts.seferId ?? '', opts.subCity]
    );
    if (existing[0]) return remember(opts, { ...existing[0], created: false });

    // 3. New wording: keep it as PENDING for the admin.
    const { rows: created } = await pool.query<{ id: string }>(
        opts.kind === 'SEFER'
            ? `INSERT INTO "Sefer" (name, "subCity", status, "proposedByTelegramId")
               VALUES ($1, $2, 'PENDING', $3) RETURNING id`
            : `INSERT INTO "SpecificLocation" (name, "seferId", "subCity", status, "proposedByTelegramId")
               VALUES ($1, $2, $3, 'PENDING', $4) RETURNING id`,
        opts.kind === 'SEFER'
            ? [name, opts.subCity, opts.telegramId]
            : [name, opts.seferId ?? null, opts.subCity, opts.telegramId]
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

// Approved specific locations for buttons: the sefer's own, or with no sefer yet, those in the sub-city.
export async function approvedLocations(seferId: string | null, subCity: string): Promise<{ id: string; name: string }[]> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        seferId
            ? `SELECT id, name FROM "SpecificLocation" WHERE "seferId" = $1 AND status = 'APPROVED' ORDER BY name`
            : `SELECT id, name FROM "SpecificLocation"
               WHERE "seferId" IS NULL AND "subCity" = $1 AND status = 'APPROVED' ORDER BY name`,
        [seferId ?? subCity]
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

// Admin: reject a pending place. Offers keep the wording they were posted with.
export async function rejectPlace(kind: PlaceKind, id: string): Promise<boolean> {
    const table = kind === 'SEFER' ? '"Sefer"' : '"SpecificLocation"';
    const { rowCount } = await pool.query(
        `UPDATE ${table} SET status = 'REJECTED', "reviewedAt" = now() WHERE id = $1 AND status = 'PENDING'`,
        [id]
    );
    return (rowCount ?? 0) > 0;
}

// Admin: file a pending location under an approved sefer in the same sub-city.
// Returns the sefer name, or null when the step does not apply (already reviewed, or no matching sefer).
export async function assignSefer(locationId: string, seferId: string): Promise<{ seferName: string } | 'DUPLICATE' | null> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: sefer } = await client.query<{ name: string; subCity: string }>(
            `SELECT name, "subCity" FROM "Sefer" WHERE id = $1 AND status = 'APPROVED'`,
            [seferId]
        );
        if (!sefer[0]) { await client.query('ROLLBACK'); return null; }
        const { rowCount } = await client.query(
            `UPDATE "SpecificLocation" SET "seferId" = $2, "subCity" = $3, status = 'APPROVED', "reviewedAt" = now()
             WHERE id = $1 AND status = 'PENDING' AND "seferId" IS NULL AND "subCity" = $3`,
            [locationId, seferId, sefer[0].subCity]
        );
        if (!rowCount) { await client.query('ROLLBACK'); return null; }
        // Offers that already use this location now belong to its sefer too, so sefer rules apply to them.
        await client.query(
            `UPDATE "TutoringOffer" SET "seferId" = $2 WHERE "locationId" = $1 AND "seferId" IS NULL`,
            [locationId, seferId]
        );
        await client.query('COMMIT');
        return { seferName: sefer[0].name };
    } catch (err) {
        await client.query('ROLLBACK');
        // 23505: the same location name already exists under that sefer.
        if ((err as { code?: string }).code === '23505') return 'DUPLICATE';
        throw err;
    } finally {
        client.release();
    }
}

// Admin: make a pending place the same as an existing approved one in the same scope.
// Offers and saved names move to the target, and the typed wording becomes an alias for everyone.
// Returns the target name, or null when the merge does not apply.
export async function mergePlace(kind: PlaceKind, pendingId: string, targetId: string): Promise<string | null | 'DUPLICATE'> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (kind === 'SEFER') {
            const { rows } = await client.query<{ p: string; t: string }>(
                `SELECT p.name AS p, t.name AS t FROM "Sefer" p, "Sefer" t
                 WHERE p.id = $1 AND p.status = 'PENDING' AND t.id = $2 AND t.status = 'APPROVED'
                   AND p."subCity" = t."subCity" AND p.id <> t.id`,
                [pendingId, targetId]
            );
            if (!rows[0]) { await client.query('ROLLBACK'); return null; }
            await client.query(`UPDATE "TutoringOffer" SET "seferId" = $2 WHERE "seferId" = $1`, [pendingId, targetId]);
            await client.query(`UPDATE "TelegramSubscriber" SET "seferId" = $2 WHERE "seferId" = $1`, [pendingId, targetId]);
            await client.query(`UPDATE "SpecificLocation" SET "seferId" = $2 WHERE "seferId" = $1`, [pendingId, targetId]);
            await client.query(
                `INSERT INTO "PlaceAlias" (kind, "typedName", "targetId") VALUES ('SEFER', $1, $2)
                 ON CONFLICT (kind, "typedName") DO UPDATE SET "targetId" = EXCLUDED."targetId"`,
                [rows[0].p.toLowerCase(), targetId]
            );
            await client.query(`UPDATE "SavedPlace" SET "targetId" = $2 WHERE kind = 'SEFER' AND "targetId" = $1`, [pendingId, targetId]);
            await client.query(`UPDATE "Sefer" SET status = 'REJECTED', "reviewedAt" = now() WHERE id = $1`, [pendingId]);
            await client.query('COMMIT');
            return rows[0].t;
        }

        const { rows } = await client.query<{ p: string; t: string }>(
            `SELECT p.name AS p, t.name AS t FROM "SpecificLocation" p, "SpecificLocation" t
             WHERE p.id = $1 AND p.status = 'PENDING' AND t.id = $2 AND t.status = 'APPROVED'
               AND t.id <> p.id
               AND t."seferId" IS NOT DISTINCT FROM p."seferId"
               AND t."subCity" = p."subCity"`,
            [pendingId, targetId]
        );
        if (!rows[0]) { await client.query('ROLLBACK'); return null; }
        await client.query(`UPDATE "TutoringOffer" SET "locationId" = $2 WHERE "locationId" = $1`, [pendingId, targetId]);
        await client.query(
            `INSERT INTO "PlaceAlias" (kind, "typedName", "targetId") VALUES ('LOCATION', $1, $2)
             ON CONFLICT (kind, "typedName") DO UPDATE SET "targetId" = EXCLUDED."targetId"`,
            [rows[0].p.toLowerCase(), targetId]
        );
        await client.query(`UPDATE "SavedPlace" SET "targetId" = $2 WHERE kind = 'LOCATION' AND "targetId" = $1`, [pendingId, targetId]);
        await client.query(`UPDATE "SpecificLocation" SET status = 'REJECTED', "reviewedAt" = now() WHERE id = $1`, [pendingId]);
        await client.query('COMMIT');
        return rows[0].t;
    } catch (err) {
        await client.query('ROLLBACK');
        if ((err as { code?: string }).code === '23505') return 'DUPLICATE';
        throw err;
    } finally {
        client.release();
    }
}

export type PendingPlace = {
    id: string;
    kind: PlaceKind;
    name: string;
    subCity: string;
    seferId: string | null;
    seferName: string | null;
    proposedByTelegramId: string | null;
};

// Admin: pending places waiting for review, oldest first.
export async function pendingPlaces(): Promise<PendingPlace[]> {
    const { rows } = await pool.query<PendingPlace>(
        `SELECT id, 'SEFER'::text AS kind, name, "subCity", NULL::text AS "seferId", NULL::text AS "seferName",
                "proposedByTelegramId"::text AS "proposedByTelegramId"
         FROM "Sefer" WHERE status = 'PENDING'
         UNION ALL
         SELECT l.id, 'LOCATION'::text AS kind, l.name, l."subCity", l."seferId", s.name AS "seferName",
                l."proposedByTelegramId"::text AS "proposedByTelegramId"
         FROM "SpecificLocation" l LEFT JOIN "Sefer" s ON s.id = l."seferId"
         WHERE l.status = 'PENDING'
         ORDER BY kind, name`
    );
    return rows;
}

// Admin: one pending place, for the review buttons.
export async function getPendingPlace(kind: PlaceKind, id: string): Promise<PendingPlace | null> {
    const all = await pendingPlaces();
    return all.find((p) => p.kind === kind && p.id === id) ?? null;
}

// Admin: approved sefers in a sub-city, for filing a location.
export async function approvedSefersIn(subCity: string): Promise<{ id: string; name: string }[]> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM "Sefer" WHERE "subCity" = $1 AND status = 'APPROVED' ORDER BY name LIMIT 40`,
        [subCity]
    );
    return rows;
}

// Admin: approved places a pending place could be merged into (same sefer and sub-city scope).
export async function mergeTargets(p: PendingPlace): Promise<{ id: string; name: string }[]> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        p.kind === 'SEFER'
            ? `SELECT id, name FROM "Sefer" WHERE "subCity" = $1 AND status = 'APPROVED' AND id <> $2 ORDER BY name LIMIT 40`
            : `SELECT id, name FROM "SpecificLocation"
               WHERE status = 'APPROVED' AND "subCity" = $1 AND "seferId" IS NOT DISTINCT FROM $2::text AND id <> $3
               ORDER BY name LIMIT 40`,
        p.kind === 'SEFER' ? [p.subCity, p.id] : [p.subCity, p.seferId, p.id]
    );
    return rows;
}
