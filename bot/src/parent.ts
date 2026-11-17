// src/parent.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { SUBJECTS, GRADES } from './curriculum.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);

type Step = 'contact' | 'subject' | 'grade' | 'area' | 'location' | 'sessions' | 'budget' | 'gender' | 'notes' | 'confirm';

type Draft = {
    parentId: string;
    contactHandle: string | null;
    step: Step;
    subject?: string;
    gradeLevel?: string;
    subCity?: string;
    locationDetail?: string | null;
    sessionsPerWeek?: number;
    budgetEtb?: number;
    preferredTutorGender?: 'MALE' | 'FEMALE' | null;
    notes?: string | null;
};

// Each choice button sends its position in one of these lists, so callback data stays short.
const CHOICES: Record<string, string[]> = {
    s: [...SUBJECTS],
    g: [...GRADES],
    a: [...KNOWN_SUB_CITIES],
    n: ['2', '3', '4', '5'],
    x: ['ANY', 'MALE', 'FEMALE'],
};
const GENDER_LABEL: Record<string, string> = { ANY: 'Any', MALE: 'Male', FEMALE: 'Female' };

// Parent requests waiting to be confirmed, keyed by Telegram user ID. Lost on restart, so they send /post again.
const drafts = new Map<number, Draft>();

// Creates the parent on first use. Updates the username on later visits.
async function ensureParent(ctx: Context): Promise<{ id: string; contactHandle: string | null }> {
    const { rows } = await pool.query(
        `INSERT INTO "Parent" ("telegramId", "telegramUsername", "contactHandle")
         VALUES ($1, $2, $3)
         ON CONFLICT ("telegramId") DO UPDATE SET "telegramUsername" = EXCLUDED."telegramUsername"
         RETURNING id, "contactHandle"`,
        [ctx.from!.id, ctx.from!.username ?? null, ctx.from!.username ? `@${ctx.from!.username}` : null]
    );
    return rows[0];
}

function choiceKeyboard(kind: string, perRow = 2) {
    const kb = new InlineKeyboard();
    CHOICES[kind].forEach((value, i) => {
        const label = kind === 'x' ? GENDER_LABEL[value] : value;
        kb.text(label, `pr:${kind}:${i}`);
        if ((i + 1) % perRow === 0) kb.row();
    });
    return kb;
}

function summary(d: Draft): string {
    const lines = [
        'Please check your request:',
        '',
        `Subject: ${d.subject}`,
        `Grade: ${d.gradeLevel}`,
        `Area: ${d.subCity}`,
    ];
    if (d.locationDetail) lines.push(`Location: ${d.locationDetail}`);
    lines.push(
        `Sessions: ${d.sessionsPerWeek} per week`,
        `Budget: ${d.budgetEtb?.toLocaleString()} ETB per month`,
        `Tutor gender: ${d.preferredTutorGender ? GENDER_LABEL[d.preferredTutorGender] : 'Any'}`
    );
    if (d.notes) lines.push(`Notes: ${d.notes}`);
    lines.push('', 'Your contact is shared only with the agency that pays. Agencies do not see it before payment.');
    return lines.join('\n');
}

async function ask(ctx: Context, d: Draft) {
    switch (d.step) {
        case 'contact':
            return ctx.reply('Please type your phone number or a name, so an agency can reach you. Only the agency that pays will see it.');
        case 'subject':
            return ctx.reply('Which subject?', { reply_markup: choiceKeyboard('s') });
        case 'grade':
            return ctx.reply('Which grade?', { reply_markup: choiceKeyboard('g', 3) });
        case 'area':
            return ctx.reply('Which sub-city?', { reply_markup: choiceKeyboard('a', 3) });
        case 'location':
            return ctx.reply('Optional: a nearby landmark or school. Type it, or tap Skip.', {
                reply_markup: new InlineKeyboard().text('Skip', 'pr:skip:location'),
            });
        case 'sessions':
            return ctx.reply('How many sessions per week?', { reply_markup: choiceKeyboard('n', 4) });
        case 'budget':
            return ctx.reply('Monthly budget in ETB? Type a number, for example 2500.');
        case 'gender':
            return ctx.reply('Preferred tutor gender?', { reply_markup: choiceKeyboard('x', 3) });
        case 'notes':
            return ctx.reply('Optional: anything else the tutor should know. Type it, or tap Skip.', {
                reply_markup: new InlineKeyboard().text('Skip', 'pr:skip:notes'),
            });
        case 'confirm':
            return ctx.reply(summary(d), {
                reply_markup: new InlineKeyboard().text('Send request', 'pr:post:yes').text('Cancel', 'pr:post:no'),
            });
    }
}

export function registerParentHandlers(bot: Bot) {
    bot.command('post', async (ctx) => {
        const parent = await ensureParent(ctx);
        const d: Draft = {
            parentId: parent.id,
            contactHandle: parent.contactHandle,
            step: parent.contactHandle ? 'subject' : 'contact',
        };
        drafts.set(ctx.from!.id, d);
        await ctx.reply('Let us post your tutoring request.');
        return ask(ctx, d);
    });

    // Choice buttons: subject, grade, area, sessions, gender.
    bot.callbackQuery(/^pr:(s|g|a|n|x):(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const d = drafts.get(ctx.from.id);
        if (!d) return ctx.reply('Send /post to start a new request.');

        const [, kind, idx] = ctx.match as RegExpMatchArray;
        const value = CHOICES[kind][Number(idx)];
        if (value === undefined) return;

        if (kind === 's') { d.subject = value; d.step = 'grade'; }
        else if (kind === 'g') { d.gradeLevel = value; d.step = 'area'; }
        else if (kind === 'a') { d.subCity = value; d.step = 'location'; }
        else if (kind === 'n') { d.sessionsPerWeek = Number(value); d.step = 'budget'; }
        else { d.preferredTutorGender = value === 'ANY' ? null : (value as 'MALE' | 'FEMALE'); d.step = 'notes'; }

        return ask(ctx, d);
    });

    // Skip buttons for the optional steps.
    bot.callbackQuery(/^pr:skip:(location|notes)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const d = drafts.get(ctx.from.id);
        if (!d) return ctx.reply('Send /post to start a new request.');

        const [, field] = ctx.match as RegExpMatchArray;
        if (field === 'location') { d.locationDetail = null; d.step = 'sessions'; }
        else { d.notes = null; d.step = 'confirm'; }

        return ask(ctx, d);
    });

    bot.callbackQuery('pr:post:yes', async (ctx) => {
        await ctx.answerCallbackQuery();
        const d = drafts.get(ctx.from.id);
        if (!d) return ctx.reply('Send /post to start a new request.');

        // Remove the draft first, so a double tap cannot create two requests.
        drafts.delete(ctx.from.id);
        try {
            await pool.query(`UPDATE "Parent" SET "contactHandle" = $2 WHERE id = $1`, [d.parentId, d.contactHandle]);
            await pool.query(
                `INSERT INTO "ParentRequest"
                 ("parentId", "createdBy", subject, "gradeLevel", "subCity", "locationDetail",
                  "sessionsPerWeek", "budgetEtb", "preferredTutorGender", notes)
                 VALUES ($1, 'PARENT', $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    d.parentId, d.subject, d.gradeLevel, d.subCity, d.locationDetail ?? null,
                    d.sessionsPerWeek, d.budgetEtb, d.preferredTutorGender ?? null, d.notes ?? null,
                ]
            );
        } catch (err) {
            drafts.set(ctx.from.id, d); // put the draft back so the parent can try again
            throw err;
        }

        if (ADMIN_TELEGRAM_ID) {
            try {
                await ctx.api.sendMessage(ADMIN_TELEGRAM_ID, `New parent request: ${d.subject}, ${d.gradeLevel}, ${d.subCity}, ${d.budgetEtb} ETB per month.`);
            } catch (err) {
                console.error('Could not tell the admin about the parent request:', err);
            }
        }

        return ctx.reply('Thank you. Your request was received. We will message you when a tutoring agency is found.');
    });

    bot.callbackQuery('pr:post:no', async (ctx) => {
        drafts.delete(ctx.from.id);
        await ctx.answerCallbackQuery();
        return ctx.reply('Cancelled.');
    });

    // Typed answers: contact, location, budget, notes.
    bot.on('message:text', async (ctx, next) => {
        const d = drafts.get(ctx.from.id);
        if (!d) return next();

        const text = ctx.message.text.trim();

        // Any command cancels the request in progress.
        if (text.startsWith('/')) {
            drafts.delete(ctx.from.id);
            return next();
        }

        if (d.step === 'contact') {
            if (text.length < 3 || text.length > 100) {
                return ctx.reply('Please type a phone number or a name, between 3 and 100 characters.');
            }
            d.contactHandle = text;
            d.step = 'subject';
            return ask(ctx, d);
        }

        if (d.step === 'location') {
            d.locationDetail = text.slice(0, 200) || null;
            d.step = 'sessions';
            return ask(ctx, d);
        }

        if (d.step === 'budget') {
            const amount = Number(text.replace(/[,\s]/g, ''));
            if (!Number.isInteger(amount) || amount < 500 || amount > 20000) {
                return ctx.reply('Please type a whole number between 500 and 20000.');
            }
            d.budgetEtb = amount;
            d.step = 'gender';
            return ask(ctx, d);
        }

        if (d.step === 'notes') {
            d.notes = text.slice(0, 500) || null;
            d.step = 'confirm';
            return ask(ctx, d);
        }

        return ctx.reply('Please use the buttons above, or send /post to start again.');
    });
}