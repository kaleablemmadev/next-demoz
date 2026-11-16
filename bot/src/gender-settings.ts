// src/gender-settings.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';

function genderKeyboard(current: string | null) {
    return new InlineKeyboard()
        .text(`${current === 'MALE' ? '✅ ' : ''}Male`, 'gset:MALE')
        .text(`${current === 'FEMALE' ? '✅ ' : ''}Female`, 'gset:FEMALE');
}

async function currentGender(telegramId: number): Promise<{ found: boolean; gender: string | null }> {
    const { rows } = await pool.query(
        `SELECT gender FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    if (!rows[0]) return { found: false, gender: null };
    return { found: true, gender: rows[0].gender ?? null };
}

async function showGender(ctx: Context) {
    const { found, gender } = await currentGender(ctx.from!.id);
    if (!found) {
        return ctx.reply('Send /start to register first.');
    }
    const label = gender === 'MALE' ? 'Male' : gender === 'FEMALE' ? 'Female' : 'not set';
    return ctx.reply(`Your gender is: ${label}. Tap to change it. This affects which offers match you.`, {
        reply_markup: genderKeyboard(gender),
    });
}

export function registerGenderSettingsHandlers(bot: Bot) {
    bot.command('gender', showGender);

    bot.callbackQuery(/^gset:(MALE|FEMALE)$/, async (ctx) => {
        const gender = ctx.match[1];
        await pool.query(
            `UPDATE "TelegramSubscriber" SET gender = $1 WHERE "telegramId" = $2`,
            [gender, ctx.from.id]
        );
        await ctx.answerCallbackQuery({ text: 'Saved.' });
        await ctx.editMessageText(
            `Your gender is now: ${gender === 'MALE' ? 'Male' : 'Female'}.`,
            { reply_markup: genderKeyboard(gender) }
        );
    });
}