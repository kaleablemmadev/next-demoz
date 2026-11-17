// src/gender.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { askSalary } from './salary.js';

export async function askGender(ctx: Context) {
    const keyboard = new InlineKeyboard()
        .text('Male', 'gender:MALE')
        .text('Female', 'gender:FEMALE');

    await ctx.reply('What is your gender? Offers that ask for a specific tutor gender will use this.', {
        reply_markup: keyboard,
    });
}

export function registerGenderHandlers(bot: Bot) {
    bot.callbackQuery(/^gender:(MALE|FEMALE)$/, async (ctx) => {
        const gender = ctx.match[1];

        const { rows } = await pool.query(
            `UPDATE "TelegramSubscriber" SET gender = $1
             WHERE "telegramId" = $2 AND gender IS DISTINCT FROM $1
             RETURNING "telegramId"`,
            [gender, ctx.from.id]
        );
        if (rows.length === 0) {
            await ctx.answerCallbackQuery({ text: 'This choice has already been saved.' });
            return;
        }
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Gender saved: ${gender === 'MALE' ? 'Male' : 'Female'}.`);
        await askSalary(ctx);
    });
}