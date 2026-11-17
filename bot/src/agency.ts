// src/agency.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
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
    id: string;
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
const lastAgencyGradeTap = new Map<number, { key: string; at: number }>();

export function clearAgencySession(telegramId: number) {
    drafts.delete(telegramId);
    templateDrafts.delete(telegramId);
    lastAgencyGradeTap.delete(telegramId);
}

async function findAgency(telegramId: number, username: string | undefined) {
    const { rows } = await pool.query(
        `SELECT id, name, "telegramUsername", "postTemplate"
     FROM "Organization"
     WHERE status = 'ACTIVE'
       AND ("telegramUserId" = $1 OR lower("telegramUsername") = lower($2))
     ORDER BY CASE WHEN "telegramUserId" = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
        [telegramId, username]
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

function multiKeyboard(kind: string, options: readonly string[], selected: string[], sessionId: string) {
    const kb = new InlineKeyboard();
    options.forEach((v, i) => {
        kb.text(`${selected.includes(v) ? '✅ ' : ''}${v}`, `ag:${kind}:${sessionId}:${v}`);
        if (i % 2 === 1) kb.row();
    });
    kb.row().text('All', `ag:${kind}:${sessionId}:ALL`).text('Clear', `ag:${kind}:${sessionId}:CLEAR`);
    kb.row().text('Done', `ag:${kind}:${sessionId}:DONE`);
    return kb;
}

function choices(prefix: string, options: [string, string][], sessionId: string, perRow = 2) {
    const kb = new InlineKeyboard();
    options.forEach(([label, value], i) => {
        kb.text(label, `ag:${prefix}:${sessionId}:${value}`);
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
                reply_markup: multiKeyboard('grd', GRADES, d.grades, d.id),
            });
        case 'area':
            return ctx.reply('Which sub-city?', {
                reply_markup: choices('area', KNOWN_SUB_CITIES.map((c) => [c, c] as [string, string]), d.id, 3),
            });
        case 'location':
            return ctx.reply('Optional: type a location detail, such as a nearby landmark. Or tap Skip.', {
                reply_markup: new InlineKeyboard().text('Skip', `ag:skip:${d.id}:location`),
            });
        case 'sessions':
            return ctx.reply('Sessions per week?', {
                reply_markup: choices('sess', [['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']], d.id, 4),
            });
        case 'unit':
            return ctx.reply('How is the pay set?', {
                reply_markup: choices('unit', [['Monthly', 'MONTH'], ['Hourly', 'HOUR']], d.id, 2),
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
                reply_markup: choices('gen', [['Any', 'ANY'], ['Male', 'MALE'], ['Female', 'FEMALE']], d.id, 3),
            });
        case 'requirements':
            return ctx.reply(
                'Optional: preferred subject proficiency for the tutor, for example "Math strong, English basic". Or tap Skip.',
                { reply_markup: new InlineKeyboard().text('Skip', `ag:skip:${d.id}:requirements`) }
            );
        case 'confirm':
            return ctx.reply(`Please check the offer:\n\n${offerLines(d).join('\n')}`, {
                reply_markup: new InlineKeyboard().text('Post offer', `ag:post:yes:${d.id}`).text('Cancel', `ag:post:no:${d.id}`),
            });
    }
}

export function registerAgencyHandlers(bot: Bot) {
    bot.command('template', async (ctx) => {
        const agency = await findAgency(ctx.from!.id, ctx.from?.username);

        if (!agency) {
            return ctx.reply('This account is not registered as an active agency.');
        }

        drafts.delete(ctx.from!.id);
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

    bot.command('cancel', async (ctx, next) => {
        const hadOffer = drafts.delete(ctx.from!.id);
        const hadTemplate = templateDrafts.delete(ctx.from!.id);
        if (!hadOffer && !hadTemplate) return next();
        return ctx.reply('Cancelled. No changes were saved.');
    });

    bot.command('new', async (ctx) => {
        const agency = await findAgency(ctx.from!.id, ctx.from?.username);
        if (!agency) {
            return ctx.reply('This account is not registered as an agency.');
        }

        templateDrafts.delete(ctx.from!.id);
        const draft: Draft = {
            id: randomUUID(),
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
    bot.callbackQuery(/^ag:grd:([^:]+):(.+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const [, sessionId, value] = ctx.match as RegExpMatchArray;
        const previousTap = lastAgencyGradeTap.get(ctx.from.id);
        const now = Date.now();
        if (previousTap?.key === `${sessionId}:${value}` && now - previousTap.at < 700) {
            await ctx.answerCallbackQuery({ text: 'Already processing that tap.' });
            return;
        }
        lastAgencyGradeTap.set(ctx.from.id, { key: `${sessionId}:${value}`, at: now });
        if (sessionId !== d.id) { await ctx.answerCallbackQuery({ text: 'This form has expired.' }); return; }
        if (d.step !== 'grades') { await ctx.answerCallbackQuery({ text: 'This step has expired.' }); return; }
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
        await ctx.editMessageReplyMarkup({ reply_markup: multiKeyboard('grd', GRADES, next, d.id) });
    });

    // Single-choice buttons.
    bot.callbackQuery(/^ag:(area|sess|unit|gen):([^:]+):(.+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const [, field, sessionId, value] = ctx.match as RegExpMatchArray;
        if (sessionId !== d.id) { await ctx.answerCallbackQuery({ text: 'This form has expired.' }); return; }
        const expectedStep = field === 'area' ? 'area' : field === 'sess' ? 'sessions' : field === 'unit' ? 'unit' : 'gender';
        if (d.step !== expectedStep) { await ctx.answerCallbackQuery({ text: 'This step has expired.' }); return; }

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
    bot.callbackQuery(/^ag:skip:([^:]+):(location|requirements)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const [, sessionId, field] = ctx.match as RegExpMatchArray;
        if (sessionId !== d.id) { await ctx.answerCallbackQuery({ text: 'This form has expired.' }); return; }
        const expectedStep = field === 'location' ? 'location' : 'requirements';
        if (d.step !== expectedStep) { await ctx.answerCallbackQuery({ text: 'This step has expired.' }); return; }
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

    bot.callbackQuery(/^ag:post:yes:([^:]+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const sessionId = (ctx.match as RegExpMatchArray)[1];
        if (sessionId !== d.id || d.step !== 'confirm') { await ctx.answerCallbackQuery({ text: 'This confirmation has expired.' }); return; }
        // Remove the draft before saving, so a second tap cannot post the same offer again.
        drafts.delete(ctx.from.id);

        const gradesText = listLabel(d.grades, GRADES, 'All Grades', 'Any grade');
        const title = `Tutor (${gradesText})`;

        try {
            await pool.query(
                `WITH created_offer AS (
                    INSERT INTO "TutoringOffer"
                     ("organizationId", "title", "subject", "gradeLevel", "gradeLevels",
                      "subCity", "locationDetail", "monthlySalaryEtb", "salaryUnit",
                      "salaryAmountEtb", "sessionHours", "sessionsPerWeek",
                      "preferredTutorGender", "requirements", "status")
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'OPEN')
                     RETURNING id, "organizationId"
                 )
                 INSERT INTO "AuditEvent"
                    ("actorRef", "actorType", action, "entityType", "entityRef", metadata)
                 SELECT o."auditRef", 'AGENCY', 'OFFER_CREATED', 'TUTORING_OFFER',
                        created_offer.id, '{}'::jsonb
                 FROM created_offer
                 JOIN "Organization" o ON o.id = created_offer."organizationId"`,
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

    bot.callbackQuery(/^ag:post:no:([^:]+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        const sessionId = (ctx.match as RegExpMatchArray)[1];
        if (!d || sessionId !== d.id || d.step !== 'confirm') { await ctx.answerCallbackQuery({ text: 'This confirmation has expired.' }); return; }
        drafts.delete(ctx.from.id);
        await ctx.answerCallbackQuery();
        await ctx.reply('Cancelled.');
    });

    // Typed answers: optional location, pay amount, session hours, requirements.
    bot.on('message:text', async (ctx, next) => {
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
         WHERE id = $1 AND ("telegramUserId" = $3 OR lower("telegramUsername") = lower($4))`,
                [orgId, text, ctx.from.id, ctx.from.username ?? null]
            );

            templateDrafts.delete(ctx.from.id);

            return ctx.reply(
                'Your offer template has been saved. Your next offers will use this layout.\n\n' +
                'You can change it any time with /template.'
            );
        }


        const d = drafts.get(ctx.from.id);
        if (!d) return next();


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