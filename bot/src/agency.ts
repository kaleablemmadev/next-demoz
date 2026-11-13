import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { SUBJECTS } from './subjects.js';
import { GRADES } from './grades.js';

type Unit = 'MONTH' | 'HOUR';
type Gender = 'MALE' | 'FEMALE' | null;

type Draft = {
    orgId: string;
    orgName: string;
    orgUsername: string;
    postHeader: string | null;
    postFooter: string | null;
    step:
        | 'subjects'
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
    subjects: string[];
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

async function findAgency(username: string | undefined) {
    if (!username) return null;
    const { rows } = await pool.query(
        `SELECT id, name, "telegramUsername", "postHeader", "postFooter"
         FROM "Organization" WHERE lower("telegramUsername") = lower($1) AND status = 'ACTIVE'`,
        [username]
    );
    return rows[0] ?? null;
}

// Rounds a number to the nearest step, for example nearest 50 or nearest 5.
function roundTo(value: number, step: number): number {
    return Math.round(value / step) * step;
}

// Monthly estimate for an hourly rate, rounded to the nearest 50.
function monthlyOf(d: Draft): number {
    if (d.unit === 'HOUR') {
        const raw = (d.amount ?? 0) * (d.sessionHours ?? 0) * (d.sessionsPerWeek ?? 0) * WEEKS_PER_MONTH;
        return roundTo(raw, 50);
    }
    return d.amount ?? 0;
}

// Hourly estimate for a monthly salary, rounded to the nearest 5.
function hourlyOf(d: Draft): number {
    if (d.unit === 'MONTH') {
        const hoursPerMonth = (d.sessionHours ?? 0) * (d.sessionsPerWeek ?? 0) * WEEKS_PER_MONTH;
        return hoursPerMonth > 0 ? roundTo((d.amount ?? 0) / hoursPerMonth, 5) : 0;
    }
    return d.amount ?? 0;
}

// Shows "All Subjects" when every option is picked, the list otherwise, and emptyLabel when none.
function listLabel(items: string[], all: string[], allLabel: string, emptyLabel: string): string {
    if (items.length === 0) return emptyLabel;
    if (all.every((x) => items.includes(x))) return allLabel;
    return items.join(', ');
}

function multiKeyboard(kind: string, options: string[], selected: string[]) {
    const kb = new InlineKeyboard();
    options.forEach((v, i) => {
        kb.text(`${selected.includes(v) ? '✅ ' : ''}${v}`, `ag:${kind}:${v}`);
        if (i % 2 === 1) kb.row();
    });
    kb.row().text('All', `ag:${kind}:ALL`).text('Clear', `ag:${kind}:CLEAR`);
    kb.row().text('Done', `ag:${kind}:DONE`);
    if (kind === 'sub') kb.row().text('Skip', 'ag:skip:subjects');
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
    const genderLabel = d.gender === 'MALE' ? 'Male' : d.gender === 'FEMALE' ? 'Female' : 'Any';
    const lines: string[] = [];

    if (d.postHeader) lines.push(d.postHeader, '');

    lines.push(
        `Subjects: ${listLabel(d.subjects, SUBJECTS, 'All Subjects', 'Not specified')}`,
        `Grades: ${listLabel(d.grades, GRADES, 'All Grades', 'Not specified')}`,
        `Area: ${d.subCity}`
    );
    if (d.locationDetail) lines.push(`Location: ${d.locationDetail}`);
    lines.push(
        `Sessions: ${d.sessionsPerWeek} per week`,
        `Session length: ${d.sessionHours} hours`,
        `Pay: ${salaryLine(d)}`,
        `Tutor gender: ${genderLabel}`
    );
    if (d.requirements) lines.push(`Requirements: ${d.requirements}`);
    lines.push(`Contact: @${d.orgUsername}`);

    if (d.postFooter) lines.push('', d.postFooter);
    return lines;
}

async function ask(ctx: Context, d: Draft) {
    switch (d.step) {
        case 'subjects':
            return ctx.reply('Which subjects? Pick one or more, tap All, or tap Skip.', {
                reply_markup: multiKeyboard('sub', SUBJECTS, d.subjects),
            });
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
            return ctx.reply('Optional: type any requirements for the tutor, such as experience. Or tap Skip.', {
                reply_markup: new InlineKeyboard().text('Skip', 'ag:skip:requirements'),
            });
        case 'confirm':
            return ctx.reply(`Please check the offer:\n\n${offerLines(d).join('\n')}`, {
                reply_markup: new InlineKeyboard().text('Post offer', 'ag:post:yes').text('Cancel', 'ag:post:no'),
            });
    }
}

export function registerAgencyHandlers(bot: Bot) {
    bot.command('new', async (ctx) => {
        const agency = await findAgency(ctx.from?.username);
        if (!agency) {
            return ctx.reply('This account is not registered as an agency.');
        }

        const draft: Draft = {
            orgId: agency.id,
            orgName: agency.name,
            orgUsername: agency.telegramUsername,
            postHeader: agency.postHeader ?? null,
            postFooter: agency.postFooter ?? null,
            step: 'subjects',
            subjects: [],
            grades: [],
        };
        drafts.set(ctx.from!.id, draft);
        await ask(ctx, draft);
    });

    // Subject and grade multi-select.
    bot.callbackQuery(/^ag:(sub|grd):(.+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const [, kind, value] = ctx.match as RegExpMatchArray;
        const isSub = kind === 'sub';
        const options = isSub ? SUBJECTS : GRADES;
        const list = isSub ? d.subjects : d.grades;

        if (value === 'DONE') {
            // Subjects are optional. Grades need at least one.
            if (isSub && list.length === 0) list.push(...SUBJECTS);
            if (!isSub && list.length === 0) {
                return ctx.answerCallbackQuery({ text: 'Pick at least one grade.' });
            }
            await ctx.answerCallbackQuery();
            const label = isSub
                ? listLabel(list, SUBJECTS, 'All Subjects', 'Not specified')
                : listLabel(list, GRADES, 'All Grades', 'Not specified');
            await ctx.editMessageText(`${isSub ? 'Subjects' : 'Grades'}: ${label}`);
            d.step = isSub ? 'grades' : 'area';
            return ask(ctx, d);
        }

        let next: string[];
        if (value === 'ALL') next = [...options];
        else if (value === 'CLEAR') next = [];
        else next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

        if (isSub) d.subjects = next;
        else d.grades = next;

        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: multiKeyboard(kind, options, next) });
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
    bot.callbackQuery(/^ag:skip:(subjects|location|requirements)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const [, field] = ctx.match as RegExpMatchArray;
        if (field === 'subjects') {
            d.subjects = [...SUBJECTS];
            d.step = 'grades';
        } else if (field === 'location') {
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

        const subjectsText = listLabel(d.subjects, SUBJECTS, 'All Subjects', 'Any subject');
        const gradesText = listLabel(d.grades, GRADES, 'All Grades', 'Any grade');
        const title = `${subjectsText} tutor (${gradesText})`;

        await pool.query(
            `INSERT INTO "TutoringOffer"
             ("organizationId", "title", "subject", "gradeLevel", "subjects", "gradeLevels",
              "subCity", "locationDetail", "monthlySalaryEtb", "salaryUnit", "salaryAmountEtb",
              "sessionHours", "sessionsPerWeek", "preferredTutorGender", "requirements", "status")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'OPEN')`,
            [
                d.orgId,
                title,
                d.subjects[0] ?? 'Not specified',
                d.grades[0] ?? 'Not specified',
                d.subjects,
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

        drafts.delete(ctx.from.id);
        await ctx.answerCallbackQuery();
        await ctx.reply('Offer posted. Matching tutors will be alerted within about 30 seconds.');
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