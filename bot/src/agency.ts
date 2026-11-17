// src/agency.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { GRADES } from './curriculum.js';
import {
    DEFAULT_OFFER_TEMPLATE,
    OFFER_PLACEHOLDERS,
    offerCardText,
    validateOfferTemplate,
    type CardOffer,
} from './card.js';

type Unit = 'MONTH' | 'HOUR';
type Gender = 'MALE' | 'FEMALE' | null;

type Draft = {
    orgId: string;
    orgName: string;
    orgUsername: string;
    postTemplate: string | null;
    step:
    | 'subject'
    | 'grades'
    | 'area'
    | 'location'
    | 'sessions'
    | 'unit'
    | 'amount'
    | 'hours'
    | 'gender'
    | 'requirements'
    | 'confirm';
    subject?: string;
    grades: string[];
    subCity?: string;
    locationDetail?: string | null;
    sessionsPerWeek?: number;
    unit?: Unit;
    amount?: number;
    sessionHours?: number;
    gender?: Gender;
    requirements?: string | null;
};

const WEEKS_PER_MONTH = 4.33;

// In-memory drafts. If the bot restarts mid-form, the agency sends /new again.
const drafts = new Map<number, Draft>();
const templateDrafts = new Map<number, string>();

async function findAgency(username: string | undefined) {
    if (!username) return null;
    const { rows } = await pool.query(
        `SELECT id, name, "telegramUsername", "postTemplate"
     FROM "Organization"
     WHERE lower("telegramUsername") = lower($1)
       AND status = 'ACTIVE'`,
        [username]
    );
    return rows[0] ?? null;
}

// Rounds a number to the nearest step, for example nearest 50 or nearest 5.
function roundTo(value: number, step: number): number {
    return Math.round(value / step) * step;
}

// Monthly estimate for an hourly rate, rounded to the nearest 50.
export function monthlyOf(d: Draft): number {
    if (d.unit === 'HOUR') {
        const raw = (d.amount ?? 0) * (d.sessionHours ?? 0) * (d.sessionsPerWeek ?? 0) * WEEKS_PER_MONTH;
        return roundTo(raw, 50);
    }
    return d.amount ?? 0;
}

// Hourly estimate for a monthly salary, rounded to the nearest 5.
export function hourlyOf(d: Draft): number {
    if (d.unit === 'MONTH') {
        const hoursPerMonth = (d.sessionHours ?? 0) * (d.sessionsPerWeek ?? 0) * WEEKS_PER_MONTH;
        return hoursPerMonth > 0 ? roundTo((d.amount ?? 0) / hoursPerMonth, 5) : 0;
    }
    return d.amount ?? 0;
}

// Shows "All Grades" when every grade is picked, the list otherwise, and emptyLabel when none.
function listLabel(items: string[], all: readonly string[], allLabel: string, emptyLabel: string): string {
    if (items.length === 0) return emptyLabel;
    if (all.every((x) => items.includes(x))) return allLabel;
    return items.join(', ');
}

function multiKeyboard(kind: string, options: readonly string[], selected: string[]) {
    const kb = new InlineKeyboard();
    options.forEach((v, i) => {
        kb.text(`${selected.includes(v) ? '✅ ' : ''}${v}`, `ag:${kind}:${v}`);
        if (i % 2 === 1) kb.row();
    });
    kb.row().text('All', `ag:${kind}:ALL`).text('Clear', `ag:${kind}:CLEAR`);
    kb.row().text('Done', `ag:${kind}:DONE`);
    return kb;
}

function choices(prefix: string, options: [string, string][], perRow = 2) {
    const kb = new InlineKeyboard();
    options.forEach(([label, value], i) => {
        kb.text(label, `ag:${prefix}:${value}`);
        if ((i + 1) % perRow === 0) kb.row();
    });
    return kb;
}

function salaryLine(d: Draft): string {
    if (d.unit === 'HOUR') {
        return `${d.amount} ETB per hour (about ${monthlyOf(d).toLocaleString()} ETB per month)`;
    }
    return `${d.amount?.toLocaleString()} ETB per month (about ${hourlyOf(d).toLocaleString()} ETB per hour)`;
}

// The offer as tutors will read it. Each detail is on its own line.
function offerLines(d: Draft): string[] {
    const offer: CardOffer = {
        title: `Tutor (${listLabel(d.grades, GRADES, 'All Grades', 'Not specified')})`,
        subject: d.subject ?? null,
        gradeLevels: d.grades,
        subCity: d.subCity ?? '',
        locationDetail: d.locationDetail ?? null,
        sessionsPerWeek: d.sessionsPerWeek ?? 0,
        sessionHours: d.sessionHours ?? null,
        salaryUnit: d.unit ?? 'MONTH',
        salaryAmountEtb: d.amount ?? 0,
        monthlySalaryEtb: monthlyOf(d),
        preferredTutorGender: d.gender ?? null,
        requirements: d.requirements ?? null,
        postTemplate: d.postTemplate,
        agencyUsername: d.orgUsername,
        agencyName: d.orgName,
    };

    return offerCardText(offer, 'OPEN').split('\n');
}

async function ask(ctx: Context, d: Draft) {
    switch (d.step) {
        case 'subject':
            return ctx.reply(
                'Which subject is this offer for? For example: Mathematics, Physics, English.'
            );
        case 'grades':
            return ctx.reply('Which grades? Pick one or more, or tap All.', {
                reply_markup: multiKeyboard('grd', GRADES, d.grades),
            });
        case 'area':
            return ctx.reply('Which sub-city?', {
                reply_markup: choices('area', KNOWN_SUB_CITIES.map((c) => [c, c] as [string, string]), 3),
            });
        case 'location':
            return ctx.reply('Optional: type a location detail, such as a nearby landmark. Or tap Skip.', {
                reply_markup: new InlineKeyboard().text('Skip', 'ag:skip:location'),
            });
        case 'sessions':
            return ctx.reply('Sessions per week?', {
                reply_markup: choices('sess', [['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']], 4),
            });
        case 'unit':
            return ctx.reply('How is the pay set?', {
                reply_markup: choices('unit', [['Monthly', 'MONTH'], ['Hourly', 'HOUR']], 2),
            });
        case 'amount':
            return ctx.reply(
                d.unit === 'HOUR'
                    ? 'Hourly rate in ETB? Type a number, for example 300.'
                    : 'Monthly salary in ETB? Type a number, for example 2500.'
            );
        case 'hours':
            return ctx.reply('How many hours is one session? Type a number, for example 2.');
        case 'gender':
            return ctx.reply('Preferred tutor gender?', {
                reply_markup: choices('gen', [['Any', 'ANY'], ['Male', 'MALE'], ['Female', 'FEMALE']], 3),
            });
        case 'requirements':
            return ctx.reply(
                'Optional: preferred subject proficiency for the tutor, for example "Math strong, English basic". Or tap Skip.',
                { reply_markup: new InlineKeyboard().text('Skip', 'ag:skip:requirements') }
            );
        case 'confirm':
            return ctx.reply(`Please check the offer:\n\n${offerLines(d).join('\n')}`, {
                reply_markup: new InlineKeyboard().text('Post offer', 'ag:post:yes').text('Cancel', 'ag:post:no'),
            });
    }
}

export function registerAgencyHandlers(bot: Bot) {
    bot.command('template', async (ctx) => {
        const agency = await findAgency(ctx.from?.username);

        if (!agency) {
            return ctx.reply('This account is not registered as an active agency.');
        }

        templateDrafts.set(ctx.from!.id, agency.id);

        await ctx.reply(
            'Your current offer template:\n\n' +
            (agency.postTemplate || DEFAULT_OFFER_TEMPLATE)
        );

        return ctx.reply(
            'Now send your complete replacement template in one message. ' +
            'You can arrange the text, emojis and placeholders however you want.\n\n' +
            'Send /cancel to cancel.\n\n' +
            'Available placeholders:\n' +
            Object.entries(OFFER_PLACEHOLDERS)
                .map(([key, description]) => `{${key}} - ${description}`)
                .join('\n')
        );
    });

    bot.command('new', async (ctx) => {
        const agency = await findAgency(ctx.from?.username);
        if (!agency) {
            return ctx.reply('This account is not registered as an agency.');
        }

        const draft: Draft = {
            orgId: agency.id,
            orgName: agency.name,
            orgUsername: agency.telegramUsername,
            postTemplate: agency.postTemplate ?? null,
            step: 'subject',
            grades: [],
        };
        drafts.set(ctx.from!.id, draft);
        await ask(ctx, draft);
    });

    // Grade multi-select.
    bot.callbackQuery(/^ag:grd:(.+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const [, value] = ctx.match as RegExpMatchArray;

        if (value === 'DONE') {
            if (d.grades.length === 0) {
                return ctx.answerCallbackQuery({ text: 'Pick at least one grade.' });
            }
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(`Grades: ${listLabel(d.grades, GRADES, 'All Grades', 'Not specified')}`);
            d.step = 'area';
            return ask(ctx, d);
        }

        let next: string[];
        if (value === 'ALL') next = [...GRADES];
        else if (value === 'CLEAR') next = [];
        else next = d.grades.includes(value) ? d.grades.filter((v) => v !== value) : [...d.grades, value];

        d.grades = next;

        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: multiKeyboard('grd', GRADES, next) });
    });

    // Single-choice buttons.
    bot.callbackQuery(/^ag:(area|sess|unit|gen):(.+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const [, field, value] = ctx.match as RegExpMatchArray;

        if (field === 'area') {
            d.subCity = value;
            d.step = 'location';
        } else if (field === 'sess') {
            d.sessionsPerWeek = Number(value);
            d.step = 'unit';
        } else if (field === 'unit') {
            d.unit = value as Unit;
            d.step = 'amount';
        } else if (field === 'gen') {
            d.gender = value === 'ANY' ? null : (value as 'MALE' | 'FEMALE');
            d.step = 'requirements';
        }

        await ctx.answerCallbackQuery();
        await ask(ctx, d);
    });

    // Skip buttons for the optional steps.
    bot.callbackQuery(/^ag:skip:(location|requirements)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const [, field] = ctx.match as RegExpMatchArray;
        if (field === 'location') {
            d.locationDetail = null;
            d.step = 'sessions';
        } else {
            d.requirements = null;
            d.step = 'confirm';
        }

        await ctx.answerCallbackQuery();
        await ask(ctx, d);
    });

    bot.callbackQuery('ag:post:yes', async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        // Remove the draft before saving, so a second tap cannot post the same offer again.
        drafts.delete(ctx.from.id);

        const gradesText = listLabel(d.grades, GRADES, 'All Grades', 'Any grade');
        const title = `Tutor (${gradesText})`;

        try {
            await pool.query(
                `INSERT INTO "TutoringOffer"
     ("organizationId", "title", "subject", "gradeLevel", "gradeLevels",
      "subCity", "locationDetail", "monthlySalaryEtb", "salaryUnit",
      "salaryAmountEtb", "sessionHours", "sessionsPerWeek",
      "preferredTutorGender", "requirements", "status")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'OPEN')`,
                [
                    d.orgId,
                    title,
                    d.subject,
                    d.grades[0] ?? 'Not specified',
                    d.grades,
                    d.subCity,
                    d.locationDetail ?? null,
                    monthlyOf(d),
                    d.unit,
                    d.amount,
                    d.sessionHours,
                    d.sessionsPerWeek,
                    d.gender ?? null,
                    d.requirements ?? null,
                ]
            );
        } catch (err) {
            // Save failed, so put the draft back and let the agency try again.
            drafts.set(ctx.from.id, d);
            throw err;
        }

        await ctx.answerCallbackQuery();
        await ctx.reply(
            'Offer saved. Within a few minutes you will get a report here: where it was posted, ' +
            'and how many tutors have received it so far.'
        );
    });

    bot.callbackQuery('ag:post:no', async (ctx) => {
        drafts.delete(ctx.from.id);
        await ctx.answerCallbackQuery();
        await ctx.reply('Cancelled.');
    });

    // Typed answers: optional location, pay amount, session hours, requirements.
    bot.on('message:text', async (ctx, next) => {
        const d = drafts.get(ctx.from.id);
        if (!d) return next();

        const text = ctx.message.text.trim();

        // Save a complete custom offer template.
        if (templateDrafts.has(ctx.from.id)) {
            if (text === '/cancel') {
                templateDrafts.delete(ctx.from.id);
                return ctx.reply('Template editing cancelled. Your previous template is unchanged.');
            }

            if (text.startsWith('/')) return next();

            if (text.length > 3500) {
                return ctx.reply('Please keep your template under 3,500 characters.');
            }

            const unknown = validateOfferTemplate(text);

            if (unknown.length > 0) {
                return ctx.reply(
                    `Unknown placeholder(s): ${unknown.map((x) => `{${x}}`).join(', ')}\n\n` +
                    'Use only the placeholders listed when you started /template.'
                );
            }

            if (!/\{[^{}]+\}/.test(text)) {
                return ctx.reply(
                    'Your template must contain at least one supported placeholder, such as {SUBJECT} or {GRADES}.'
                );
            }

            const orgId = templateDrafts.get(ctx.from.id)!;

            await pool.query(
                `UPDATE "Organization"
         SET "postTemplate" = $2
         WHERE id = $1 AND "telegramUserId" = $3`,
                [orgId, text, ctx.from.id]
            );

            templateDrafts.delete(ctx.from.id);

            return ctx.reply(
                'Your offer template has been saved. Your next offers will use this layout.\n\n' +
                'You can change it any time with /template.'
            );
        }

        // A command ends the offer in progress.
        if (text.startsWith('/')) {
            drafts.delete(ctx.from.id);
            return next();
        }

        if (d.step === 'subject') {
            if (text.length < 2 || text.length > 120) {
                return ctx.reply('Please enter a subject between 2 and 120 characters.');
            }

            d.subject = text;
            d.step = 'grades';
            return ask(ctx, d);
        }

        if (d.step === 'location') {
            d.locationDetail = text.slice(0, 200) || null;
            d.step = 'sessions';
            return ask(ctx, d);
        }

        if (d.step === 'amount') {
            const amount = Number(text.replace(/[,\s]/g, ''));
            const [min, max] = d.unit === 'HOUR' ? [50, 5000] : [500, 20000];
            if (!Number.isInteger(amount) || amount < min || amount > max) {
                return ctx.reply(`Please type a whole number between ${min} and ${max}.`);
            }
            d.amount = amount;
            d.step = 'hours';
            return ask(ctx, d);
        }

        if (d.step === 'hours') {
            const hours = Number(text);
            if (!Number.isInteger(hours) || hours < 1 || hours > 8) {
                return ctx.reply('Please type a whole number of hours between 1 and 8.');
            }
            d.sessionHours = hours;
            d.step = 'gender';
            return ask(ctx, d);
        }

        if (d.step === 'requirements') {
            d.requirements = text.slice(0, 500) || null;
            d.step = 'confirm';
            return ask(ctx, d);
        }

        return next();
    });
}