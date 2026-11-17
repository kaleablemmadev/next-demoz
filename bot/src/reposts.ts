// src/reposts.ts

import { pool } from './db.js';
import type { PoolClient } from 'pg';
import { Bot, InlineKeyboard, type Api } from 'grammy';
import { offerCardText, type CardOffer } from './card.js';

const CHECK_EVERY_MS = 60 * 1000;
const WEEKS_PER_MONTH = 4.33;

type PostOffer = CardOffer & {
    id: string;
    status: string;
    groupChatId: string | null;
    channelChatId: string | null;
    groupMessageId: string | null;
    channelMessageId: string | null;
    postDestination: 'GROUP' | 'CHANNEL' | 'BOTH';
    telegramUserId: string | null;
};

// Same select for posting and for closing, so both see the same fields.
const OFFER_SELECT = `
    SELECT t.id, t.title, t.subject, t."gradeLevels", t."subCity",
           t."locationDetail", t."sessionsPerWeek", t."sessionHours",
           t."salaryUnit", t."salaryAmountEtb", t."monthlySalaryEtb",
           t."preferredTutorGender", t.requirements, t.status,
           t."groupMessageId", t."channelMessageId",
           o.name AS "agencyName",
           o."telegramUsername" AS "agencyUsername",
           o."postTemplate", o."groupChatId", o."channelChatId",
           o."telegramUserId",
           COALESCE(o."postDestination", 'GROUP') AS "postDestination"
    FROM "TutoringOffer" t
    JOIN "Organization" o ON o.id = t."organizationId"`;

async function loadOffer(id: string): Promise<PostOffer | null> {
    const { rows } = await pool.query<PostOffer>(`${OFFER_SELECT} WHERE t.id = $1`, [id]);
    return rows[0] ?? null;
}

// Which chats an offer goes to, based on the agency's setting.
function targets(o: PostOffer): { kind: 'group' | 'channel'; chatId: number }[] {
    const list: { kind: 'group' | 'channel'; chatId: number }[] = [];
    if ((o.postDestination === 'GROUP' || o.postDestination === 'BOTH') && o.groupChatId) {
        list.push({ kind: 'group', chatId: Number(o.groupChatId) });
    }
    if ((o.postDestination === 'CHANNEL' || o.postDestination === 'BOTH') && o.channelChatId) {
        list.push({ kind: 'channel', chatId: Number(o.channelChatId) });
    }
    return list;
}

// After this many failed attempts, an offer stops being retried until someone resets it.
const MAX_POST_FAILURES = 5;

// The two buttons under every group or channel post.
function offerButtons(o: PostOffer) {
    return new InlineKeyboard()
        .text('Close this offer', `close:${o.id}`)
        .row()
        .text('Stop reposting', `stop:${o.id}`);
}

// Posts every open offer that has never been posted, or is due for a repost.
async function postDueOffers(bot: Bot): Promise<void> {
    const { rows } = await pool.query<PostOffer>(`
        ${OFFER_SELECT}
        WHERE t.status = 'OPEN'
          AND t."repostStopped" = false
          AND t."postFailures" < ${MAX_POST_FAILURES}
          AND (o."groupChatId" IS NOT NULL OR o."channelChatId" IS NOT NULL)
          AND (
              t."lastPostedToChannelAt" IS NULL
              OR t."lastPostedToChannelAt" < now() - make_interval(days => t."repostEveryDays")
          )
        LIMIT 20
    `);

    for (const o of rows) {
        let groupMessageId: number | null = null;
        let channelMessageId: number | null = null;

        for (const target of targets(o)) {
            try {
                const message = await bot.api.sendMessage(target.chatId, offerCardText(o, 'OPEN'), {
                    reply_markup: offerButtons(o),
                });
                if (target.kind === 'group') groupMessageId = message.message_id;
                else channelMessageId = message.message_id;
            } catch (err) {
                console.error(`Post to ${target.kind} failed for offer ${o.id}:`, err);
            }
        }

        // A new post went out, so remove the previous one in each chat.
        if (groupMessageId !== null) await deleteOldPost(bot, o.groupChatId, o.groupMessageId, o.id);
        if (channelMessageId !== null) await deleteOldPost(bot, o.channelChatId, o.channelMessageId, o.id);

        if (groupMessageId !== null || channelMessageId !== null) {
            await pool.query(
                `UPDATE "TutoringOffer"
                 SET "lastPostedToChannelAt" = now(),
                     "groupMessageId" = COALESCE($2, "groupMessageId"),
                     "channelMessageId" = COALESCE($3, "channelMessageId"),
                     "postFailures" = 0
                 WHERE id = $1`,
                [o.id, groupMessageId, channelMessageId]
            );
            continue;
        }

        // Nothing was posted. Count the failure.
        const { rows: counted } = await pool.query(
            `UPDATE "TutoringOffer" SET "postFailures" = "postFailures" + 1
             WHERE id = $1 RETURNING "postFailures"`,
            [o.id]
        );
        const failures = Number(counted[0]?.postFailures ?? 0);
        if (failures !== MAX_POST_FAILURES) continue;

        // The offer has just paused. Tell the agency once.
        console.error(`Offer ${o.id} paused after ${failures} failed posts.`);

        if (!o.telegramUserId) {
            console.error(
                `Agency @${o.agencyUsername} has not opened the bot yet, so it could not be told that reposting paused.`
            );
            continue;
        }

        try {
            await bot.api.sendMessage(
                Number(o.telegramUserId),
                `Reposting paused for "${o.title}".\n\n` +
                `The bot could not post this offer to your group or channel ${failures} times in a row. ` +
                'Check that the bot is still a member and an admin with permission to post there. ' +
                'Then contact NextTutor to restart reposting.'
            );
        } catch (err) {
            console.error(`Could not message agency @${o.agencyUsername} about paused offer ${o.id}:`, err);
        }
    }
}

// Deletes an old group or channel post. Best effort: a failure is logged and the repost still goes out.
async function deleteOldPost(bot: Bot, chatId: string | null, messageId: string | null, offerId: string) {
    if (!chatId || !messageId) return;
    try {
        await bot.api.deleteMessage(Number(chatId), Number(messageId));
    } catch (err) {
        console.error(`Could not delete old post for offer ${offerId}:`, err);
    }
}

export function registerRepostHandlers(bot: Bot) {
    // Only the agency that posted the offer can close it. Closing updates every place it was posted.
    bot.callbackQuery(/^close:(.+)$/, async (ctx) => {
        const o = await loadOffer(ctx.match[1]);

        if (!o || o.agencyUsername.toLowerCase() !== (ctx.from.username ?? '').toLowerCase()) {
            return ctx.answerCallbackQuery({
                text: 'Only the agency that posted this offer can close it.',
                show_alert: true,
            });
        }

        await pool.query(
            `UPDATE "TutoringOffer" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1`,
            [o.id]
        );

        const closedText = offerCardText(o, 'CLOSED');
        const places = [
            { chat: o.groupChatId, message: o.groupMessageId },
            { chat: o.channelChatId, message: o.channelMessageId },
        ];

        for (const place of places) {
            if (!place.chat || !place.message) continue;
            try {
                await bot.api.editMessageText(Number(place.chat), Number(place.message), closedText);
            } catch (err) {
                console.error(`Could not mark offer ${o.id} closed in chat ${place.chat}:`, err);
            }
        }

        await ctx.answerCallbackQuery({ text: 'Offer closed.' });
    });

    // Only the agency that posted the offer can stop reposting it. The offer stays open.
    bot.callbackQuery(/^stop:(.+)$/, async (ctx) => {
        const o = await loadOffer(ctx.match[1]);

        if (!o || o.agencyUsername.toLowerCase() !== (ctx.from.username ?? '').toLowerCase()) {
            return ctx.answerCallbackQuery({
                text: 'Only the agency that posted this offer can change it.',
                show_alert: true,
            });
        }

        await pool.query(`UPDATE "TutoringOffer" SET "repostStopped" = true WHERE id = $1`, [o.id]);

        await ctx.answerCallbackQuery({ text: 'Reposting stopped. The offer stays open.' });
        await ctx.editMessageReplyMarkup({
            reply_markup: new InlineKeyboard().text('Close this offer', `close:${o.id}`),
        });
    });
}

// Checks every minute for offers to post or repost.
export function startRepostScheduler(bot: Bot) {
    let running = false;

    const run = async () => {
        if (running) return;
        running = true;
        let client: PoolClient | null = null;
        let locked = false;
        try {
            client = await pool.connect();
            const result = await client.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
                ['nexttutor:repost-scheduler']
            );
            locked = result.rows[0]?.locked === true;
            if (!locked) return;
            await postDueOffers(bot);
        } catch (err) {
            console.error('Repost check failed:', err);
        } finally {
            if (locked && client) {
                await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['nexttutor:repost-scheduler']).catch(() => undefined);
            }
            client?.release();
            running = false;
        }
    };

    run();
    setInterval(run, CHECK_EVERY_MS);
}

// Closes an offer and updates its group and channel posts. Used by the admin and leave approvals.
export async function closeOfferEverywhere(api: Api, offerId: string): Promise<void> {
    const o = await loadOffer(offerId);
    if (!o) return;

    await pool.query(
        `UPDATE "TutoringOffer" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1 AND status = 'OPEN'`,
        [o.id]
    );

    const closedText = offerCardText(o, 'CLOSED');
    const places = [
        { chat: o.groupChatId, message: o.groupMessageId },
        { chat: o.channelChatId, message: o.channelMessageId },
    ];

    for (const place of places) {
        if (!place.chat || !place.message) continue;
        try {
            await api.editMessageText(Number(place.chat), Number(place.message), closedText);
        } catch (err) {
            console.error(`Could not mark offer ${o.id} closed in chat ${place.chat}:`, err);
        }
    }
}