// src/grades.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { askSubjects } from './subjects.js';
import { GRADES } from './curriculum.js';

async function selectedGrades(telegramId: number): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT grades FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0]?.grades ?? [];
}

const activeGradeSessions = new Map<number, string>();

function gradeKeyboard(selected: string[], sessionId: string) {
    const kb = new InlineKeyboard();
    GRADES.forEach((g) => {
        kb.text(`${selected.includes(g) ? '✅ ' : ''}${g}`, `grade:${sessionId}:${g}`).row();
    });
    kb.text('All grades', `grade:${sessionId}:ALL`).text('Clear', `grade:${sessionId}:CLEAR`);
    kb.row().text('Done', `grade:${sessionId}:DONE`);
    return kb;
}

export async function askGrades(ctx: Context) {
    const selected = await selectedGrades(ctx.from!.id);
    const sessionId = randomUUID();
    activeGradeSessions.set(ctx.from!.id, sessionId);
    await ctx.reply('What grade do you teach? Pick one or more, or tap All grades.', {
        reply_markup: gradeKeyboard(selected, sessionId),
    });
}

const lastGradeTap = new Map<number, { key: string; at: number }>();

export function clearTutorSession(telegramId: number) {
    activeGradeSessions.delete(telegramId);
    lastGradeTap.delete(telegramId);
}

export function registerGradeHandlers(bot: Bot) {
    bot.callbackQuery(/^grade:([^:]+):(.+)$/, async (ctx) => {
        const id = ctx.from.id;
        const [, sessionId, action] = ctx.match as RegExpMatchArray;
        if (activeGradeSessions.get(id) !== sessionId) {
            await ctx.answerCallbackQuery({ text: 'This grade-selection screen has expired.' });
            return;
        }
        const previous = lastGradeTap.get(id);
        const now = Date.now();
        if (previous?.key === action && now - previous.at < 700) {
            await ctx.answerCallbackQuery({ text: 'Already processing that tap.' });
            return;
        }
        lastGradeTap.set(id, { key: action, at: now });

        if (action === 'DONE') {
            const selected = await selectedGrades(id);
            if (selected.length === 0) {
                return ctx.answerCallbackQuery({ text: 'Pick at least one grade.' });
            }
            activeGradeSessions.delete(id);
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
        await ctx.editMessageReplyMarkup({ reply_markup: gradeKeyboard(next, sessionId) });
    });
}