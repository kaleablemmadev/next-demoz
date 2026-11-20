// src/apply.ts
// "I applied" button on offer alerts. Records the tutor's application so the agency and admin can see counts.

import { Bot, InlineKeyboard } from 'grammy';
import { pool } from './db.js';

export const APPLY_PREFIX = 'apply:';

// The button tutors see under each offer alert.
export function applyKeyboard(offerId: string): InlineKeyboard {
    return new InlineKeyboard().text('I applied', `${APPLY_PREFIX}${offerId}`);
}

// Number of tutors who have tapped "I applied" for an offer.
export async function applicationCount(offerId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "OfferApplication" WHERE "offerId" = $1`,
        [offerId]
    );
    return Number(rows[0].n);
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
                    reply_markup: new InlineKeyboard().text('✅ Applied', `${APPLY_PREFIX}${offerId}`),
                });
            } catch (err) {
                // Message too old or already changed. The application is still recorded.
                console.error('Could not update the apply button:', err);
            }
        }
    });
}
