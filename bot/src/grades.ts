// src/grades.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { askSubjects } from './subjects.js';
import { GRADES, subjectsForGrades } from './curriculum.js';

async function selectedGrades(telegramId: number): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT grades FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0]?.grades ?? [];
}

function gradeKeyboard(selected: string[]) {
    const kb = new InlineKeyboard();
    GRADES.forEach((g) => {
        kb.text(`${selected.includes(g) ? '✅ ' : ''}${g}`, `grade:${g}`).row();
    });
    kb.text('All grades', 'grade:ALL').text('Clear', 'grade:CLEAR');
    kb.row().text('Done', 'grade:DONE');
    return kb;
}

export async function askGrades(ctx: Context) {
    const selected = await selectedGrades(ctx.from!.id);
    await ctx.reply('What grade do you teach? Pick one or more, or tap All grades.', {
        reply_markup: gradeKeyboard(selected),
    });
}

export function registerGradeHandlers(bot: Bot) {
    bot.callbackQuery(/^grade:(.+)$/, async (ctx) => {
        const id = ctx.from.id;
        const action = ctx.match[1];

        if (action === 'DONE') {
            const selected = await selectedGrades(id);
            if (selected.length === 0) {
                return ctx.answerCallbackQuery({ text: 'Pick at least one grade.' });
            }
            if (subjectsForGrades(selected).length === 0) {
                return ctx.answerCallbackQuery({ text: 'No subjects are listed for KG. Pick another grade.' });
            }
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(`Grades: ${selected.join(', ')}`);
            return askSubjects(ctx);
        }

        let next: string[];
        if (action === 'ALL') {
            next = [...GRADES];
        } else if (action === 'CLEAR') {
            next = [];
        } else {
            const current = await selectedGrades(id);
            next = current.includes(action)
                ? current.filter((g) => g !== action)
                : [...current, action];
        }

        await pool.query(
            `UPDATE "TelegramSubscriber" SET grades = $2::text[] WHERE "telegramId" = $1`,
            [id, next]
        );
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: gradeKeyboard(next) });
    });
}