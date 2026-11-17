// src/parent.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { recordAuditEvent, withTransaction } from './audit.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { GRADES } from './curriculum.js';

type Step =
    | 'contact' | 'grade' | 'area' | 'location' | 'weak'
    | 'sessions' | 'budget' | 'gender' | 'notes' | 'confirm';

type Draft = {
    id: string;
    parentId: string;
    contactHandle: string | null;
    step: Step;
    gradeLevel?: string;
    subCity?: string;
    locationDetail?: string | null;
    weakSubjects?: string | null;
    sessionsPerWeek?: number;
    budgetEtb?: number;
    preferredTutorGender?: 'MALE' | 'FEMALE' | null;
    notes?: string | null;
};

// In-memory drafts. If the bot restarts mid-form, the parent sends /post again.
const drafts = new Map<number, Draft>();

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);
const SESSIONS = [2, 3, 4, 5] as const;
const GENDERS = ['ANY', 'MALE', 'FEMALE'] as const;

// Creates or updates the Parent row for this Telegram user and returns its id.
export async function ensureParent(ctx: Context): Promise<{ id: string; contactHandle: string | null }> {
    const username = ctx.from?.username ?? null;
    const telegramId = ctx.from!.id;
    const contact = username ? `@${username}` : null;

    return withTransaction(async (client) => {
        const { rows: inserted } = await client.query<{
            id: string;
            contactHandle: string | null;
            auditRef: string;
        }>(
            `INSERT INTO "Parent" (id, "telegramId", "telegramUsername", "contactHandle")
             VALUES (gen_random_uuid()::text, $1, $2, $3)
             ON CONFLICT ("telegramId") DO NOTHING
             RETURNING id, "contactHandle", "auditRef"`,
            [telegramId, username, contact],
        );

        if (inserted[0]) {
            await recordAuditEvent(client, {
                actorRef: inserted[0].auditRef,
                actorType: 'PARENT',
                action: 'ACCOUNT_CREATED',
                entityType: 'PARENT',
            });
            return { id: inserted[0].id, contactHandle: inserted[0].contactHandle };
        }

        const { rows } = await client.query<{ id: string; contactHandle: string | null }>(
            `SELECT id, "contactHandle" FROM "Parent" WHERE "telegramId" = $1 FOR UPDATE`,
            [telegramId],
        );
        const current = rows[0];
        if (!current) throw new Error('Parent account could not be loaded after insert conflict.');

        if (contact && current.contactHandle !== contact) {
            await client.query(
                `UPDATE "Parent" SET "telegramUsername" = $2, "contactHandle" = $3 WHERE id = $1`,
                [current.id, username, contact],
            );
        }
        return { id: current.id, contactHandle: contact ?? current.contactHandle };
    });
}

export function clearParentDraft(telegramId: number): void {
    drafts.delete(telegramId);
}

async function ask(ctx: Context, d: Draft) {
    switch (d.step) {
        case 'contact':
            return ctx.reply('Send a phone number or Telegram @username so the agency can reach you.');
        case 'grade':
            return ctx.reply('Which grade is the child in?', {
                reply_markup: choices('g', GRADES.map((g) => [g, g]), d.id, 3),
            });
        case 'area':
            return ctx.reply('Which sub-city?', {
                reply_markup: choices('a', KNOWN_SUB_CITIES.map((c) => [c, c]), d.id, 3),
            });
        case 'location':
            return ctx.reply('Optional: type a location detail, such as a nearby landmark. Or tap Skip.', {
                reply_markup: new InlineKeyboard().text('Skip', `pr:skip:${d.id}:location`),
            });
        case 'weak':
            return ctx.reply(
                'Optional: which subjects does the child find difficult? Type them, for example "Math, English". Or tap Skip.',
                { reply_markup: new InlineKeyboard().text('Skip', `pr:skip:${d.id}:weak`) }
            );
        case 'sessions':
            return ctx.reply('How many sessions per week?', {
                reply_markup: choices('n', SESSIONS.map((n) => [String(n), String(n)]), d.id, 4),
            });
        case 'budget':
            return ctx.reply('Monthly budget in ETB? Type a number between 500 and 20000, for example 2500.');
        case 'gender':
            return ctx.reply('Preferred tutor gender?', {
                reply_markup: choices('x', [['Any', 'ANY'], ['Male', 'MALE'], ['Female', 'FEMALE']], d.id, 3),
            });
        case 'notes':
            return ctx.reply('Optional: anything else the agency should know? Type it, or tap Skip.', {
                reply_markup: new InlineKeyboard().text('Skip', `pr:skip:${d.id}:notes`),
            });
        case 'confirm':
            return ctx.reply(`Please check your request:\n\n${summary(d).join('\n')}`, {
                reply_markup: new InlineKeyboard().text('Send request', `pr:post:yes:${d.id}`).text('Cancel', `pr:post:no:${d.id}`),
            });
    }
}

// Buttons send only their index or value, so callback data stays short.
function choices(prefix: string, options: [string, string][], sessionId: string, perRow: number) {
    const kb = new InlineKeyboard();
    options.forEach(([label, value], i) => {
        kb.text(label, `pr:${prefix}:${sessionId}:${value}`);
        if ((i + 1) % perRow === 0) kb.row();
    });
    return kb;
}

function summary(d: Draft): string[] {
    const gender = d.preferredTutorGender === 'MALE' ? 'Male' : d.preferredTutorGender === 'FEMALE' ? 'Female' : 'Any';
    return [
        `Grade: ${d.gradeLevel}`,
        `Area: ${d.subCity}`,
        d.locationDetail ? `Location: ${d.locationDetail}` : null,
        `Weak subjects: ${d.weakSubjects ?? 'Not specified'}`,
        `Sessions: ${d.sessionsPerWeek} per week`,
        `Budget: ${d.budgetEtb?.toLocaleString()} ETB per month`,
        `Tutor gender: ${gender}`,
        d.notes ? `Notes: ${d.notes}` : null,
        '',
        'Your contact is shared only with the agency that pays for your request.',
    ].filter((line): line is string => line !== null);
}

export function registerParentHandlers(bot: Bot) {
    bot.command('post', async (ctx) => {
        const parent = await ensureParent(ctx);
        const d: Draft = {
            id: randomUUID(),
            parentId: parent.id,
            contactHandle: parent.contactHandle,
            step: parent.contactHandle ? 'grade' : 'contact',
        };
        drafts.set(ctx.from!.id, d);
        await ask(ctx, d);
    });

    bot.command('cancel', async (ctx) => {
        if (!drafts.delete(ctx.from!.id)) return ctx.reply('There is no active parent request to cancel.');
        return ctx.reply('Your parent request draft was cancelled. Nothing was submitted.');
    });

    // Single choice buttons: grade, area, sessions, gender.
    bot.callbackQuery(/^pr:(g|a|n|x):([^:]+):(.+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /post to start a new request.');
        }

        const [, field, sessionId, value] = ctx.match as RegExpMatchArray;
        if (sessionId !== d.id) { await ctx.answerCallbackQuery({ text: 'This request form has expired.' }); return; }
        const expectedStep = field === 'g' ? 'grade' : field === 'a' ? 'area' : field === 'n' ? 'sessions' : 'gender';
        if (d.step !== expectedStep) { await ctx.answerCallbackQuery({ text: 'This step has expired.' }); return; }
        if (field === 'g') {
            d.gradeLevel = value;
            d.step = 'area';
        } else if (field === 'a') {
            d.subCity = value;
            d.step = 'location';
        } else if (field === 'n') {
            d.sessionsPerWeek = Number(value);
            d.step = 'budget';
        } else if (field === 'x') {
            d.preferredTutorGender = value === 'ANY' ? null : (value as 'MALE' | 'FEMALE');
            d.step = 'notes';
        }

        await ctx.answerCallbackQuery();
        await ask(ctx, d);
    });

    // Skip buttons for the optional steps.
    bot.callbackQuery(/^pr:skip:([^:]+):(location|weak|notes)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /post to start a new request.');
        }

        const [, sessionId, field] = ctx.match as RegExpMatchArray;
        if (sessionId !== d.id) { await ctx.answerCallbackQuery({ text: 'This request form has expired.' }); return; }
        const expectedStep = field === 'location' ? 'location' : field === 'weak' ? 'weak' : 'notes';
        if (d.step !== expectedStep) { await ctx.answerCallbackQuery({ text: 'This step has expired.' }); return; }
        if (field === 'location') {
            d.locationDetail = null;
            d.step = 'weak';
        } else if (field === 'weak') {
            d.weakSubjects = null;
            d.step = 'sessions';
        } else {
            d.notes = null;
            d.step = 'confirm';
        }

        await ctx.answerCallbackQuery();
        await ask(ctx, d);
    });

    bot.callbackQuery(/^pr:post:yes:([^:]+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /post to start a new request.');
        }

        const sessionId = (ctx.match as RegExpMatchArray)[1];
        if (sessionId !== d.id || d.step !== 'confirm') { await ctx.answerCallbackQuery({ text: 'This confirmation has expired.' }); return; }
        // Remove the draft first, so a second tap cannot send the same request again.
        drafts.delete(ctx.from.id);

        try {
            await withTransaction(async (client) => {
                const { rows: parentRows } = await client.query<{ auditRef: string }>(
                    `SELECT "auditRef" FROM "Parent" WHERE id = $1 FOR UPDATE`,
                    [d.parentId],
                );
                if (!parentRows[0]) throw new Error('Parent account no longer exists.');

                if (d.contactHandle) {
                    await client.query(
                        `UPDATE "Parent" SET "contactHandle" = $2 WHERE id = $1`,
                        [d.parentId, d.contactHandle],
                    );
                }

                const { rows: requests } = await client.query<{ id: string }>(
                    `INSERT INTO "ParentRequest"
                     (id, "parentId", "createdBy", "gradeLevel", "subCity", "locationDetail",
                      "weakSubjects", "sessionsPerWeek", "budgetEtb", "preferredTutorGender", notes, status, "createdAt")
                     VALUES (gen_random_uuid()::text, $1, 'PARENT', $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', now())
                     RETURNING id`,
                    [
                        d.parentId,
                        d.gradeLevel,
                        d.subCity,
                        d.locationDetail ?? null,
                        d.weakSubjects ?? null,
                        d.sessionsPerWeek,
                        d.budgetEtb,
                        d.preferredTutorGender ?? null,
                        d.notes ?? null,
                    ],
                );

                if (requests[0]) {
                    await recordAuditEvent(client, {
                        actorRef: parentRows[0].auditRef,
                        actorType: 'PARENT',
                        action: 'REQUEST_CREATED',
                        entityType: 'PARENT_REQUEST',
                        entityRef: requests[0].id,
                    });
                }
            });
        } catch (err) {
            drafts.set(ctx.from.id, d);
            throw err;
        }

        await ctx.answerCallbackQuery();
        await ctx.reply('Your request has been sent. Agencies will be contacted, and you will hear back if one takes it.');

        if (ADMIN_ID) {
            await bot.api.sendMessage(ADMIN_ID, `New parent request:\n\n${summary(d).join('\n')}`).catch((err) =>
                console.error('Could not notify admin:', err)
            );
        }
    });

    bot.callbackQuery(/^pr:post:no:([^:]+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        const sessionId = (ctx.match as RegExpMatchArray)[1];
        if (!d || sessionId !== d.id || d.step !== 'confirm') { await ctx.answerCallbackQuery({ text: 'This confirmation has expired.' }); return; }
        drafts.delete(ctx.from.id);
        await ctx.answerCallbackQuery();
        await ctx.reply('Cancelled.');
    });

    // Typed answers. Any command ends the request in progress.
    bot.on('message:text', async (ctx, next) => {
        const d = drafts.get(ctx.from.id);
        if (!d) return next();

        const text = ctx.message.text.trim();
        if (text.startsWith('/')) {
            drafts.delete(ctx.from.id);
            return next();
        }

        if (d.step === 'contact') {
            d.contactHandle = text.slice(0, 100);
            d.step = 'grade';
            return ask(ctx, d);
        }

        if (d.step === 'location') {
            d.locationDetail = text.slice(0, 200) || null;
            d.step = 'weak';
            return ask(ctx, d);
        }

        if (d.step === 'weak') {
            d.weakSubjects = text.slice(0, 300) || null;
            d.step = 'sessions';
            return ask(ctx, d);
        }

        if (d.step === 'budget') {
            const budget = Number(text.replace(/[,\s]/g, ''));
            if (!Number.isInteger(budget) || budget < 500 || budget > 20000) {
                return ctx.reply('Please type a whole number between 500 and 20000.');
            }
            d.budgetEtb = budget;
            d.step = 'gender';
            return ask(ctx, d);
        }

        if (d.step === 'notes') {
            d.notes = text.slice(0, 500) || null;
            d.step = 'confirm';
            return ask(ctx, d);
        }

        return next();
    });
}