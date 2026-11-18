// src/subjects.ts

import { Bot, type Context } from 'grammy';
import { pool } from './db.js';
import { askGender } from './gender.js';

export const MAX_SUBJECTS = 12;
export const MAX_SUBJECT_LENGTH = 60;
const SESSION_TTL_MS = 15 * 60 * 1000;

type SubjectSession = { startedAt: number };
const subjectSessions = new Map<number, SubjectSession>();

export function parseTutorSubjects(input: string): string[] {
    const values = input
        .split(/[,;\n]/)
        .map((value) => value.trim().replace(/\s+/g, ' '))
        .filter(Boolean);

    const unique = new Map<string, string>();
    for (const value of values) {
        const key = value.toLocaleLowerCase();
        if (!unique.has(key)) unique.set(key, value);
    }
    return [...unique.values()];
}

export async function askSubjects(ctx: Context): Promise<void> {
    const { rows } = await pool.query<{ subjects: string[] }>(
        `SELECT subjects FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [ctx.from!.id]
    );
    const current = rows[0]?.subjects ?? [];
    subjectSessions.set(ctx.from!.id, { startedAt: Date.now() });

    const currentLine = current.length
        ? `\n\nCurrently saved: ${current.join(', ')}`
        : '';

    await ctx.reply(
        'Which subjects do you teach? Type them in one message, separated by commas.\n' +
        'Example: Mathematics, Physics, Chemistry.\n' +
        `You can enter up to ${MAX_SUBJECTS} subjects. Send /skip if you want to add them later.${currentLine}`
    );
}

export function clearSubjectSession(telegramId: number): void {
    subjectSessions.delete(telegramId);
}

export function registerSubjectHandlers(bot: Bot): void {
    // Restarting onboarding should never leave the user trapped in an old text step.
    bot.command('start', async (ctx, next) => {
        if (ctx.from) subjectSessions.delete(ctx.from.id);
        return next();
    });

    bot.on('message:text', async (ctx, next) => {
        const telegramId = ctx.from?.id;
        if (telegramId === undefined) return next();

        const session = subjectSessions.get(telegramId);
        if (!session) return next();

        const message = ctx.message.text.trim();
        if (message.startsWith('/')) return next();

        if (Date.now() - session.startedAt > SESSION_TTL_MS) {
            subjectSessions.delete(telegramId);
            await ctx.reply('That subject-entry step expired. Send /start to continue your tutor setup.');
            return;
        }

        const subjects = parseTutorSubjects(message);
        if (subjects.length === 0) {
            await ctx.reply('Please type at least one subject, or send /skip.');
            return;
        }
        if (subjects.length > MAX_SUBJECTS) {
            await ctx.reply(`Please enter no more than ${MAX_SUBJECTS} subjects, separated by commas.`);
            return;
        }
        const tooLong = subjects.find((subject) => subject.length > MAX_SUBJECT_LENGTH);
        if (tooLong) {
            await ctx.reply(`Each subject must be ${MAX_SUBJECT_LENGTH} characters or fewer. Please shorten: ${tooLong}`);
            return;
        }

        await pool.query(
            `UPDATE "TelegramSubscriber" SET subjects = $1::text[] WHERE "telegramId" = $2`,
            [subjects, telegramId]
        );
        subjectSessions.delete(telegramId);

        await ctx.reply(`Subjects saved: ${subjects.join(', ')}.`);
        await askGender(ctx);
    });

    bot.command('skip', async (ctx, next) => {
        const telegramId = ctx.from?.id;
        if (telegramId === undefined || !subjectSessions.has(telegramId)) return next();

        await pool.query(
            `UPDATE "TelegramSubscriber" SET subjects = ARRAY[]::text[] WHERE "telegramId" = $1`,
            [telegramId]
        );
        subjectSessions.delete(telegramId);
        await ctx.reply('No subjects added. You can update them later.');
        await askGender(ctx);
    });
}
