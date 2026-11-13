import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import {askSalary} from "./salary";

// Must match the grades used in offers.
export const GRADES = ['Grade 4', 'Grade 8', 'Grade 11'];

async function selectedGrades(telegramId: number): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT grades FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0]?.grades ?? [];
}

function gradeKeyboard(selected: string[]) {
    const keyboard = new InlineKeyboard();
    GRADES.forEach((grade) => {
        keyboard.text(`${selected.includes(grade) ? '✅ ' : ''}${grade}`, `grade:${grade}`).row();
    });
    keyboard.text('Done', 'grade:done');
    return keyboard;
}

export async function askGrades(ctx: Context) {
    const selected = await selectedGrades(ctx.from!.id);
    await ctx.reply('Which grades do you teach? Tap to select, then tap Done.', {
        reply_markup: gradeKeyboard(selected),
    });
}

export function registerGradeHandlers(bot: Bot) {
    bot.callbackQuery(/^grade:(.+)$/, async (ctx) => {
        const value = ctx.match[1];
        const telegramId = ctx.from.id;

        if (value === 'done') {
            const selected = await selectedGrades(telegramId);
            if (selected.length === 0) {
                return ctx.answerCallbackQuery({ text: 'Select at least one grade.', show_alert: true });
            }
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(`Grades saved: ${selected.join(', ')}.`);
            return askSalary(ctx);
        }

        const { rows } = await pool.query(
            `UPDATE "TelegramSubscriber"
             SET grades = CASE
                 WHEN $1::text = ANY(grades) THEN array_remove(grades, $1::text)
                 ELSE array_append(grades, $1::text)
             END
             WHERE "telegramId" = $2
             RETURNING grades`,
            [value, telegramId]
        );

        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: gradeKeyboard(rows[0]?.grades ?? []) });
    });
}