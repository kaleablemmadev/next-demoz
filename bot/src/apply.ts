// src/apply.ts
// Buttons under offer alerts: "I applied", plus reasons a tutor did not apply ("Too far", "Not enough salary").
// Counts are shown to the agency and admin.

import { Bot, InlineKeyboard } from 'grammy';
import { pool } from './db.js';

export const APPLY_PREFIX = 'apply:';
const RESPONSE_PREFIX = 'resp:';

type ResponseKind = 'TOO_FAR' | 'LOW_SALARY';
const RESPONSE_CODES: Record<string, ResponseKind> = { far: 'TOO_FAR', pay: 'LOW_SALARY' };

// The buttons tutors see under each offer alert.
export function applyKeyboard(offerId: string): InlineKeyboard {
    return new InlineKeyboard()
        .text('I applied', `${APPLY_PREFIX}${offerId}`)
        .row()
        .text('Too far', `${RESPONSE_PREFIX}far:${offerId}`)
        .text('Not enough salary', `${RESPONSE_PREFIX}pay:${offerId}`);
}

// Number of tutors who have tapped "I applied" for an offer.
export async function applicationCount(offerId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "OfferApplication" WHERE "offerId" = $1`,
        [offerId]
    );
    return Number(rows[0].n);
}

// Counts for one offer: applied, too far, not enough salary.
export async function offerResponseCounts(offerId: string): Promise<{ applied: number; tooFar: number; lowSalary: number }> {
    const { rows } = await pool.query<{ applied: number; too_far: number; low_salary: number }>(
        `SELECT
            (SELECT count(*)::int FROM "OfferApplication" WHERE "offerId" = $1) AS applied,
            (SELECT count(*)::int FROM "OfferResponse" WHERE "offerId" = $1 AND kind = 'TOO_FAR') AS too_far,
            (SELECT count(*)::int FROM "OfferResponse" WHERE "offerId" = $1 AND kind = 'LOW_SALARY') AS low_salary`,
        [offerId]
    );
    return { applied: rows[0].applied, tooFar: rows[0].too_far, lowSalary: rows[0].low_salary };
}

// One line for agency and admin messages.
export function countsLine(c: { applied: number; tooFar: number; lowSalary: number }): string {
    return `Applied: ${c.applied} · Too far: ${c.tooFar} · Not enough salary: ${c.lowSalary}`;
}

export function registerApplyHandlers(bot: Bot) {
    bot.callbackQuery(new RegExp(`^${APPLY_PREFIX}(.+)$`), async (ctx) => {
        const offerId = (ctx.match as RegExpMatchArray)[1];

        // Insert only for a subscriber of this tutor's Telegram account and only while the offer is open.
        const { rows } = await pool.query(
            `INSERT INTO "OfferApplication" ("subscriberId", "offerId")
             SELECT s.id, t.id
             FROM "TelegramSubscriber" s
             JOIN "TutoringOffer" t ON t.id = $2 AND t.status = 'OPEN'
             WHERE s."telegramId" = $1
             ON CONFLICT DO NOTHING
             RETURNING 1`,
            [ctx.from.id, offerId]
        );

        let recorded = rows.length > 0;
        if (recorded) {
            await ctx.answerCallbackQuery({ text: 'Thanks. Your application is recorded.' });
        } else {
            const { rows: prior } = await pool.query(
                `SELECT 1 FROM "OfferApplication" a
                 JOIN "TelegramSubscriber" s ON s.id = a."subscriberId"
                 WHERE s."telegramId" = $1 AND a."offerId" = $2`,
                [ctx.from.id, offerId]
            );
            recorded = prior.length > 0;
            await ctx.answerCallbackQuery({
                text: recorded
                    ? 'You already marked this offer as applied.'
                    : 'This offer is closed or not available to you.',
                show_alert: !recorded,
            });
        }

        // Show the button as done only when the application is on record.
        if (recorded) {
            try {
                await ctx.editMessageReplyMarkup({
                    reply_markup: new InlineKeyboard()
                        .text('✅ Applied', `${APPLY_PREFIX}${offerId}`)
                        .row()
                        .text('Too far', `${RESPONSE_PREFIX}far:${offerId}`)
                        .text('Not enough salary', `${RESPONSE_PREFIX}pay:${offerId}`),
                });
            } catch (err) {
                // Message too old or already changed. The application is still recorded.
                console.error('Could not update the apply button:', err);
            }
        }
    });

    bot.callbackQuery(new RegExp(`^${RESPONSE_PREFIX}(far|pay):(.+)$`), async (ctx) => {
        const [, code, offerId] = ctx.match as RegExpMatchArray;
        const kind = RESPONSE_CODES[code];

        const { rows } = await pool.query(
            `INSERT INTO "OfferResponse" ("subscriberId", "offerId", kind)
             SELECT s.id, t.id, $3
             FROM "TelegramSubscriber" s
             JOIN "TutoringOffer" t ON t.id = $2 AND t.status = 'OPEN'
             WHERE s."telegramId" = $1
             ON CONFLICT DO NOTHING
             RETURNING 1`,
            [ctx.from.id, offerId, kind]
        );

        if (rows.length > 0) {
            // Remember the turned-down sefer so future offers from it are filtered for this tutor.
            // Offers without a sefer cannot be filtered, so they only count in the stats.
            await pool.query(
                `INSERT INTO "SeferExclusion" ("subscriberId", "seferId", kind, "salaryBelowEtb")
                 SELECT s.id, t."seferId", $3::text,
                        CASE WHEN $3::text = 'LOW_SALARY' THEN t."monthlySalaryEtb" END
                 FROM "TelegramSubscriber" s
                 JOIN "TutoringOffer" t ON t.id = $2
                 WHERE s."telegramId" = $1 AND t."seferId" IS NOT NULL
                 ON CONFLICT ("subscriberId", "seferId", kind) DO UPDATE
                    SET "salaryBelowEtb" = CASE
                        WHEN EXCLUDED.kind = 'LOW_SALARY'
                        THEN GREATEST("SeferExclusion"."salaryBelowEtb", EXCLUDED."salaryBelowEtb")
                        ELSE NULL END`,
                [ctx.from.id, offerId, kind]
            );
            await ctx.answerCallbackQuery({ text: 'Thanks. Your answer is recorded.' });
            return;
        }
        // Either already sent, or the offer is closed or not available to this tutor.
        const { rows: prior } = await pool.query(
            `SELECT 1 FROM "OfferResponse" r
             JOIN "TelegramSubscriber" s ON s.id = r."subscriberId"
             WHERE s."telegramId" = $1 AND r."offerId" = $2 AND r.kind = $3`,
            [ctx.from.id, offerId, kind]
        );
        await ctx.answerCallbackQuery({
            text: prior.length > 0
                ? 'You already sent this answer for this offer.'
                : 'This offer is closed or not available to you.',
            show_alert: prior.length === 0,
        });
    });

    // Tutors' turned-down sefers, with an undo button for each.
    bot.command('turneddown', async (ctx) => {
        const { rows } = await pool.query<{ seferId: string; kind: ResponseKind; name: string; salaryBelowEtb: string | null }>(
            `SELECT x."seferId", x.kind, se.name, x."salaryBelowEtb"
             FROM "SeferExclusion" x
             JOIN "TelegramSubscriber" s ON s.id = x."subscriberId"
             JOIN "Sefer" se ON se.id = x."seferId"
             WHERE s."telegramId" = $1
             ORDER BY se.name, x.kind`,
            [ctx.from!.id]
        );
        if (rows.length === 0) {
            return ctx.reply('You have not turned down any sefers. Offers you mark as too far or low pay will show here.');
        }
        await ctx.reply('Sefers you turned down. Tap Undo to see their offers again. Offers already sent to you are not sent again.');
        for (const r of rows) {
            const reason = r.kind === 'TOO_FAR'
                ? 'Too far'
                : `Pay at or below ${Number(r.salaryBelowEtb).toLocaleString()} ETB`;
            await ctx.reply(`${r.name}\n${reason}`, {
                reply_markup: new InlineKeyboard().text('Undo', `unx:${r.kind === 'TOO_FAR' ? 'far' : 'pay'}:${r.seferId}`),
            });
        }
    });

    bot.callbackQuery(new RegExp(`^unx:(far|pay):(.+)$`), async (ctx) => {
        const [, code, seferId] = ctx.match as RegExpMatchArray;
        const kind = RESPONSE_CODES[code];
        const { rowCount } = await pool.query(
            `DELETE FROM "SeferExclusion" x
             USING "TelegramSubscriber" s
             WHERE s.id = x."subscriberId" AND s."telegramId" = $1
               AND x."seferId" = $2 AND x.kind = $3`,
            [ctx.from.id, seferId, kind]
        );
        if ((rowCount ?? 0) > 0) {
            await ctx.answerCallbackQuery({ text: 'Undone. Its offers can reach you again.' });
            await ctx.editMessageText('Undone.').catch(() => undefined);
        } else {
            await ctx.answerCallbackQuery({ text: 'Already undone.' });
        }
    });
}
