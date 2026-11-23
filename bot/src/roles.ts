// src/roles.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { isAdmin, showAdminMenu } from './admin.js';
import { startBusinessSignup } from './signup.js';
import { reactivateIfReturning } from './agency-lifecycle.js';
import { ensureParent } from './parent.js';
import { WELCOME_MESSAGE } from './welcome.js';

// Telegram command menus are scoped to the current private chat.
export const TUTOR_COMMANDS = [
    { command: 'start', description: 'Register or start again' },
    { command: 'menu', description: 'Show the main menu' },
    { command: 'search', description: 'Search open offers' },
    { command: 'settings', description: 'Alert and notification settings' },
    { command: 'turneddown', description: 'Sefers you turned down, with undo' },
    { command: 'gender', description: 'Change my gender' },
    { command: 'feedback', description: 'Send feedback to NextTutor' },
    { command: 'leave', description: 'Delete my NextTutor account' },
    { command: 'help', description: 'List all functions' },
    { command: 'reset', description: 'Erase my data and start again' },
];

export const AGENCY_COMMANDS = [
    { command: 'start', description: 'Open the agency menu' },
    { command: 'new', description: 'Post a new tutoring offer' },
    { command: 'quick', description: 'Post an offer by describing it in your own words' },
    { command: 'template', description: 'Edit your offer post template' },
    { command: 'myoffers', description: 'Edit, repost settings and pause for your open offers' },
    { command: 'cancel', description: 'Cancel the current form' },
    { command: 'menu', description: 'Show the agency menu' },
    { command: 'help', description: 'List agency functions' },
    { command: 'feedback', description: 'Send feedback to NextTutor' },
    { command: 'leave', description: 'Request to leave NextTutor' },
    { command: 'supply', description: 'See how many tutors are registered by grade' },
];

export const PARENT_COMMANDS = [
    { command: 'start', description: 'Open the parent menu' },
    { command: 'post', description: 'Request a tutor for your child' },
    { command: 'myrequests', description: 'See the status of your requests' },
    { command: 'cancel', description: 'Cancel the current request form' },
    { command: 'menu', description: 'Show the parent menu' },
    { command: 'help', description: 'Parent help' },
    { command: 'feedback', description: 'Send feedback to NextTutor' },
    { command: 'leave', description: 'Delete my NextTutor account' },
];

export const AGENCY_HELP =
    'NextTutor agency functions\n\n' +
    '/new - Create and publish a tutoring offer.\n' +
    '/quick - Describe an offer in your own words and confirm the filled form.\n' +
    '/myoffers - See your open offers. Change how often each is reposted, pause reposting, or edit it.\n' +
    '/template - Create or replace your reusable offer-post layout. Use supported placeholders such as {GRADES} and {MONTHLY_SALARY}.\n' +
    '/cancel - Cancel the current form or template edit.\n' +
    '/menu - Show the agency menu.\n' +
    '/supply - See how many tutors are registered by grade.\n' +
    '/feedback - Send feedback to NextTutor.\n' +
    '/leave - Request to leave NextTutor.\n' +
    '/help - Show this list.';

export const PARENT_HELP =
    'NextTutor parent functions\n\n' +
    '/post - Request a tutor for your child. You will provide the grade, area, sessions per week, budget and contact details.\n' +
    '/myrequests - See the status of your requests.\n' +
    '/cancel - Cancel the current request form.\n' +
    '/menu - Show the parent menu.\n' +
    '/feedback - Send feedback to NextTutor.\n' +
    '/leave - Delete your parent account and personal data.\n' +
    '/help - Show this list.';

export type UserRole = 'admin' | 'agency' | 'parent' | 'tutor' | 'guest';

export async function findAgencyByUsername(username: string | undefined) {
    if (!username) return null;
    const { rows } = await pool.query(
        `SELECT id, name, "telegramUsername", "postTemplate"
         FROM "Organization"
         WHERE lower("telegramUsername") = lower($1) AND status = 'ACTIVE'`,
        [username]
    );
    return rows[0] ?? null;
}

// Prefer the immutable Telegram user ID. Username is retained as a migration/fallback path.
export async function findAgencyForUser(telegramId: number, username?: string) {
    const { rows } = await pool.query(
        `SELECT id, name, "telegramUsername", "postTemplate", status
         FROM "Organization"
         WHERE status IN ('ACTIVE', 'TRIAL')
           AND ("telegramUserId" = $1 OR ($2::text IS NOT NULL AND lower("telegramUsername") = lower($2)))
         ORDER BY CASE WHEN "telegramUserId" = $1 THEN 0 ELSE 1 END
         LIMIT 1`,
        [telegramId, username ?? null]
    );
    return rows[0] ?? null;
}

export async function isAgency(ctx: Context): Promise<boolean> {
    return Boolean(ctx.from && await findAgencyForUser(ctx.from.id, ctx.from.username));
}

async function isParent(telegramId: number): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT 1 FROM "Parent" WHERE "telegramId" = $1 LIMIT 1`,
        [telegramId]
    );
    return rows.length > 0;
}

async function isRegisteredTutor(telegramId: number): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT 1 FROM "TelegramSubscriber" WHERE "telegramId" = $1 AND "subCity" IS NOT NULL LIMIT 1`,
        [telegramId]
    );
    return rows.length > 0;
}

// One role resolver is shared by /start, /menu and /help to prevent role drift.
export async function resolveRole(ctx: Context): Promise<UserRole> {
    if (isAdmin(ctx)) return 'admin';
    if (!ctx.from) return 'guest';
    if (await findAgencyForUser(ctx.from.id, ctx.from.username)) return 'agency';
    if (await isParent(ctx.from.id)) return 'parent';
    if (await isRegisteredTutor(ctx.from.id)) return 'tutor';
    return 'guest';
}

export async function setChatCommands(ctx: Context, commands: { command: string; description: string }[]) {
    if (!ctx.chat) return;
    try {
        await ctx.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: ctx.chat.id } });
    } catch (err) {
        console.error('setMyCommands failed:', err);
    }
}

export async function showAgencyMenu(ctx: Context) {
    if (ctx.from?.username) {
        await pool.query(
            `UPDATE "Organization" SET "telegramUserId" = $1
             WHERE lower("telegramUsername") = lower($2) OR "telegramUserId" = $1`,
            [ctx.from.id, ctx.from.username]
        );
    }
    await setChatCommands(ctx, AGENCY_COMMANDS);
    return ctx.reply('Agency menu\n\n/new - create a tutoring offer\n/myoffers - manage your open offers\n/template - edit your reusable post template\n/supply - see tutor counts by grade\n/cancel - cancel the current form\n/feedback - send feedback to NextTutor\n/leave - request to leave NextTutor\n/help - list agency functions');
}

export async function showParentMenu(ctx: Context) {
    await setChatCommands(ctx, PARENT_COMMANDS);
    return ctx.reply('Parent menu\n\n/post - request a tutor for your child\n/myrequests - see the status of your requests\n/cancel - cancel the current request form\n/feedback - send feedback to NextTutor\n/leave - delete your parent account\n/help - parent help');
}

export async function showRolePicker(ctx: Context, source = 'direct') {
    return ctx.reply('Welcome to NextTutor. Who are you?', {
        reply_markup: new InlineKeyboard()
            .text('I am a tutor', `role:tutor:${source}`)
            .row()
            .text('I am a tutoring business', 'role:business')
            .row()
            .text('I am a parent', 'role:parent'),
    });
}

export function registerRoleHandlers(
    bot: Bot,
    startTutorOnboarding: (ctx: Context) => Promise<unknown>
) {
    bot.api.setMyCommands(TUTOR_COMMANDS).catch((err) => console.error('setMyCommands failed:', err));

    bot.command('start', async (ctx) => {
        if (!isAdmin(ctx)) await reactivateIfReturning(ctx.from!.id);
        const role = await resolveRole(ctx);
        if (role === 'admin') return showAdminMenu(ctx);
        if (role === 'agency') return showAgencyMenu(ctx);
        if (role === 'parent') return showParentMenu(ctx);
        if (role === 'tutor') {
            await setChatCommands(ctx, TUTOR_COMMANDS);
            return ctx.reply('Welcome back to NextTutor. Send /menu to see your options.');
        }
        await ctx.reply(WELCOME_MESSAGE);
        await setChatCommands(ctx, TUTOR_COMMANDS);
        return showRolePicker(ctx, ctx.match?.toString().trim() || 'direct');
    });

    bot.callbackQuery(/^role:tutor:(.*)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        await setChatCommands(ctx, TUTOR_COMMANDS);
        await ctx.editMessageText('You are registering as a tutor.');
        await startTutorOnboarding(ctx);
    });

    bot.callbackQuery('role:business', async (ctx) => {
        await ctx.answerCallbackQuery();
        await reactivateIfReturning(ctx.from.id);
        const agency = await findAgencyForUser(ctx.from.id, ctx.from.username);
        if (agency) {
            await ctx.editMessageText(`Welcome, ${agency.name}.`);
            return showAgencyMenu(ctx);
        }
        await ctx.editMessageText(
            `Would you like to try NextTutor first? You can post 5 offers free, then register. Or register your business now.`,
            { reply_markup: new InlineKeyboard().text('Post 5 free offers first', 'trial:start').row().text('Register my business now', 'trial:reg') }
        );
    });

    bot.callbackQuery('role:parent', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ensureParent(ctx);
        await ctx.editMessageText('You are looking for a tutor.');
        return showParentMenu(ctx);
    });
}
