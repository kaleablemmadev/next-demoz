// src/agency.ts

import { Bot, InlineKeyboard, type Api, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { notifyUpdatedOffer } from './alerts.js';
import { offerButtons, refreshOfferPosts, setRepostStopped } from './reposts.js';
import { isAdmin } from './admin.js';
import {
    DIRECT_ORG_ID,
    closeDirectOffer,
    deleteTemplate,
    getTemplate,
    insertDirectOffer,
    listOpenDirectOffers,
    listTemplates,
    saveTemplate,
    type TemplateFields,
} from './direct-offers.js';

import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { GRADES } from './curriculum.js';
import { MAX_SUBJECT_LENGTH, MAX_SUBJECTS, parseTutorSubjects } from './subjects.js';
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
    chatId: number; // where the form's questions are sent
    editOfferId: string | null; // set when this form edits a posted offer
    orgId: string;
    orgName: string;
    orgUsername: string;
    postTemplate: string | null;
    step:
    | 'grades'
    | 'subjects'
    | 'area'
    | 'sefer'
    | 'seferName'
    | 'location'
    | 'sessions'
    | 'unit'
    | 'amount'
    | 'hours'
    | 'gender'
    | 'requirements'
    | 'contact'
    | 'confirm';
    grades: string[];
    subjects: string[];
    subCity?: string;
    locationDetail?: string | null;
    sessionsPerWeek?: number;
    unit?: Unit;
    amount?: number;
    sessionHours?: number;
    gender?: Gender;
    requirements?: string | null;
    seferId?: string | null; // the offer's sefer, if one was picked
    seferChoices?: { id: string; name: string }[]; // approved sefers in the chosen sub-city
    adminMode?: boolean; // admin offer sent to tutors only
    contact?: string | null; // admin offers: username tutors contact
};

const WEEKS_PER_MONTH = 4.33;

// In-memory drafts. If the bot restarts mid-form, the agency sends /new again.
const drafts = new Map<number, Draft>();
const templateDrafts = new Map<number, string>();
const templateNameDrafts = new Map<number, string>(); // admin: waiting for a template name, value is the draft id
const lastAgencyGradeTap = new Map<number, { key: string; at: number }>();

export function clearAgencySession(telegramId: number) {
    drafts.delete(telegramId);
    templateDrafts.delete(telegramId);
    templateNameDrafts.delete(telegramId);
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
        gradeLevels: d.grades,
        subject: d.subjects[0] ?? null,
        subjects: d.subjects,
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
        agencyUsername: d.adminMode ? (d.contact ?? '') : d.orgUsername,
        agencyName: d.orgName,
    };

    return offerCardText(offer, 'OPEN').split('\n');
}

// The reusable part of an offer, as stored in an admin template.
function templateFieldsOf(d: Draft): TemplateFields {
    return {
        grades: d.grades,
        subjects: d.subjects,
        subCity: d.subCity ?? '',
        locationDetail: d.locationDetail ?? null,
        sessionsPerWeek: d.sessionsPerWeek ?? 0,
        unit: d.unit ?? 'MONTH',
        amount: d.amount ?? 0,
        sessionHours: d.sessionHours ?? 0,
        gender: d.gender ?? null,
        requirements: d.requirements ?? null,
        contact: d.contact ?? '',
    };
}

// Approved sefers in a sub-city, in name order.
async function approvedSefers(subCity: string): Promise<{ id: string; name: string }[]> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM "Sefer" WHERE "subCity" = $1 AND status = 'APPROVED' ORDER BY name`,
        [subCity]
    );
    return rows;
}

// Admin offers ask for the contact username after the requirements, unless it is already set.
function afterRequirements(d: Draft): Draft['step'] {
    return d.adminMode && !d.contact ? 'contact' : 'confirm';
}

// Sends a form question. Forms in group buttons send their questions to the agency's private chat.
type Reply = (text: string, other?: Parameters<Context['reply']>[1]) => Promise<unknown>;

function replyTo(ctx: Context): Reply {
    return (text, other) => ctx.reply(text, other);
}

function privateReply(api: Api, chatId: number): Reply {
    return (text, other) => api.sendMessage(chatId, text, other as Parameters<Api['sendMessage']>[2]);
}

async function ask(reply: Reply, d: Draft) {
    switch (d.step) {
        case 'grades':
            return reply('Which grades? Pick one or more, or tap All.', {
                reply_markup: multiKeyboard('grd', GRADES, d.grades, d.id),
            });
        case 'subjects':
            return reply(
                `Which subjects does this offer cover? Type up to ${MAX_SUBJECTS}, separated by commas.\nExample: Mathematics, Physics, Chemistry.`
            );
        case 'area':
            return reply('Which sub-city?', {
                reply_markup: choices('area', KNOWN_SUB_CITIES.map((c) => [c, c] as [string, string]), d.id, 3),
            });
        case 'location':
            return reply('Optional: type a location detail, such as a nearby landmark. Or tap Skip.', {
                reply_markup: new InlineKeyboard().text('Skip', `ag:skip:${d.id}:location`),
            });
        case 'sessions':
            return reply('Sessions per week?', {
                reply_markup: choices('sess', [['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']], d.id, 4),
            });
        case 'unit':
            return reply('How is the pay set?', {
                reply_markup: choices('unit', [['Monthly', 'MONTH'], ['Hourly', 'HOUR']], d.id, 2),
            });
        case 'amount':
            return reply(
                d.unit === 'HOUR'
                    ? 'Hourly rate in ETB? Type a number, for example 300.'
                    : 'Monthly salary in ETB? Type a number, for example 2500.'
            );
        case 'hours':
            return reply('How many hours is one session? Type a number, for example 2.');
        case 'gender':
            return reply('Preferred tutor gender?', {
                reply_markup: choices('gen', [['Any', 'ANY'], ['Male', 'MALE'], ['Female', 'FEMALE']], d.id, 3),
            });
        case 'requirements':
            return reply(
                'Optional: any other requirements for the tutor, for example experience or teaching style. Or tap Skip.',
                { reply_markup: new InlineKeyboard().text('Skip', `ag:skip:${d.id}:requirements`) }
            );
        case 'sefer': {
            const kb = new InlineKeyboard();
            (d.seferChoices ?? []).forEach((s, i) => kb.text(s.name, `ag:sef:${d.id}:${i}`).row());
            kb.text('Not in the list: I will type it', `ag:sef:${d.id}:new`).row();
            kb.text('Skip', `ag:sef:${d.id}:none`);
            return reply(
                `Which sefer in ${d.subCity}? Sefers help tutors nearby see this offer first. Pick one, or skip.`,
                { reply_markup: kb }
            );
        }
        case 'seferName':
            return reply(
                'Type the sefer name. You can use it on this offer straight away. ' +
                'The admin reviews new sefers before they are used for sorting.'
            );
        case 'contact':
            return reply('Which Telegram username should tutors contact? Type it with the @, for example @my_name.');
        case 'confirm':
            if (d.adminMode) {
                return reply(
                    `Please check the offer. It goes to matching tutors only and is not posted in any group or channel:\n\n${offerLines(d).join('\n')}`,
                    {
                        reply_markup: new InlineKeyboard()
                            .text('Send to tutors', `adm:send:${d.id}`)
                            .text('Edit', `ag:post:edit:${d.id}`)
                            .row()
                            .text('Save as template', `adm:tpl:${d.id}`)
                            .text('Cancel', `ag:post:no:${d.id}`),
                    }
                );
            }
            return reply(`Please check the offer:\n\n${offerLines(d).join('\n')}`, {
                reply_markup: new InlineKeyboard()
                    .text(d.editOfferId ? 'Save changes' : 'Post offer', `ag:post:yes:${d.id}`)
                    .text('Edit', `ag:post:edit:${d.id}`)
                    .row()
                    .text('Cancel', `ag:post:no:${d.id}`),
            });
    }
}

// Saves an edited offer, then brings its posts and the tutors who received it up to date.
// Returns false if the offer is no longer open, so nothing was changed.
async function saveOfferEdit(api: Api, d: Draft): Promise<boolean> {
    const offerId = d.editOfferId!;
    const title = `Tutor (${listLabel(d.grades, GRADES, 'All Grades', 'Any grade')})`;

    const { rowCount } = await pool.query(
        `WITH updated_offer AS (
            UPDATE "TutoringOffer" SET
                title = $2, "gradeLevel" = $3, "gradeLevels" = $4, "subject" = $5, subjects = $6,
                "subCity" = $7, "locationDetail" = $8, "monthlySalaryEtb" = $9, "salaryUnit" = $10,
                "salaryAmountEtb" = $11, "sessionHours" = $12, "sessionsPerWeek" = $13,
                "preferredTutorGender" = $14, requirements = $15, "seferId" = $16
            WHERE id = $1 AND status = 'OPEN'
            RETURNING id, "organizationId"
         )
         INSERT INTO "AuditEvent"
            ("actorRef", "actorType", action, "entityType", "entityRef", metadata)
         SELECT o."auditRef", 'AGENCY', 'OFFER_UPDATED', 'TUTORING_OFFER',
                updated_offer.id::uuid, '{}'::jsonb
         FROM updated_offer
         JOIN "Organization" o ON o.id = updated_offer."organizationId"`,
        [
            offerId,
            title,
            d.grades[0] ?? 'Not specified',
            d.grades,
            d.subjects[0] ?? null,
            d.subjects,
            d.subCity,
            d.locationDetail ?? null,
            monthlyOf(d),
            d.unit,
            d.amount,
            d.sessionHours,
            d.sessionsPerWeek,
            d.gender ?? null,
            d.requirements ?? null,
            d.seferId ?? null,
        ]
    );
    if (!rowCount) return false;

    const updated = await refreshOfferPosts(api, offerId);
    if (updated) await notifyUpdatedOffer(api, updated);
    return true;
}

type ManagedOffer = {
    id: string;
    title: string;
    subCity: string;
    salaryUnit: Unit;
    salaryAmountEtb: number;
    repostEveryDays: number;
    repostStopped: boolean;
};

const REPOST_CHOICES = [1, 2, 3, 5, 7];

function manageText(o: ManagedOffer): string {
    const pay = o.salaryUnit === 'HOUR' ? 'per hour' : 'per month';
    const repost = o.repostStopped
        ? 'Reposting paused'
        : `Reposted every ${o.repostEveryDays} day${o.repostEveryDays === 1 ? '' : 's'}`;
    return `${o.title}\n${o.subCity} · ${Number(o.salaryAmountEtb).toLocaleString()} ETB ${pay}\n${repost}`;
}

function manageKeyboard(o: ManagedOffer): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const days of REPOST_CHOICES) {
        keyboard.text(`${days === o.repostEveryDays ? '✅ ' : ''}${days}d`, `rp:d:${o.id}:${days}`);
    }
    keyboard
        .row()
        .text('Edit offer', `edit:${o.id}`)
        .row()
        .text(o.repostStopped ? 'Resume reposting' : 'Stop reposting', `rp:${o.repostStopped ? 'go' : 'stop'}:${o.id}`);
    return keyboard;
}

// The offer if this account posted it and it is still open. Used by the private controls.
async function ownedOpenOffer(offerId: string, telegramId: number): Promise<ManagedOffer | null> {
    const { rows } = await pool.query<ManagedOffer>(
        `SELECT t.id, t.title, t."subCity", t."salaryUnit", t."salaryAmountEtb",
                t."repostEveryDays", t."repostStopped"
         FROM "TutoringOffer" t
         JOIN "Organization" o ON o.id = t."organizationId"
         WHERE t.id = $1 AND o."telegramUserId" = $2 AND t.status = 'OPEN'`,
        [offerId, telegramId]
    );
    return rows[0] ?? null;
}

export function registerAgencyHandlers(bot: Bot) {
    registerDirectOfferHandlers(bot);

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
        const hadName = templateNameDrafts.delete(ctx.from!.id);
        if (!hadOffer && !hadTemplate && !hadName) return next();
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
            chatId: ctx.chat!.id,
            editOfferId: null,
            orgId: agency.id,
            orgName: agency.name,
            orgUsername: agency.telegramUsername,
            postTemplate: agency.postTemplate ?? null,
            step: 'grades',
            grades: [],
            subjects: [],
        };
        drafts.set(ctx.from!.id, draft);
        await ask(replyTo(ctx), draft);
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
            d.step = 'subjects';
            return ask(replyTo(ctx), d);
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
            if (d.adminMode) {
                d.step = 'location';
            } else {
                d.seferChoices = await approvedSefers(value);
                d.seferId = null;
                d.step = 'sefer';
            }
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
        await ask(replyTo(ctx), d);
    });

    // Sefer choice: an approved sefer by index, a new one to type, or skip.
    bot.callbackQuery(/^ag:sef:([^:]+):(\d+|new|none)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }
        const [, sessionId, choice] = ctx.match as RegExpMatchArray;
        if (sessionId !== d.id || d.step !== 'sefer') { await ctx.answerCallbackQuery({ text: 'This step has expired.' }); return; }

        if (choice === 'new') {
            d.step = 'seferName';
        } else if (choice === 'none') {
            d.seferId = null;
            d.step = 'location';
        } else {
            const picked = d.seferChoices?.[Number(choice)];
            if (!picked) { await ctx.answerCallbackQuery({ text: 'That choice has expired.' }); return; }
            d.seferId = picked.id;
            d.step = 'location';
        }

        await ctx.answerCallbackQuery();
        await ask(replyTo(ctx), d);
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
            d.step = afterRequirements(d);
        }

        await ctx.answerCallbackQuery();
        await ask(replyTo(ctx), d);
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

        if (d.editOfferId) {
            try {
                const saved = await saveOfferEdit(ctx.api, d);
                await ctx.answerCallbackQuery();
                return ctx.reply(
                    saved
                        ? 'Offer updated. Its posts show the new details, and tutors who already received it have been told about the change.'
                        : 'This offer is closed, so it was not changed.'
                );
            } catch (err) {
                drafts.set(ctx.from.id, d);
                throw err;
            }
        }

        const gradesText = listLabel(d.grades, GRADES, 'All Grades', 'Any grade');
        const title = `Tutor (${gradesText})`;

        try {
            await pool.query(
                `WITH created_offer AS (
                    INSERT INTO "TutoringOffer"
                     ("organizationId", "title", "gradeLevel", "gradeLevels", "subject", "subjects",
                      "subCity", "locationDetail", "monthlySalaryEtb", "salaryUnit",
                      "salaryAmountEtb", "sessionHours", "sessionsPerWeek",
                      "preferredTutorGender", "requirements", "seferId", "status")
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'OPEN')
                     RETURNING id, "organizationId"
                 )
                 INSERT INTO "AuditEvent"
                    ("actorRef", "actorType", action, "entityType", "entityRef", metadata)
                 SELECT o."auditRef", 'AGENCY', 'OFFER_CREATED', 'TUTORING_OFFER',
                        created_offer.id::uuid, '{}'::jsonb
                 FROM created_offer
                 JOIN "Organization" o ON o.id = created_offer."organizationId"`,
                [
                    d.orgId,
                    title,
                    d.grades[0] ?? 'Not specified',
                    d.grades,
                    d.subjects[0] ?? null,
                    d.subjects,
                    d.subCity,
                    d.locationDetail ?? null,
                    monthlyOf(d),
                    d.unit,
                    d.amount,
                    d.sessionHours,
                    d.sessionsPerWeek,
                    d.gender ?? null,
                    d.requirements ?? null,
                    d.seferId ?? null,
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

    bot.callbackQuery(/^ag:post:edit:([^:]+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        const sessionId = (ctx.match as RegExpMatchArray)[1];
        if (!d || sessionId !== d.id || d.step !== 'confirm') { await ctx.answerCallbackQuery({ text: 'This confirmation has expired.' }); return; }
        d.step = 'grades';
        await ctx.answerCallbackQuery();
        return ask(replyTo(ctx), d);
    });

    // "Edit offer" on a posted offer. The form opens in the agency's private chat with the current answers filled in.
    bot.callbackQuery(/^edit:([^:]+)$/, async (ctx) => {
        const offerId = (ctx.match as RegExpMatchArray)[1];
        const { rows } = await pool.query(
            `SELECT t.id, t.title, t.status, t."gradeLevels", t.subjects, t."subCity", t."locationDetail",
                    t."sessionsPerWeek", t."sessionHours", t."salaryUnit", t."salaryAmountEtb",
                    t."preferredTutorGender", t.requirements, t."seferId",
                    o.id AS "orgId", o.name AS "orgName", o."telegramUsername" AS "orgUsername",
                    o."postTemplate"
             FROM "TutoringOffer" t
             JOIN "Organization" o ON o.id = t."organizationId"
             WHERE t.id = $1 AND o."telegramUserId" = $2`,
            [offerId, ctx.from.id]
        );
        const row = rows[0];
        if (!row) {
            return ctx.answerCallbackQuery({ text: 'Only the agency that posted this offer can edit it.', show_alert: true });
        }
        if (row.status !== 'OPEN') {
            return ctx.answerCallbackQuery({ text: 'This offer is closed and cannot be edited.', show_alert: true });
        }

        const draft: Draft = {
            id: randomUUID(),
            chatId: ctx.from.id,
            editOfferId: row.id,
            orgId: row.orgId,
            orgName: row.orgName,
            orgUsername: row.orgUsername,
            postTemplate: row.postTemplate ?? null,
            step: 'grades',
            grades: row.gradeLevels ?? [],
            subjects: row.subjects ?? [],
            subCity: row.subCity,
            locationDetail: row.locationDetail ?? null,
            sessionsPerWeek: row.sessionsPerWeek,
            unit: row.salaryUnit as Unit,
            amount: row.salaryAmountEtb ?? undefined,
            sessionHours: row.sessionHours == null ? undefined : Number(row.sessionHours),
            gender: (row.preferredTutorGender ?? null) as Gender,
            requirements: row.requirements ?? null,
            seferId: row.seferId ?? null,
        };

        try {
            await ctx.api.sendMessage(
                ctx.from.id,
                `Editing "${row.title}". Your current answers are filled in. Go through the steps, then check the preview before saving.`
            );
        } catch (err) {
            console.error('Could not open the edit form in private chat:', err);
            return ctx.answerCallbackQuery({
                text: 'Open a private chat with the bot and send /start first, then try again.',
                show_alert: true,
            });
        }

        drafts.set(ctx.from.id, draft);
        await ctx.answerCallbackQuery({ text: 'Sent to your private chat with NextTutor.' });
        await ask(privateReply(ctx.api, ctx.from.id), draft);
    });

    // Private controls for the agency's open offers.
    bot.command('myoffers', async (ctx) => {
        const { rows } = await pool.query<ManagedOffer>(
            `SELECT t.id, t.title, t."subCity", t."salaryUnit", t."salaryAmountEtb",
                    t."repostEveryDays", t."repostStopped"
             FROM "TutoringOffer" t
             JOIN "Organization" o ON o.id = t."organizationId"
             WHERE o."telegramUserId" = $1 AND t.status = 'OPEN'
             ORDER BY t."postedAt" DESC
             LIMIT 10`,
            [ctx.from!.id]
        );
        if (rows.length === 0) {
            return ctx.reply('You have no open offers. Send /new to post one.');
        }

        await ctx.reply(
            `Your open offers (${rows.length}). Pick how often each one is reposted, edit it, or pause reposting. ` +
            'Only you can see these settings.'
        );
        for (const o of rows) {
            await ctx.reply(manageText(o), { reply_markup: manageKeyboard(o) });
        }
    });

    bot.callbackQuery(/^rp:d:([^:]+):(\d+)$/, async (ctx) => {
        const [, offerId, daysText] = ctx.match as RegExpMatchArray;
        const days = Number(daysText);
        if (!REPOST_CHOICES.includes(days)) return ctx.answerCallbackQuery();

        const o = await ownedOpenOffer(offerId, ctx.from.id);
        if (!o) {
            return ctx.answerCallbackQuery({ text: 'This offer is closed or not yours.', show_alert: true });
        }

        await pool.query(`UPDATE "TutoringOffer" SET "repostEveryDays" = $2 WHERE id = $1`, [offerId, days]);
        const updated = { ...o, repostEveryDays: days };
        await ctx.answerCallbackQuery({ text: `Reposting every ${days} day${days === 1 ? '' : 's'}.` });
        await ctx.editMessageText(manageText(updated), { reply_markup: manageKeyboard(updated) });
    });

    bot.callbackQuery(/^rp:(stop|go):([^:]+)$/, async (ctx) => {
        const [, action, offerId] = ctx.match as RegExpMatchArray;
        const o = await ownedOpenOffer(offerId, ctx.from.id);
        if (!o) {
            return ctx.answerCallbackQuery({ text: 'This offer is closed or not yours.', show_alert: true });
        }

        const stopped = action === 'stop';
        await setRepostStopped(ctx.api, offerId, stopped);
        const updated = { ...o, repostStopped: stopped };
        await ctx.answerCallbackQuery({
            text: stopped ? 'Reposting paused. The offer stays open.' : 'Reposting resumed.',
        });
        await ctx.editMessageText(manageText(updated), { reply_markup: manageKeyboard(updated) });
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

        // Admin: the name for a template being saved.
        if (templateNameDrafts.has(ctx.from.id)) {
            if (text.startsWith('/')) return next();
            const d = drafts.get(ctx.from.id);
            if (!d || d.id !== templateNameDrafts.get(ctx.from.id)) {
                templateNameDrafts.delete(ctx.from.id);
                return ctx.reply('This offer has expired. Send /sendoffer to start again.');
            }
            const name = text.replace(/\s+/g, ' ').slice(0, 40);
            if (name.length < 2) return ctx.reply('Please type a name with at least 2 characters.');
            try {
                await saveTemplate(name, templateFieldsOf(d));
            } catch (err) {
                if ((err as { code?: string }).code === '23505') {
                    return ctx.reply('A template with this name already exists. Type a different name.');
                }
                throw err;
            }
            templateNameDrafts.delete(ctx.from.id);
            await ctx.reply(`Saved as template "${name}". You can use it next time from /sendoffer.`);
            return ask(replyTo(ctx), d);
        }

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
                    'Your template must contain at least one supported placeholder, such as {GRADES} or {MONTHLY_SALARY}.'
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

        if (d.step === 'subjects') {
            const subjects = parseTutorSubjects(text);
            if (subjects.length === 0) {
                return ctx.reply('Please enter at least one subject, separated by commas.');
            }
            if (subjects.length > MAX_SUBJECTS) {
                return ctx.reply(`Please enter no more than ${MAX_SUBJECTS} subjects.`);
            }
            const tooLong = subjects.find((subject) => subject.length > MAX_SUBJECT_LENGTH);
            if (tooLong) {
                return ctx.reply(`Each subject must be ${MAX_SUBJECT_LENGTH} characters or fewer. Please shorten: ${tooLong}`);
            }
            d.subjects = subjects;
            d.step = 'area';
            return ask(replyTo(ctx), d);
        }

        if (d.step === 'location') {
            d.locationDetail = text.slice(0, 200) || null;
            d.step = 'sessions';
            return ask(replyTo(ctx), d);
        }

        if (d.step === 'amount') {
            const amount = Number(text.replace(/[,\s]/g, ''));
            const [min, max] = d.unit === 'HOUR' ? [50, 5000] : [500, 20000];
            if (!Number.isInteger(amount) || amount < min || amount > max) {
                return ctx.reply(`Please type a whole number between ${min} and ${max}.`);
            }
            d.amount = amount;
            d.step = 'hours';
            return ask(replyTo(ctx), d);
        }

        if (d.step === 'hours') {
            const hours = Number(text);
            if (!Number.isInteger(hours) || hours < 1 || hours > 8) {
                return ctx.reply('Please type a whole number of hours between 1 and 8.');
            }
            d.sessionHours = hours;
            d.step = 'gender';
            return ask(replyTo(ctx), d);
        }

        if (d.step === 'seferName') {
            const name = text.replace(/\s+/g, ' ').slice(0, 40);
            if (name.length < 2) return ctx.reply('Please type a name with at least 2 characters.');
            // If the name already exists (approved or waiting), use that sefer.
            const { rows: existing } = await pool.query<{ id: string }>(
                `SELECT id FROM "Sefer" WHERE lower(name) = lower($1)`,
                [name]
            );
            if (existing[0]) {
                d.seferId = existing[0].id;
            } else {
                const { rows: created } = await pool.query<{ id: string }>(
                    `INSERT INTO "Sefer" (name, "subCity", status, "proposedByTelegramId")
                     VALUES ($1, $2, 'PENDING', $3) RETURNING id`,
                    [name, d.subCity, ctx.from.id]
                );
                d.seferId = created[0].id;
                await ctx.reply(`"${name}" was sent to the admin for review.`);
            }
            d.step = 'location';
            return ask(replyTo(ctx), d);
        }

        if (d.step === 'contact') {
            const username = text.replace(/^@/, '');
            if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) {
                return ctx.reply('Please type a valid Telegram username, for example @my_name.');
            }
            d.contact = username;
            d.step = 'confirm';
            return ask(replyTo(ctx), d);
        }

        if (d.step === 'requirements') {
            d.requirements = text.slice(0, 500) || null;
            d.step = afterRequirements(d);
            return ask(replyTo(ctx), d);
        }

        return next();
    });
}

// ---- Admin offers sent straight to tutors, and named templates ----

function newDirectDraft(chatId: number): Draft {
    return {
        id: randomUUID(),
        chatId,
        editOfferId: null,
        adminMode: true,
        contact: null,
        orgId: DIRECT_ORG_ID,
        orgName: 'NextTutor',
        orgUsername: '',
        postTemplate: null,
        step: 'grades',
        grades: [],
        subjects: [],
    };
}

function directMenu() {
    return new InlineKeyboard()
        .text('New offer', 'adm:new')
        .row()
        .text('Use a saved template', 'adm:pick')
        .row()
        .text('Manage templates', 'adm:list')
        .row()
        .text('Open offers', 'adm:open');
}

async function showTemplateList(reply: Reply) {
    const templates = await listTemplates();
    if (templates.length === 0) return reply('No saved templates yet. Save one from the preview of an offer with "Save as template".');
    const kb = new InlineKeyboard();
    for (const t of templates) kb.text(`Delete "${t.name}"`, `adm:del:${t.id}`).row();
    return reply('Saved templates. Tap one to delete it. Offers already sent are not changed.', { reply_markup: kb });
}

async function showOpenDirectOffers(reply: Reply) {
    const offers = await listOpenDirectOffers();
    if (offers.length === 0) return reply('You have no open offers sent to tutors.');
    for (const o of offers) {
        const pay = `${Number(o.salaryAmountEtb).toLocaleString()} ETB ${o.salaryUnit === 'HOUR' ? 'per hour' : 'per month'}`;
        await reply(`${o.title}\n${o.subCity} · ${pay}`, {
            reply_markup: new InlineKeyboard().text('Close this offer', `adm:close:${o.id}`),
        });
    }
}

function registerDirectOfferHandlers(bot: Bot) {
    const adminOnly = 'This is for the NextTutor admin only.';

    bot.callbackQuery('adm:menu', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return ctx.reply(
            'Send an offer straight to matching tutors. It is not posted in any group or channel.\n\nStart a new offer, or use a saved template.',
            { reply_markup: directMenu() }
        );
    });

    bot.command('sendoffer', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply(adminOnly);
        if (ctx.chat?.type !== 'private') return ctx.reply('Use /sendoffer in a private chat with the bot.');
        return ctx.reply(
            'Send an offer straight to matching tutors. It is not posted in any group or channel.\n\n' +
            'Start a new offer, or use a saved template.',
            { reply_markup: directMenu() }
        );
    });

    bot.command('directoffers', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply(adminOnly);
        return showOpenDirectOffers(replyTo(ctx));
    });

    bot.callbackQuery('adm:new', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        const draft = newDirectDraft(ctx.chat?.id ?? ctx.from.id);
        drafts.set(ctx.from.id, draft);
        await ask(replyTo(ctx), draft);
    });

    bot.callbackQuery('adm:pick', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        const templates = await listTemplates();
        if (templates.length === 0) {
            return ctx.reply('No saved templates yet. Save one from the preview of an offer with "Save as template".');
        }
        const kb = new InlineKeyboard();
        for (const t of templates) kb.text(t.name, `adm:use:${t.id}`).row();
        return ctx.reply('Which template?', { reply_markup: kb });
    });

    bot.callbackQuery(/^adm:use:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const tpl = await getTemplate((ctx.match as RegExpMatchArray)[1]);
        if (!tpl) return ctx.answerCallbackQuery({ text: 'This template no longer exists.', show_alert: true });
        await ctx.answerCallbackQuery({ text: `Using "${tpl.name}".` });
        const f = tpl.fields;
        const draft: Draft = {
            ...newDirectDraft(ctx.chat?.id ?? ctx.from.id),
            step: 'confirm',
            grades: f.grades,
            subjects: f.subjects,
            subCity: f.subCity,
            locationDetail: f.locationDetail,
            sessionsPerWeek: f.sessionsPerWeek,
            unit: f.unit,
            amount: f.amount,
            sessionHours: f.sessionHours,
            gender: f.gender,
            requirements: f.requirements,
            contact: f.contact,
        };
        drafts.set(ctx.from.id, draft);
        await ask(replyTo(ctx), draft);
    });

    bot.callbackQuery('adm:list', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return showTemplateList(replyTo(ctx));
    });

    bot.callbackQuery(/^adm:del:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const name = await deleteTemplate((ctx.match as RegExpMatchArray)[1]);
        await ctx.answerCallbackQuery();
        return ctx.editMessageText(name ? `Deleted template "${name}".` : 'That template was already deleted.');
    });

    bot.callbackQuery('adm:open', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return showOpenDirectOffers(replyTo(ctx));
    });

    bot.callbackQuery(/^adm:close:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const closed = await closeDirectOffer((ctx.match as RegExpMatchArray)[1]);
        await ctx.answerCallbackQuery({ text: closed ? 'Closed.' : 'This offer is already closed.' });
        return ctx.editMessageText(closed ? 'Closed.' : 'This offer was already closed.');
    });

    bot.callbackQuery(/^adm:tpl:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const d = drafts.get(ctx.from.id);
        const sessionId = (ctx.match as RegExpMatchArray)[1];
        if (!d || !d.adminMode || sessionId !== d.id || d.step !== 'confirm') {
            return ctx.answerCallbackQuery({ text: 'This confirmation has expired.' });
        }
        templateNameDrafts.set(ctx.from.id, d.id);
        await ctx.answerCallbackQuery();
        return ctx.reply(
            'Type a name for this template, for example "Bole grades 1-6 maths". ' +
            'Send /cancel to stop without saving.'
        );
    });

    bot.callbackQuery(/^adm:send:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const d = drafts.get(ctx.from.id);
        const sessionId = (ctx.match as RegExpMatchArray)[1];
        if (!d || !d.adminMode || sessionId !== d.id || d.step !== 'confirm') {
            return ctx.answerCallbackQuery({ text: 'This confirmation has expired.' });
        }
        // Remove the draft first, so a second tap cannot send the same offer again.
        drafts.delete(ctx.from.id);
        try {
            const title = `Tutor (${listLabel(d.grades, GRADES, 'All Grades', 'Any grade')})`;
            await insertDirectOffer({ ...templateFieldsOf(d), title, monthlySalaryEtb: monthlyOf(d) });
        } catch (err) {
            drafts.set(ctx.from.id, d);
            throw err;
        }
        await ctx.answerCallbackQuery();
        return ctx.reply(
            'Sent. Matching tutors will receive it within a few minutes. ' +
            'It stays open until you close it with /directoffers.'
        );
    });
}
