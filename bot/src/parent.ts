// src/parent.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { recordAuditEvent, withTransaction } from './audit.js';
import { KNOWN_SUB_CITIES, normalizeSubCity } from '../../shared/rules/nearby-areas.js';
import { GRADES } from './curriculum.js';
import { describeAvailable, extractParentFields, type ParentFields } from './parent-describe.js';

type Step =
    | 'contact' | 'grade' | 'area' | 'location' | 'weak'
    | 'sessions' | 'budget' | 'gender' | 'notes' | 'confirm';

type Draft = {
    id: string;
    parentId: string;
    contactHandle: string | null;
    step: Step;
    // One entry per child. Each grade becomes its own request with the same details.
    gradeLevels: string[];
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
// Parents who sent /describe and will type their request next.
const describing = new Set<number>();

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);
const SESSIONS = [2, 3, 4, 5] as const;
const GENDERS = ['ANY', 'MALE', 'FEMALE'] as const;

// Creates or updates the Parent row for this Telegram user and returns its id.
// Fills a parent request from the parent's description. Answers at once; the AI runs in the background.
async function describeRequest(ctx: Context, text: string) {
    await ctx.reply('Reading your request. This can take up to half a minute.');
    void fillFromDescription(ctx, text).catch(async (err) => {
        console.error('Parent describe failed:', err);
        await ctx.reply('Something went wrong while reading your request. Please send /post to fill the form.').catch(() => undefined);
    });
}

// Sefer names are compared without the Amharic part, the word "sefer" and punctuation: "Wessen sefer" matches "Wessen (ወሰን)".
function seferKey(name: string): string {
    return name
        .toLowerCase()
        .replace(/\(.*?\)/g, ' ')
        .replace(/\bsefers?\b/g, ' ')
        .replace(/[^a-z0-9ሀ-፿ ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Returns the sub-city of an approved sefer with this name, or null when no approved sefer matches.
async function subCityForSefer(typed: string): Promise<string | null> {
    const key = seferKey(typed);
    if (!key) return null;
    const { rows } = await pool.query<{ name: string; subCity: string }>(
        `SELECT name, "subCity" FROM "Sefer" WHERE status = 'APPROVED' AND "subCity" IS NOT NULL`,
    );
    const hit = rows.find((r) => seferKey(r.name) === key);
    return hit ? normalizeSubCity(hit.subCity) : null;
}

async function fillFromDescription(ctx: Context, text: string) {
    const parent = await ensureParent(ctx);
    const fields: ParentFields | null = await extractParentFields(text, `parent:${parent.id}`);
    if (!fields) {
        return ctx.reply('I could not read that request. Please send /post to fill the form step by step.');
    }

    // The sefer decides the sub-city. The sub-city the parent named is only used when the sefer is unknown.
    const subCity = (fields.sefer ? await subCityForSefer(fields.sefer) : null) ?? fields.subCity;

    // First required step still missing, in the order the form asks.
    const missing: Step | null =
        !parent.contactHandle ? 'contact'
        : fields.gradeLevels.length === 0 ? 'grade'
        : !subCity ? 'area'
        : !fields.sessionsPerWeek ? 'sessions'
        : !fields.budgetEtb ? 'budget'
        : null;

    const d: Draft = {
        id: randomUUID(),
        parentId: parent.id,
        contactHandle: parent.contactHandle,
        step: missing ?? 'confirm',
        gradeLevels: fields.gradeLevels,
        subCity: subCity ?? undefined,
        locationDetail: fields.locationDetail,
        weakSubjects: fields.weakSubjects,
        sessionsPerWeek: fields.sessionsPerWeek ?? undefined,
        budgetEtb: fields.budgetEtb ?? undefined,
        preferredTutorGender: fields.preferredTutorGender,
        notes: fields.notes,
    };
    drafts.set(ctx.from!.id, d);

    await ctx.reply(
        missing
            ? 'I filled in what I could from your description. I still need a few details.'
            : 'I filled in your request from your description. Please check it before it is sent.'
    );
    await ask(ctx, d);
}

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
                'Which subject(s) does the child need help with? Type them, for example "Mathematics, English". Or tap Skip.',
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
    const children = d.gradeLevels.length;
    return [
        children > 1 ? `Children: ${children}, one request for each` : null,
        `${children > 1 ? 'Grades' : 'Grade'}: ${d.gradeLevels.join(', ')}`,
        `Area: ${d.subCity}`,
        d.locationDetail ? `Location: ${d.locationDetail}` : null,
        `Subjects needed: ${d.weakSubjects ?? 'Not specified'}`,
        `Sessions: ${d.sessionsPerWeek} per week`,
        `Budget: ${d.budgetEtb?.toLocaleString()} ETB per month${children > 1 ? ' for each child' : ''}`,
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
            gradeLevels: [],
        };
        drafts.set(ctx.from!.id, d);
        await ask(ctx, d);
    });

    // Plain-language request: the parent describes what they need, the AI fills the form, the parent confirms.
    bot.command('describe', async (ctx) => {
        if (!describeAvailable()) return ctx.reply('Describing a request is not switched on yet. Send /post to fill the form.');
        await ensureParent(ctx);
        describing.add(ctx.from!.id);
        return ctx.reply(
            'Describe the tutor you need in your own words. Include each child\'s grade, the subject, your sefer or sub-city, ' +
            'how many sessions a week, the session length, the budget per child, and any language or gender needs. ' +
            'I will fill the form and you confirm it before it is sent.'
        );
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
            d.gradeLevels = [value];
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

                // One request per child, each with the same subjects, sessions, budget per child and notes.
                for (const gradeLevel of d.gradeLevels) {
                    const { rows: requests } = await client.query<{ id: string }>(
                        `INSERT INTO "ParentRequest"
                         (id, "parentId", "createdBy", "gradeLevel", "subCity", "locationDetail",
                          "weakSubjects", "sessionsPerWeek", "budgetEtb", "preferredTutorGender", notes, status, "createdAt")
                         VALUES (gen_random_uuid()::text, $1, 'PARENT', $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', now())
                         RETURNING id`,
                        [
                            d.parentId,
                            gradeLevel,
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
        if (describing.has(ctx.from.id) && !ctx.message.text.startsWith('/')) {
            describing.delete(ctx.from.id);
            return describeRequest(ctx, ctx.message.text.trim());
        }
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