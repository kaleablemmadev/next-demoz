// src/subjects.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { askGrades } from './grades.js';

import { SUBJECTS } from './curriculum.js';
export { SUBJECTS };

async function selectedSubjects(telegramId: number): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT subjects FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0]?.subjects ?? [];
}

function subjectKeyboard(selected: string[]) {
    const kb = new InlineKeyboard();
    SUBJECTS.forEach((s, i) => {
        kb.text(`${selected.includes(s) ? '✅ ' : ''}${s}`, `subj:${s}`);
        if (i % 2 === 1) kb.row();
    });
    kb.row().text('All subjects', 'subj:ALL').text('Clear', 'subj:CLEAR');
    kb.row().text('Done', 'subj:DONE');
    return kb;
}

export async function askSubjects(ctx: Context) {
    const selected = await selectedSubjects(ctx.from!.id);
    await ctx.reply('Which subjects do you teach? Pick one or more, or tap All subjects.', {
        reply_markup: subjectKeyboard(selected),
    });
}

export function registerSubjectHandlers(bot: Bot) {
    bot.callbackQuery(/^subj:(.+)$/, async (ctx) => {
        const id = ctx.from.id;
        const action = ctx.match[1];

        if (action === 'DONE') {
            const selected = await selectedSubjects(id);
            if (selected.length === 0) {
                return ctx.answerCallbackQuery({ text: 'Pick at least one subject.' });
            }
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(`Subjects: ${selected.join(', ')}`);
            return askGrades(ctx);
        }

        let next: string[];
        if (action === 'ALL') {
            next = [...SUBJECTS];
        } else if (action === 'CLEAR') {
            next = [];
        } else {
            const current = await selectedSubjects(id);
            next = current.includes(action)
                ? current.filter((s) => s !== action)
                : [...current, action];
        }

        await pool.query(
            `UPDATE "TelegramSubscriber" SET subjects = $2::text[] WHERE "telegramId" = $1`,
            [id, next]
        );
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: subjectKeyboard(next) });
    });
}