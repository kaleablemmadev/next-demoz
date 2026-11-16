import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { askGrades } from './grades.js';

export async function startTutorOnboarding(ctx: Context, source = 'direct') {
    const from = ctx.from!;

    await pool.query(
        `INSERT INTO "TelegramSubscriber" ("telegramId", "firstName", "username", "sourceChannel")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("telegramId") DO NOTHING`,
        [from.id, from.first_name ?? null, from.username ?? null, source]
    );

    const keyboard = new InlineKeyboard();
    KNOWN_SUB_CITIES.forEach((city, i) => {
        keyboard.text(city, `area:${city}`);
        if (i % 2 === 1) keyboard.row();
    });

    await ctx.reply('Welcome to NextTutor alerts. Which sub-city do you teach in?', {
        reply_markup: keyboard,
    });
}

export function registerOnboardingHandlers(bot: Bot) {
    bot.callbackQuery(/^area:(.+)$/, async (ctx) => {
        const subCity = ctx.match[1];

        await pool.query(
            `UPDATE "TelegramSubscriber" SET "subCity" = $1 WHERE "telegramId" = $2`,
            [subCity, ctx.from.id]
        );

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Saved: ${subCity}.`);
        await askGrades(ctx);
    });
}
