import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import {askGrades} from "./grades";

// Must match the subjects used in offers.
export const SUBJECTS = ['Mathematics', 'Physics', 'English', 'Chemistry'];

async function selectedSubjects(telegramId: number): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT subjects FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0]?.subjects ?? [];
}

function subjectKeyboard(selected: string[]) {
    const keyboard = new InlineKeyboard();
    SUBJECTS.forEach((subject, i) => {
        keyboard.text(`${selected.includes(subject) ? '✅ ' : ''}${subject}`, `subj:${subject}`);
        if (i % 2 === 1) keyboard.row();
    });
    keyboard.row().text('Done', 'subj:done');
    return keyboard;
}

export async function askSubjects(ctx: Context) {
    const selected = await selectedSubjects(ctx.from!.id);
    await ctx.reply('Which subjects do you teach? Tap to select, then tap Done.', {
        reply_markup: subjectKeyboard(selected),
    });
}

export function registerSubjectHandlers(bot: Bot) {
    bot.callbackQuery(/^subj:(.+)$/, async (ctx) => {
        const value = ctx.match[1];
        const telegramId = ctx.from.id;

        if (value === 'done') {
            const selected = await selectedSubjects(telegramId);
            if (selected.length === 0) {
                return ctx.answerCallbackQuery({ text: 'Select at least one subject.', show_alert: true });
            }
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(`Subjects saved: ${selected.join(', ')}.`);
            return askGrades(ctx);
        }

        // Add the subject if it isn't selected, remove it if it is.
        const { rows } = await pool.query(
            `UPDATE "TelegramSubscriber"
             SET subjects = CASE
                 WHEN $1::text = ANY(subjects) THEN array_remove(subjects, $1::text)
                 ELSE array_append(subjects, $1::text)
             END
             WHERE "telegramId" = $2
             RETURNING subjects`,
            [value, telegramId]
        );

        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: subjectKeyboard(rows[0]?.subjects ?? []) });
    });
}