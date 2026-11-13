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

        await pool.query(
            `UPDATE "TelegramSubscriber" SET gender = $1 WHERE "telegramId" = $2`,
            [gender, ctx.from.id]
        );

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Gender saved: ${gender === 'MALE' ? 'Male' : 'Female'}.`);
        await askSalary(ctx);
    });
}