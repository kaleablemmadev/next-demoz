// src/routing.ts

import { Bot, InlineKeyboard } from 'grammy';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { ADMIN_USERNAME } from './admin.js';

const ACCEPT_HOURS = 24;   // agency must accept within this time
const PAY_DAYS = 3;        // after accepting, agency must pay within this time
const PREMIUM_LIMIT = 5;   // premium requests per billing cycle
const CHECK_EVERY_MS = 60_000;

type OpenRequest = {
    id: string;
    weakSubjects: string | null;
    gradeLevel: string;
    subCity: string;
    locationDetail: string | null;
    sessionsPerWeek: number;
    budgetEtb: number | null;
    preferredTutorGender: string | null;
    notes: string | null;
};

type Candidate = {
    id: string;
    name: string;
    telegramUserId: string;
    subscriptionId: string;
    plan: string;
    premiumUsed: number;
};

// The next agency to receive this request, or null if none is eligible.
async function nextAgency(requestId: string, client: PoolClient): Promise<Candidate | null> {
    const { rows } = await client.query<Candidate>(
        `SELECT o.id, o.name, o."telegramUserId"::text AS "telegramUserId",
                s.id AS "subscriptionId", s.plan, s."premiumUsed"
         FROM "Organization" o
         JOIN "Subscription" s ON s."organizationId" = o.id
              AND s.status = 'ACTIVE' AND s."endsAt" > now()
         WHERE o.status = 'ACTIVE'
           AND o."telegramUserId" IS NOT NULL
           -- this agency has never had this request (including declined or expired ones)
           AND NOT EXISTS (
               SELECT 1 FROM "Assignment" a
               WHERE a."requestId" = $1 AND a."organizationId" = o.id
           )
         ORDER BY
           CASE WHEN s.plan = 'PREMIUM' AND s."premiumUsed" < ${PREMIUM_LIMIT} THEN 0 ELSE 1 END,
           (SELECT max(a2."sentAt") FROM "Assignment" a2 WHERE a2."organizationId" = o.id) NULLS FIRST,
           random()
         LIMIT 1`,
        [requestId]
    );
    return rows[0] ?? null;
}

function genderLabel(g: string | null): string {
    return g === 'MALE' ? 'Male' : g === 'FEMALE' ? 'Female' : 'Any';
}

function requestText(r: OpenRequest): string {
    return [
        'New tutoring request',
        '',
        `Weak subjects: ${r.weakSubjects ?? 'Not specified'}`,
        `Grade: ${r.gradeLevel}`,
        `Area: ${r.subCity}`,
        r.locationDetail ? `Location: ${r.locationDetail}` : null,
        `Sessions: ${r.sessionsPerWeek} per week`,
        r.budgetEtb ? `Budget: ${r.budgetEtb.toLocaleString()} ETB per month` : null,
        `Tutor gender: ${genderLabel(r.preferredTutorGender)}`,
        r.notes ? `Notes: ${r.notes}` : null,
        '',
        `Accept within ${ACCEPT_HOURS} hours. After accepting, you have ${PAY_DAYS} days to pay.`,
        `To pay and receive the parent's contact, contact @${ADMIN_USERNAME}.`,
    ].filter((line): line is string => line !== null).join('\n');
}

// Deletes an agency's message. Best effort: if it fails, the request still moves on.
async function clearMessage(bot: Bot, chatId: string | null, messageId: number | null) {
    if (chatId === null || messageId === null) return;
    try {
        await bot.api.deleteMessage(Number(chatId), messageId);
    } catch (err) {
        console.error(`Could not delete message ${messageId} in chat ${chatId}:`, err);
    }
}

// Sends one request to the next eligible agency. Returns false if no agency is eligible.
export async function routeRequest(bot: Bot, requestId: string): Promise<boolean> {
    const client = await pool.connect();
    let assignmentId: string | null = null;
    let agency: Candidate | null = null;
    let request: OpenRequest | null = null;
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [requestId]);
        const requestResult = await client.query<OpenRequest>(
            `SELECT id, "weakSubjects", "gradeLevel", "subCity", "locationDetail", "sessionsPerWeek", "budgetEtb", "preferredTutorGender", notes FROM "ParentRequest" WHERE id = $1 AND status IN ('OPEN', 'ASSIGNED')`,
            [requestId]
        );
        request = requestResult.rows[0] ?? null;
        if (!request) { await client.query('COMMIT'); return false; }
        const active = await client.query(`SELECT 1 FROM "Assignment" WHERE "requestId" = $1 AND status IN ('SENT', 'ACCEPTED', 'PAID', 'PLACED') LIMIT 1`, [requestId]);
        if (active.rows.length) { await client.query('COMMIT'); return false; }
        agency = await nextAgency(requestId, client);
        if (!agency) { await client.query('COMMIT'); return false; }
        const inserted = await client.query<{ id: string }>(`INSERT INTO "Assignment" ("requestId", "organizationId") VALUES ($1, $2) RETURNING id`, [requestId, agency.id]);
        assignmentId = inserted.rows[0].id;
        if (agency.plan === 'PREMIUM' && agency.premiumUsed < PREMIUM_LIMIT) {
            await client.query(`UPDATE "Subscription" SET "premiumUsed" = "premiumUsed" + 1 WHERE id = $1`, [agency.subscriptionId]);
        }
        await client.query(`UPDATE "ParentRequest" SET status = 'ASSIGNED' WHERE id = $1 AND status = 'OPEN'`, [requestId]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally { client.release(); }
    if (!assignmentId || !agency || !request) return false;
    const keyboard = new InlineKeyboard().text('Accept request', `rt:acc:${assignmentId}`).text('Decline', `rt:dec:${assignmentId}`);
    try {
        const sent = await bot.api.sendMessage(Number(agency.telegramUserId), requestText(request), { reply_markup: keyboard });
        await pool.query(`UPDATE "Assignment" SET "agencyChatId" = $1, "agencyMessageId" = $2 WHERE id = $3 AND status = 'SENT'`, [agency.telegramUserId, sent.message_id, assignmentId]);
    } catch (err) { console.error(`Could not send request ${requestId} to ${agency.name}:`, err); }
    return true;
}

// The agency pressed "Accept request" or "Decline".
export function registerRoutingHandlers(bot: Bot) {
    bot.callbackQuery(/^rt:acc:(.+)$/, async (ctx) => {
        const assignmentId = (ctx.match as RegExpMatchArray)[1];

        // Only the agency this assignment was sent to can accept, and only within the accept window.
        const { rows } = await pool.query(
            `UPDATE "Assignment" a SET status = 'ACCEPTED', "acceptedAt" = now()
             FROM "Organization" o
             WHERE a.id = $1
               AND a.status = 'SENT'
               AND a."sentAt" > now() - make_interval(hours => $3::int)
               AND o.id = a."organizationId"
               AND o."telegramUserId"::text = $2
             RETURNING a.id`,
            [assignmentId, String(ctx.from.id), ACCEPT_HOURS]
        );

        if (rows.length === 0) {
            await ctx.answerCallbackQuery({ text: 'This request is no longer open.', show_alert: true });
            return;
        }

        await ctx.answerCallbackQuery({ text: `Accepted. Pay within ${PAY_DAYS} days.` });
        const original = ctx.callbackQuery.message?.text ?? '';
        try {
            await ctx.editMessageText(
                `${original}\n\nAccepted. Pay within ${PAY_DAYS} days to receive the parent's contact. ` +
                `Contact @${ADMIN_USERNAME} to pay.`
            );
        } catch (err) {
            console.error('Could not update accepted message:', err);
        }
    });

    bot.callbackQuery(/^rt:dec:(.+)$/, async (ctx) => {
        const assignmentId = (ctx.match as RegExpMatchArray)[1];

        const { rows } = await pool.query<{
            requestId: string;
            agencyChatId: string | null;
            agencyMessageId: number | null;
        }>(
            `UPDATE "Assignment" a SET status = 'DECLINED'
             FROM "Organization" o
             WHERE a.id = $1
               AND a.status = 'SENT'
               AND o.id = a."organizationId"
               AND o."telegramUserId"::text = $2
             RETURNING a."requestId",
                       a."agencyChatId"::text AS "agencyChatId",
                       a."agencyMessageId"`,
            [assignmentId, String(ctx.from.id)]
        );

        if (rows.length === 0) {
            await ctx.answerCallbackQuery({ text: 'This request is no longer open.', show_alert: true });
            return;
        }

        const d = rows[0];
        await ctx.answerCallbackQuery({ text: 'Declined.' });
        await clearMessage(bot, d.agencyChatId, d.agencyMessageId);
        // Move straight to the next agency.
        await routeRequest(bot, d.requestId);
    });
}

// Marks late assignments as expired, removes the agency's message, and tells the agency.
// Marks late assignments as expired, removes the agency's message, and tells the agency why.
async function expireAssignments(bot: Bot) {
    const { rows } = await pool.query<{
        wasAccepted: boolean;
        agencyUserId: string | null;
        agencyChatId: string | null;
        agencyMessageId: number | null;
    }>(
        `WITH expired AS (
             SELECT a.id, a.status AS "oldStatus", a."organizationId",
                    a."agencyChatId", a."agencyMessageId"
             FROM "Assignment" a
             WHERE (a.status = 'SENT' AND a."sentAt" < now() - make_interval(hours => $1::int))
                OR (a.status = 'ACCEPTED' AND a."acceptedAt" < now() - make_interval(days => $2::int))
         ), updated AS (
             UPDATE "Assignment" a SET status = 'EXPIRED'
             FROM expired e WHERE a.id = e.id AND a.status = e."oldStatus" AND a.status = e."oldStatus"
             RETURNING a.id
         )
         SELECT (e."oldStatus" = 'ACCEPTED') AS "wasAccepted",
                (SELECT o."telegramUserId"::text FROM "Organization" o WHERE o.id = e."organizationId") AS "agencyUserId",
                e."agencyChatId"::text AS "agencyChatId",
                e."agencyMessageId"
         FROM expired e
         JOIN updated u ON u.id = e.id`,
        [ACCEPT_HOURS, PAY_DAYS]
    );

    for (const a of rows) {
        await clearMessage(bot, a.agencyChatId, a.agencyMessageId);
        if (!a.agencyUserId) continue;
        try {
            await bot.api.sendMessage(Number(a.agencyUserId), a.wasAccepted
                ? `Notice: payment was not received within ${PAY_DAYS} days, so this request was removed from your chat and moved to another agency.`
                : `Notice: this request was not accepted within ${ACCEPT_HOURS} hours, so it was removed from your chat and moved to another agency.`);
        } catch (err) {
            console.error('Could not send expiry notice:', err);
        }
    }
}

// Every minute: expire late assignments, then route requests that need an agency.
export function startParentRouter(bot: Bot) {
    let running = false;

    setInterval(async () => {
        if (running) return;
        running = true;
        try {
            await expireAssignments(bot);

            const { rows } = await pool.query<{ id: string }>(
                `SELECT r.id FROM "ParentRequest" r
                 WHERE r.status IN ('OPEN', 'ASSIGNED')
                   AND NOT EXISTS (
                       SELECT 1 FROM "Assignment" a
                       WHERE a."requestId" = r.id AND a.status IN ('ACCEPTED', 'PAID', 'PLACED')
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM "Assignment" a
                       WHERE a."requestId" = r.id AND a.status = 'SENT'
                   )
                 ORDER BY r."createdAt" ASC
                 LIMIT 20`
            );
            for (const r of rows) {
                await routeRequest(bot, r.id);
            }
        } catch (err) {
            console.error('Parent routing check failed:', err);
        } finally {
            running = false;
        }
    }, CHECK_EVERY_MS);
}