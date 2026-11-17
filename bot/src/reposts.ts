// src/reposts.ts

import { pool } from './db.js';
import { SUBJECTS } from './subjects.js';
import { GRADES } from './curriculum.js';
import { Bot, InlineKeyboard, type Api } from 'grammy';

const CHECK_EVERY_MS = 60 * 1000;
const WEEKS_PER_MONTH = 4.33;

type PostOffer = {
    id: string;
    title: string;
    subjects: string[];
    gradeLevels: string[];
    subCity: string;
    locationDetail: string | null;
    sessionsPerWeek: number;
    sessionHours: number | null;
    salaryUnit: 'MONTH' | 'HOUR';
    salaryAmountEtb: number;
    monthlySalaryEtb: number;
    preferredTutorGender: 'MALE' | 'FEMALE' | null;
    requirements: string | null;
    status: string;
    agencyName: string;
    agencyUsername: string;
    postHeader: string | null;
    postFooter: string | null;
    groupChatId: string | null;
    channelChatId: string | null;
    groupMessageId: string | null;
    channelMessageId: string | null;
    postDestination: 'GROUP' | 'CHANNEL' | 'BOTH';
    telegramUserId: string | null;
};

// Same select for posting and for closing, so both see the same fields.
const OFFER_SELECT = `
    SELECT t.id, t.title, t.subjects, t."gradeLevels", t."subCity", t."locationDetail",
           t."sessionsPerWeek", t."sessionHours", t."salaryUnit", t."salaryAmountEtb",
           t."monthlySalaryEtb", t."preferredTutorGender", t.requirements, t.status,
           t."groupMessageId", t."channelMessageId",
           o.name AS "agencyName", o."telegramUsername" AS "agencyUsername",
           o."postHeader", o."postFooter", o."groupChatId", o."channelChatId", o."telegramUserId",
           COALESCE(o."postDestination", 'GROUP') AS "postDestination"
    FROM "TutoringOffer" t
    JOIN "Organization" o ON o.id = t."organizationId"`;

async function loadOffer(id: string): Promise<PostOffer | null> {
    const { rows } = await pool.query<PostOffer>(`${OFFER_SELECT} WHERE t.id = $1`, [id]);
    return rows[0] ?? null;
}

// "All Subjects" when every option is included, the list otherwise.
function listLabel(items: string[], all: readonly string[], allLabel: string): string {
    if (items.length === 0 || all.every((x) => items.includes(x))) return allLabel;
    return items.join(', ');
}

// Rounds a number to the nearest step, for example nearest 50 or nearest 5.
function roundTo(value: number, step: number): number {
    return Math.round(value / step) * step;
}

function payLine(o: PostOffer): string {
    if (o.salaryUnit === 'HOUR') {
        return `${o.salaryAmountEtb.toLocaleString()} ETB per hour (about ${o.monthlySalaryEtb.toLocaleString()} ETB per month)`;
    }
    const hoursPerMonth = (o.sessionHours ?? 0) * o.sessionsPerWeek * WEEKS_PER_MONTH;
    const perHour = hoursPerMonth > 0 ? roundTo(o.salaryAmountEtb / hoursPerMonth, 5) : 0;
    return `${o.salaryAmountEtb.toLocaleString()} ETB per month (about ${perHour.toLocaleString()} ETB per hour)`;
}

// The offer card, with one detail per line. Used for every group or channel post.
function cardText(o: PostOffer): string {
    const genderLabel = o.preferredTutorGender === 'MALE' ? 'Male' : o.preferredTutorGender === 'FEMALE' ? 'Female' : 'Any';
    const lines: string[] = [o.postHeader ?? 'Open tutoring offer', ''];

    lines.push(
        `Subjects: ${listLabel(o.subjects, SUBJECTS, 'All Subjects')}`,
        `Grades: ${listLabel(o.gradeLevels, GRADES, 'All Grades')}`,
        `Area: ${o.subCity}`
    );
    if (o.locationDetail) lines.push(`Location: ${o.locationDetail}`);
    lines.push(`Sessions: ${o.sessionsPerWeek} per week`);
    if (o.sessionHours) lines.push(`Session length: ${o.sessionHours} hours`);
    lines.push(`Pay: ${payLine(o)}`, `Tutor gender: ${genderLabel}`);
    if (o.requirements) lines.push(`Requirements: ${o.requirements}`);
    lines.push(`Contact: @${o.agencyUsername}`);
    if (o.postFooter) lines.push('', o.postFooter);

    return lines.join('\n');
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
                const message = await bot.api.sendMessage(target.chatId, cardText(o), {
                    reply_markup: offerButtons(o),
                });
                if (target.kind === 'group') groupMessageId = message.message_id;
                else channelMessageId = message.message_id;
            } catch (err) {
                console.error(`Post to ${target.kind} failed for offer ${o.id}:`, err);
            }
        }

        async function deleteOldPost(bot: Bot, chatId: string | null, messageId: string | null, offerId: string) {
            if (!chatId || !messageId) return;
            try {
                await bot.api.deleteMessage(Number(chatId), Number(messageId));
            } catch (err) {
                console.error(`Could not delete old post for offer ${offerId}:`, err);
            }
        }

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

        const closedText = `${cardText(o)}\n\nCLOSED`;
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

// Closes an offer and updates its group and channel posts. Used by the admin and leave approvals.
export async function closeOfferEverywhere(api: Api, offerId: string): Promise<void> {
    const o = await loadOffer(offerId);
    if (!o) return;

    await pool.query(
        `UPDATE "TutoringOffer" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1 AND status = 'OPEN'`,
        [o.id]
    );

    const closedText = `${cardText(o)}\n\nCLOSED`;
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