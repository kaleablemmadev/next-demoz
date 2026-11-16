// src/digest.ts

import { Bot, InlineKeyboard } from 'grammy';
import { pool } from './db.js';
import { findMatchingOffers } from './offers.js';
import { payLine, summaryLine } from './card.js';

const DIGEST_HOUR = 8;          // 08:00 Addis Ababa time
const CHECK_EVERY_MS = 5 * 60 * 1000;
const PREVIEW_LIMIT = 5;

// Current date and weekday in Addis Ababa time.
function addisNow() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Addis_Ababa',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date());

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        weekday: get('weekday'),
        hour: Number(get('hour')),
    };
}

// Records this Monday's digest. Returns false if it was already claimed.
async function claimDigest(dateKey: string): Promise<boolean> {
    const { rows } = await pool.query(
        `INSERT INTO "DigestRun" ("weekKey") VALUES ($1) ON CONFLICT DO NOTHING RETURNING "weekKey"`,
        [dateKey]
    );
    return rows.length === 1;
}

// Active subscribers who haven't paused alerts or switched off offer alerts.
async function digestRecipients(): Promise<number[]> {
    const { rows } = await pool.query(`
        SELECT s."telegramId"::text AS "telegramId"
        FROM "TelegramSubscriber" s
        WHERE s.status = 'ACTIVE'
          AND s."subCity" IS NOT NULL
          AND (s."pausedUntil" IS NULL OR s."pausedUntil" < now())
          AND NOT EXISTS (
            SELECT 1 FROM "NotificationPreference" p
            WHERE p."subscriberId" = s.id
              AND p.category = 'OFFER_ALERTS'
              AND p.enabled = false
        )
    `);
    return rows.map((r) => Number(r.telegramId));
}

// Sends the Monday digest. With force = true it ignores the day, hour and weekly check.
export async function sendWeeklyDigest(bot: Bot, force = false): Promise<number> {
    const now = addisNow();

    if (!force) {
        if (now.weekday !== 'Mon' || now.hour < DIGEST_HOUR) return 0;
        if (!(await claimDigest(now.date))) return 0;
    }

    let sent = 0;

    for (const telegramId of await digestRecipients()) {
        const offers = await findMatchingOffers(telegramId);

        // No message when nothing matches.
        if (offers.length === 0) continue;

        const lines = offers.slice(0, PREVIEW_LIMIT).map(
            (o, i) =>
                `${i + 1}. ${o.title}\n` +
                `   ${summaryLine(o)}\n` +
                `   ${payLine(o)}\n` +
                `   Contact: @${o.agencyUsername}`
        );

        const more = offers.length > PREVIEW_LIMIT
            ? `\n\n…and ${offers.length - PREVIEW_LIMIT} more.`
            : '';

        const text = `Your open offers this week (${offers.length}):\n\n${lines.join('\n\n')}${more}`;

        try {
            await bot.api.sendMessage(telegramId, text, {
                reply_markup: new InlineKeyboard().text('Show all offers', 'offers:show'),
            });
            sent++;
        } catch (err) {
            console.error(`Digest not delivered to ${telegramId}:`, err);
        }
    }

    return sent;
}

// Checks every five minutes, so the digest goes out soon after 08:00 on Monday.
export function startDigestScheduler(bot: Bot) {
    const run = () =>
        sendWeeklyDigest(bot).catch((err) => console.error('Digest check failed:', err));

    run();
    setInterval(run, CHECK_EVERY_MS);
}