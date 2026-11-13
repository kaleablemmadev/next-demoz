import { Bot, InlineKeyboard } from 'grammy';
import { pool } from './db.js';

const CHECK_EVERY_MS = 60 * 1000;

type ChannelOffer = {
    id: string;
    title: string;
    subject: string;
    gradeLevel: string;
    subCity: string;
    monthlySalaryEtb: number;
    sessionsPerWeek: number;
    channelChatId: string;
};

function cardText(o: ChannelOffer): string {
    return [
        'Open tutoring offer',
        '',
        o.title,
        `${o.subject} · ${o.gradeLevel} · ${o.subCity}`,
        `${o.sessionsPerWeek} sessions a week`,
        `${o.monthlySalaryEtb.toLocaleString()} ETB / month`,
    ].join('\n');
}

// Posts every open offer that has never been posted, or is due for a repost.
async function postDueOffers(bot: Bot): Promise<void> {
    const { rows } = await pool.query<ChannelOffer>(`
        SELECT t.id, t.title, t.subject, t."gradeLevel", t."subCity",
               t."monthlySalaryEtb", t."sessionsPerWeek", o."channelChatId"
        FROM "TutoringOffer" t
        JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t.status = 'OPEN'
          AND o."channelChatId" IS NOT NULL
          AND (
              t."lastPostedToChannelAt" IS NULL
              OR t."lastPostedToChannelAt" < now() - make_interval(days => t."repostEveryDays")
          )
        LIMIT 20
    `);

    for (const o of rows) {
        try {
            const message = await bot.api.sendMessage(Number(o.channelChatId), cardText(o), {
                reply_markup: new InlineKeyboard().text('Close this offer', `close:${o.id}`),
            });

            await pool.query(
                `UPDATE "TutoringOffer"
                 SET "lastPostedToChannelAt" = now(), "channelMessageId" = $2
                 WHERE id = $1`,
                [o.id, message.message_id]
            );
        } catch (err) {
            console.error(`Channel post failed for offer ${o.id}:`, err);
        }
    }
}

export function registerRepostHandlers(bot: Bot) {
    // Only the agency that posted the offer can close it.
    bot.callbackQuery(/^close:(.+)$/, async (ctx) => {
        const offerId = ctx.match[1];

        const { rows } = await pool.query(
            `SELECT o."telegramUsername"
             FROM "TutoringOffer" t
             JOIN "Organization" o ON o.id = t."organizationId"
             WHERE t.id = $1`,
            [offerId]
        );
        const owner = rows[0]?.telegramUsername as string | undefined;

        if (!owner || owner.toLowerCase() !== (ctx.from.username ?? '').toLowerCase()) {
            return ctx.answerCallbackQuery({
                text: 'Only the agency that posted this offer can close it.',
                show_alert: true,
            });
        }

        await pool.query(
            `UPDATE "TutoringOffer" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1`,
            [offerId]
        );

        const originalText = ctx.callbackQuery.message?.text ?? 'Offer';
        await ctx.answerCallbackQuery({ text: 'Offer closed.' });
        await ctx.editMessageText(`${originalText}\n\nCLOSED`);
    });
}

// Checks every minute for offers to post or repost.
export function startRepostScheduler(bot: Bot) {
    let running = false;

    setInterval(async () => {
        if (running) return;
        running = true;
        try {
            await postDueOffers(bot);
        } catch (err) {
            console.error('Repost check failed:', err);
        } finally {
            running = false;
        }
    }, CHECK_EVERY_MS);
}