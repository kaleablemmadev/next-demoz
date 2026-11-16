// src/subjects.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { askGender } from './gender.js';

import { SUBJECTS, subjectsForGrades } from './curriculum.js';
export { SUBJECTS };

async function selectedSubjects(telegramId: number): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT subjects FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0]?.subjects ?? [];
}

async function selectedGrades(telegramId: number): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT grades FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0]?.grades ?? [];
}

function subjectKeyboard(subjects: string[], selected: string[]) {
    const kb = new InlineKeyboard();
    subjects.forEach((s, i) => {
        kb.text(`${selected.includes(s) ? '✅ ' : ''}${s}`, `subj:${s}`);
        if (i % 2 === 1) kb.row();
    });
    kb.row().text('All subjects', 'subj:ALL').text('Clear', 'subj:CLEAR');
    kb.row().text('Done', 'subj:DONE');
    return kb;
}

export async function askSubjects(ctx: Context) {
    const id = ctx.from!.id;
    const grades = await selectedGrades(id);
    const subjects = subjectsForGrades(grades);
    const saved = await selectedSubjects(id);
    const selected = saved.filter((subject) => subjects.includes(subject));

    if (selected.length !== saved.length) {
        await pool.query(
            `UPDATE "TelegramSubscriber" SET subjects = $2::text[] WHERE "telegramId" = $1`,
            [id, selected]
        );
    }

    const gradeLabel = grades.length === 1 ? ` in ${grades[0]}` : ` in ${grades.join(', ')}`;
    await ctx.reply(
        `Which subjects do you teach${gradeLabel}? Pick one or more, or tap All subjects.`,
        { reply_markup: subjectKeyboard(subjects, selected) }
    );
}

export function registerSubjectHandlers(bot: Bot) {
    bot.callbackQuery(/^subj:(.+)$/, async (ctx) => {
        const id = ctx.from.id;
        const action = ctx.match[1];
        const subjects = subjectsForGrades(await selectedGrades(id));
        const current = (await selectedSubjects(id)).filter((subject) => subjects.includes(subject));

        if (action === 'DONE') {
            if (current.length === 0) {
                return ctx.answerCallbackQuery({ text: 'Pick at least one subject.' });
            }
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(`Subjects: ${current.join(', ')}`);
            return askGender(ctx);
        }

        let next: string[];
        if (action === 'ALL') {
            next = [...subjects];
        } else if (action === 'CLEAR') {
            next = [];
        } else {
            if (!subjects.includes(action)) {
                return ctx.answerCallbackQuery({ text: 'That subject is not offered for the selected grades.' });
            }
            next = current.includes(action)
                ? current.filter((s) => s !== action)
                : [...current, action];
        }

        await pool.query(
            `UPDATE "TelegramSubscriber" SET subjects = $2::text[] WHERE "telegramId" = $1`,
            [id, next]
        );
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: subjectKeyboard(subjects, next) });
    });
}