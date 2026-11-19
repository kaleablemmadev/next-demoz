// src/direct-offers.ts

// Offers the admin sends straight to matching tutors. They have no group or channel post.
// They belong to a fixed organization row that has no Telegram chats, so nothing is ever posted for it.

import { pool } from './db.js';

export const DIRECT_ORG_ID = 'nexttutor-direct';

// What an admin template stores. Mirrors the offer form.
export type TemplateFields = {
    grades: string[];
    subjects: string[];
    subCity: string;
    locationDetail: string | null;
    sessionsPerWeek: number;
    unit: 'MONTH' | 'HOUR';
    amount: number;
    sessionHours: number;
    gender: 'MALE' | 'FEMALE' | null;
    requirements: string | null;
    contact: string;
};

export type DirectOfferInput = TemplateFields & { title: string; monthlySalaryEtb: number; postTemplate: string | null };

export async function insertDirectOffer(o: DirectOfferInput): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `WITH created_offer AS (
            INSERT INTO "TutoringOffer"
             ("organizationId", "title", "gradeLevel", "gradeLevels", "subject", "subjects",
              "subCity", "locationDetail", "monthlySalaryEtb", "salaryUnit",
              "salaryAmountEtb", "sessionHours", "sessionsPerWeek",
              "preferredTutorGender", "requirements", "contactUsername", "postTemplate", "status")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'OPEN')
             RETURNING id, "organizationId"
         ), audited AS (
            INSERT INTO "AuditEvent"
                ("actorRef", "actorType", action, "entityType", "entityRef", metadata)
            SELECT o."auditRef", 'SYSTEM', 'OFFER_CREATED', 'TUTORING_OFFER', created_offer.id::uuid, '{}'::jsonb
            FROM created_offer
            JOIN "Organization" o ON o.id = created_offer."organizationId"
         )
         SELECT id FROM created_offer`,
        [
            DIRECT_ORG_ID,
            o.title,
            o.grades[0] ?? 'Not specified',
            o.grades,
            o.subjects[0] ?? null,
            o.subjects,
            o.subCity,
            o.locationDetail,
            o.monthlySalaryEtb,
            o.unit,
            o.amount,
            o.sessionHours,
            o.sessionsPerWeek,
            o.gender,
            o.requirements,
            o.contact,
            o.postTemplate,
        ]
    );
    return rows[0].id;
}

// A template is a named layout: the post text with placeholders. Throws with code 23505 if the name is used.
export async function saveTemplate(name: string, layout: string): Promise<void> {
    await pool.query(
        `INSERT INTO "AdminOfferTemplate" (name, fields) VALUES ($1::text, jsonb_build_object('layout', $2::text))`,
        [name, layout]
    );
}

export async function updateTemplateLayout(id: string, layout: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        `UPDATE "AdminOfferTemplate" SET fields = jsonb_build_object('layout', $2::text), "updatedAt" = now()
         WHERE id = $1`,
        [id, layout]
    );
    return (rowCount ?? 0) > 0;
}

export async function listTemplates(): Promise<{ id: string; name: string }[]> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM "AdminOfferTemplate" ORDER BY lower(name)`
    );
    return rows;
}

export async function getTemplate(id: string): Promise<{ name: string; layout: string } | null> {
    const { rows } = await pool.query<{ name: string; layout: string }>(
        `SELECT name, fields->>'layout' AS layout FROM "AdminOfferTemplate" WHERE id = $1`,
        [id]
    );
    return rows[0] ?? null;
}

export async function deleteTemplate(id: string): Promise<string | null> {
    const { rows } = await pool.query<{ name: string }>(
        `DELETE FROM "AdminOfferTemplate" WHERE id = $1 RETURNING name`,
        [id]
    );
    return rows[0]?.name ?? null;
}

export async function listOpenDirectOffers(): Promise<
    { id: string; title: string; subCity: string; salaryAmountEtb: number; salaryUnit: string }[]
> {
    const { rows } = await pool.query(
        `SELECT id, title, "subCity", "salaryAmountEtb", "salaryUnit"
         FROM "TutoringOffer"
         WHERE "organizationId" = $1 AND status = 'OPEN'
         ORDER BY "postedAt" DESC
         LIMIT 10`,
        [DIRECT_ORG_ID]
    );
    return rows;
}

export async function closeDirectOffer(id: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        `UPDATE "TutoringOffer" SET status = 'CLOSED', "closedAt" = now()
         WHERE id = $1 AND "organizationId" = $2 AND status = 'OPEN'`,
        [id, DIRECT_ORG_ID]
    );
    return (rowCount ?? 0) > 0;
}
