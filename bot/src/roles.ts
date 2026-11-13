import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { isAdmin, showAdminMenu } from './admin.js';
import { startBusinessSignup } from './signup.js';

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

export const AGENCY_HELP =
    'NextTutor agency functions\n\n' +
    '/new - Post a new tutoring offer. You choose subjects, grades, sub-city, optional location, sessions, pay, optional hours, gender and optional requirements. Then you review and post.\n' +
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

// Shows the agency menu, saves the agency's Telegram ID so the bot can message them,
// and makes this chat's command list the agency one.
export async function showAgencyMenu(ctx: Context) {
    if (ctx.from?.username) {
        await pool.query(
            `UPDATE "Organization" SET "telegramUserId" = $1 WHERE lower("telegramUsername") = lower($2)`,
            [ctx.from.id, ctx.from.username]
        );
    }

    await ctx.api.setMyCommands(AGENCY_COMMANDS, {
        scope: { type: 'chat', chat_id: ctx.chat!.id },
    });
    return ctx.reply('Agency menu\n\n/new - post a new tutoring offer\n/help - list agency functions');
}

export async function showRolePicker(ctx: Context, source = 'direct') {
    return ctx.reply('Welcome to NextTutor. Who are you?', {
        reply_markup: new InlineKeyboard()
            .text('I am a tutor', `role:tutor:${source}`)
            .row()
            .text('I am a tutoring business', 'role:business'),
    });
}

export function registerRoleHandlers(
    bot: Bot,
    startTutorOnboarding: (ctx: Context, source: string) => Promise<unknown>
) {
    // Default command list, shown to everyone who doesn't have a chat-specific list.
    bot.api.setMyCommands(TUTOR_COMMANDS).catch((err) => console.error('setMyCommands failed:', err));

    bot.command('start', async (ctx) => {
        if (isAdmin(ctx)) return showAdminMenu(ctx);

        const agency = await findAgencyByUsername(ctx.from?.username);
        if (agency) return showAgencyMenu(ctx);
        return showRolePicker(ctx, ctx.match?.toString().trim() || 'direct');
    });

    bot.callbackQuery(/^role:tutor:(.*)$/, async (ctx) => {
        const source = ctx.match[1] || 'direct';
        await ctx.answerCallbackQuery();
        await ctx.editMessageText('You are registering as a tutor.');
        await startTutorOnboarding(ctx, source);
    });

    bot.callbackQuery('role:business', async (ctx) => {
        await ctx.answerCallbackQuery();

        const agency = await findAgencyByUsername(ctx.from.username);
        if (agency) {
            await ctx.editMessageText(`Welcome, ${agency.name}.`);
            return showAgencyMenu(ctx);
        }

        await ctx.editMessageText('Registering your tutoring business.');
        return startBusinessSignup(ctx);
    });
}