// src/roles.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { isAdmin, showAdminMenu } from './admin.js';
import { startBusinessSignup } from './signup.js';
import { reactivateIfReturning } from './agency-lifecycle.js';

// Commands tutors see. This is the default list for every chat.
export const TUTOR_COMMANDS = [
    { command: 'start', description: 'Register or start again' },
    { command: 'menu', description: 'Show the main menu' },
    { command: 'search', description: 'Search open offers' },
    { command: 'settings', description: 'Alert and notification settings' },
    { command: 'gender', description: 'Change my gender' },
    { command: 'feedback', description: 'Send feedback to NextTutor' },
    { command: 'help', description: 'List all functions' },
    { command: 'reset', description: 'Erase my data and start again' },
];

// Commands agencies see, only in their own chat with the bot.
export const AGENCY_COMMANDS = [
    { command: 'start', description: 'Open the agency menu' },
    { command: 'new', description: 'Post a new tutoring offer' },
    { command: 'menu', description: 'Show the agency menu' },
    { command: 'help', description: 'List agency functions' },
    { command: 'feedback', description: 'Send feedback to NextTutor' },
    { command: 'leave', description: 'Request to leave NextTutor' },
];

// Commands parents see, only in their own chat with the bot.
export const PARENT_COMMANDS = [
    { command: 'start', description: 'Start over' },
    { command: 'post', description: 'Request a tutor for your child' },
    { command: 'help', description: 'Help' },
];

export const AGENCY_HELP =
    'NextTutor agency functions\n\n' +
    '/new - Post a new tutoring offer. You choose grades, sub-city, optional location, sessions, pay, optional hours, gender and optional preferred subject proficiency. Then you review and post.\n' +
    '/menu - Show the agency menu.\n' +
    '/help - Show this list.\n\n' +
    'Your offers are sent to matching tutors. If your channel is set up, they are also posted there.';

export async function findAgencyByUsername(username: string | undefined) {
    if (!username) return null;
    const { rows } = await pool.query(
        `SELECT id, name FROM "Organization" WHERE lower("telegramUsername") = lower($1) AND status = 'ACTIVE'`,
        [username]
    );
    return rows[0] ?? null;
}

export async function isAgency(ctx: Context): Promise<boolean> {
    return (await findAgencyByUsername(ctx.from?.username)) !== null;
}

async function isRegisteredTutor(telegramId: number): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT 1 FROM "TelegramSubscriber" WHERE "telegramId" = $1 AND "subCity" IS NOT NULL`,
        [telegramId]
    );
    return rows.length > 0;
}

// Sets the command list for this chat only, so each role sees its own menu.
export async function setChatCommands(ctx: Context, commands: { command: string; description: string }[]) {
    if (!ctx.chat) return;
    try {
        await ctx.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: ctx.chat.id } });
    } catch (err) {
        console.error('setMyCommands failed:', err);
    }
}

// Shows the agency menu, saves the agency's Telegram ID so the bot can message them,
// and makes this chat's command list the agency one.
export async function showAgencyMenu(ctx: Context) {
    if (ctx.from?.username) {
        await pool.query(
            `UPDATE "Organization" SET "telegramUserId" = $1 WHERE lower("telegramUsername") = lower($2)`,
            [ctx.from.id, ctx.from.username]
        );
    }

    await setChatCommands(ctx, AGENCY_COMMANDS);
    return ctx.reply('Agency menu\n\n/new - post a new tutoring offer\n/help - list agency functions');
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
    // Default command list, shown to everyone who doesn't have a chat-specific list.
    bot.api.setMyCommands(TUTOR_COMMANDS).catch((err) => console.error('setMyCommands failed:', err));

    bot.command('start', async (ctx) => {
        if (isAdmin(ctx)) return showAdminMenu(ctx);

        // An agency that left or blocked the bot becomes active again here.
        await reactivateIfReturning(ctx.from!.id);

        const agency = await findAgencyByUsername(ctx.from?.username);
        if (agency) return showAgencyMenu(ctx);

        // This chat was an agency or parent before, so put back the tutor menu.
        await setChatCommands(ctx, TUTOR_COMMANDS);

        if (await isRegisteredTutor(ctx.from!.id)) {
            return ctx.reply('Welcome back to NextTutor. Send /menu to see your options.');
        }
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
        const agency = await findAgencyByUsername(ctx.from.username);
        if (agency) {
            await ctx.editMessageText(`Welcome, ${agency.name}.`);
            return showAgencyMenu(ctx);
        }

        await ctx.editMessageText('Registering your tutoring business.');
        return startBusinessSignup(ctx);
    });

    bot.callbackQuery('role:parent', async (ctx) => {
        await ctx.answerCallbackQuery();
        await setChatCommands(ctx, PARENT_COMMANDS);
        await ctx.editMessageText(
            'You are looking for a tutor.\n\nSend /post to start your request. ' +
            'Your contact is shared only with the agency that pays for your request.'
        );
    });
}