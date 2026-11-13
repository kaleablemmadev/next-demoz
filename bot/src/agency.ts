import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { SUBJECTS } from './subjects.js';
import { GRADES } from './grades.js';

type Draft = {
    orgId: string;
    orgName: string;
    channelChatId: number | null;
    step: 'subject' | 'grade' | 'subCity' | 'sessions' | 'salary' | 'gender' | 'confirm';
    subject?: string;
    gradeLevel?: string;
    subCity?: string;
    sessions?: number;
    salary?: number;
    gender?: 'MALE' | 'FEMALE' | null;
};

// In-memory drafts. If the bot restarts mid-form, the agency sends /new again.
const drafts = new Map<number, Draft>();

async function findAgency(username: string | undefined) {
    if (!username) return null;
    const { rows } = await pool.query(
        `SELECT id, name, "channelChatId" FROM "Organization" WHERE lower("telegramUsername") = lower($1)`,
        [username]
    );
    return rows[0] ?? null;
}

function buttons(prefix: string, values: string[], perRow = 2) {
    const kb = new InlineKeyboard();
    values.forEach((v, i) => {
        kb.text(v, `ag:${prefix}:${v}`);
        if ((i + 1) % perRow === 0) kb.row();
    });
    return kb;
}

async function ask(ctx: Context, d: Draft) {
    switch (d.step) {
        case 'subject':
            return ctx.reply('Which subject?', { reply_markup: buttons('subject', SUBJECTS) });
        case 'grade':
            return ctx.reply('Which grade?', { reply_markup: buttons('grade', GRADES, 3) });
        case 'subCity':
            return ctx.reply('Which sub-city?', { reply_markup: buttons('area', KNOWN_SUB_CITIES, 3) });
        case 'sessions':
            return ctx.reply('Sessions per week?', { reply_markup: buttons('sessions', ['2', '3', '4', '5'], 4) });
        case 'salary':
            return ctx.reply('Monthly salary in ETB? Type a number, for example 2500.');
        case 'gender':
            return ctx.reply('Preferred tutor gender?', { reply_markup: buttons('gender', ['Any', 'Male', 'Female'], 3) });
        case 'confirm':
            return ctx.reply(
                [
                    'Please check the offer:',
                    '',
                    `Subject: ${d.subject}`,
                    `Grade: ${d.gradeLevel}`,
                    `Area: ${d.subCity}`,
                    `Sessions: ${d.sessions} a week`,
                    `Salary: ${d.salary?.toLocaleString()} ETB / month`,
                    `Tutor gender: ${d.gender ?? 'any'}`,
                    `Agency: ${d.orgName}`,
                ].join('\n'),
                {
                    reply_markup: new InlineKeyboard()
                        .text('Post offer', 'ag:post:yes')
                        .text('Cancel', 'ag:post:no'),
                }
            );
    }
}

const NEXT_STEP: Record<string, Draft['step']> = {
    subject: 'grade',
    grade: 'subCity',
    area: 'sessions',
    sessions: 'salary',
    gender: 'confirm',
};

export function registerAgencyHandlers(bot: Bot) {
    bot.command('new', async (ctx) => {
        const agency = await findAgency(ctx.from?.username);
        if (!agency) {
            return ctx.reply('This account is not registered as an agency.');
        }

        const draft: Draft = {
            orgId: agency.id,
            orgName: agency.name,
            channelChatId: agency.channelChatId === null ? null : Number(agency.channelChatId),
            step: 'subject',
        };
        drafts.set(ctx.from!.id, draft);
        await ask(ctx, draft);
    });

    bot.callbackQuery(/^ag:(subject|grade|area|sessions|gender):(.+)$/, async (ctx) => {
        const d = drafts.get(ctx.from.id);
        if (!d) {
            await ctx.answerCallbackQuery();
            return ctx.reply('Send /new to start a new offer.');
        }

        const field = ctx.match[1];
        const value = ctx.match[2];

        if (field === 'subject') d.subject = value;
        if (field === 'grade') d.gradeLevel = value;
        if (field === 'area') d.subCity = value;
        if (field === 'sessions') d.sessions = Number(value);
        if (field === 'gender') d.gender = value === 'Any' ? null : (value.toUpperCase() as 'MALE' | 'FEMALE');

        d.step = field === 'gender' ? 'confirm' : NEXT_STEP[field];

        await ctx.answerCallbackQuery();
        await ask(ctx, d);
    });

    bot.callbackQuery('ag:post:yes', async (ctx) => {
        const d = drafts.get(ctx.from.id);
        // Post to the agency's group or channel, if one is linked.
        if (d.channelChatId) {
            try {
                await bot.api.sendMessage(
                    d.channelChatId,
                    `New offer: ${d.subject} · ${d.gradeLevel} · ${d.subCity} · ${d.salary?.toLocaleString()} ETB / month`
                );
            } catch (err) {
                console.error('Channel post failed:', err);
            }
        }

        await pool.query(
            `INSERT INTO "TutoringOffer"
                ("organizationId", "title", "subject", "gradeLevel", "subCity", "monthlySalaryEtb", "sessionsPerWeek", "preferredTutorGender", "status")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN')`,
            [
                d.orgId,
                `${d.subject} tutor (${d.gradeLevel})`,
                d.subject,
                d.gradeLevel,
                d.subCity,
                d.salary,
                d.sessions,
                d.gender ?? null,
            ]
        );

        // Post to the agency's channel too, if one is set and the bot is an admin there.
        if (d.channel) {
            try {
                await bot.api.sendMessage(
                    `@${d.channel}`,
                    `New offer: ${d.subject} · ${d.gradeLevel} · ${d.subCity} · ${d.salary?.toLocaleString()} ETB / month`
                );
            } catch (err) {
                console.error('Channel post failed:', err);
            }
        }

        drafts.delete(ctx.from.id);
        await ctx.answerCallbackQuery();
        await ctx.reply('Offer posted. Matching tutors will be alerted within about 30 seconds.');
    });

    bot.callbackQuery('ag:post:no', async (ctx) => {
        drafts.delete(ctx.from.id);
        await ctx.answerCallbackQuery();
        await ctx.reply('Cancelled.');
    });

    // The salary is typed, so only read text when an agency is being asked for it.
    bot.on('message:text', async (ctx, next) => {
        const d = drafts.get(ctx.from.id);
        if (!d || d.step !== 'salary') return next();

        const amount = Number(ctx.message.text.replace(/[,\s]/g, ''));
        if (!Number.isInteger(amount) || amount < 500 || amount > 20000) {
            return ctx.reply('Please type a whole number between 500 and 20000.');
        }

        d.salary = amount;
        d.step = 'gender';
        await ask(ctx, d);
    });
}