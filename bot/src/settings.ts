// src/settings.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';

async function findSubscriber(telegramId: number) {
    const { rows } = await pool.query(
        `SELECT id, status, "pausedUntil" FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0] ?? null;
}

async function offerAlertsOn(subscriberId: string): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT enabled FROM "NotificationPreference" WHERE "subscriberId" = $1 AND category = 'OFFER_ALERTS'`,
        [subscriberId]
    );
    // No row means the default, which is on.
    return rows[0]?.enabled ?? true;
}

function menu(alertsOn: boolean) {
    return new InlineKeyboard()
        .text(alertsOn ? 'Turn offer alerts off' : 'Turn offer alerts on', alertsOn ? 'set:alerts:off' : 'set:alerts:on')
        .row()
        .text('Pause for 30 days', 'set:pause')
        .row()
        .text('Resume', 'set:resume')
        .row()
        .text('Stop all messages', 'set:stop');
}

async function showSettings(ctx: Context, telegramId: number) {
    const sub = await findSubscriber(telegramId);
    if (!sub) {
        return ctx.reply('Send /start first to set up your alerts.');
    }

    const alertsOn = await offerAlertsOn(sub.id);
    const pausedUntil = sub.pausedUntil ? new Date(sub.pausedUntil) : null;

    let status = 'Active';
    if (sub.status === 'STOPPED') status = 'All messages are stopped.';
    else if (sub.status === 'PAUSED' && pausedUntil) status = `Paused until ${pausedUntil.toLocaleDateString('en-GB')}.`;

    return ctx.reply(
        `Your alert settings\n\nOffer alerts: ${alertsOn ? 'on' : 'off'}\nStatus: ${status}`,
        { reply_markup: menu(alertsOn) }
    );
}

export function registerSettingsHandlers(bot: Bot) {
    bot.command('settings', (ctx) => showSettings(ctx, ctx.from!.id));

    bot.callbackQuery(/^set:(alerts:on|alerts:off|pause|resume|stop)$/, async (ctx) => {
        const telegramId = ctx.from.id;
        const sub = await findSubscriber(telegramId);
        const action = ctx.match[1];

        if (!sub) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /start first to set up your alerts.');
        }

        if (action === 'alerts:on' || action === 'alerts:off') {
            await pool.query(
                `INSERT INTO "NotificationPreference" ("subscriberId", "category", "enabled")
                 VALUES ($1, 'OFFER_ALERTS', $2)
                 ON CONFLICT ("subscriberId", "category") DO UPDATE SET "enabled" = EXCLUDED."enabled"`,
                [sub.id, action === 'alerts:on']
            );
        }

        if (action === 'pause') {
            await pool.query(
                `UPDATE "TelegramSubscriber" SET status = 'PAUSED', "pausedUntil" = now() + interval '30 days' WHERE id = $1`,
                [sub.id]
            );
        }

        if (action === 'resume') {
            await pool.query(
                `UPDATE "TelegramSubscriber" SET status = 'ACTIVE', "pausedUntil" = NULL WHERE id = $1`,
                [sub.id]
            );
        }

        if (action === 'stop') {
            await pool.query(`UPDATE "TelegramSubscriber" SET status = 'STOPPED' WHERE id = $1`, [sub.id]);
        }

        await ctx.answerCallbackQuery();
        await showSettings(ctx, telegramId);
    });
}