import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';

// The four choices a tutor picks from. null means "any salary".
export const SALARY_OPTIONS: { label: string; value: number | null }[] = [
    { label: 'Any salary', value: null },
    { label: '2,000+ ETB', value: 2000 },
    { label: '2,500+ ETB', value: 2500 },
    { label: '3,000+ ETB', value: 3000 },
];

export async function askSalary(ctx: Context) {
    const keyboard = new InlineKeyboard();
    SALARY_OPTIONS.forEach((option, i) => {
        keyboard.text(option.label, `salary:${option.value ?? 'any'}`);
        if (i % 2 === 1) keyboard.row();
    });

    await ctx.reply('Last question: what is the lowest monthly salary you want offers for?', {
        reply_markup: keyboard,
    });
}

export function registerSalaryHandlers(bot: Bot) {
    bot.callbackQuery(/^salary:(.+)$/, async (ctx) => {
        const raw = ctx.match[1];
        const value = raw === 'any' ? null : Number(raw);
        const label = SALARY_OPTIONS.find((o) => o.value === value)?.label ?? 'Any salary';

        await pool.query(
            `UPDATE "TelegramSubscriber" SET "minSalaryEtb" = $1 WHERE "telegramId" = $2`,
            [value, ctx.from.id]
        );

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Salary filter saved: ${label}. You're all set.`);
        await ctx.reply('See the list of first offers?', {
            reply_markup: new InlineKeyboard().text('Show offers', 'offers:show'),
        });
    });
}