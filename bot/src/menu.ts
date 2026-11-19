// src/menu.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { tutorLeaveKeyboard } from './leave.js';
import { resolveRole, showAgencyMenu, showParentMenu, showRolePicker, AGENCY_HELP, PARENT_HELP, setChatCommands, TUTOR_COMMANDS, AGENCY_COMMANDS, PARENT_COMMANDS } from './roles.js';
import { showAdminMenu, ADMIN_HELP, ADMIN_COMMANDS } from './admin.js';

const MENU_TEXT =
    'NextTutor menu\n\n' +
    '/search - find open offers by grade, area and gender\n' +
    '/settings - pause, resume or stop offer alerts\n' +
    '/gender - change your gender\n' +
    '/feedback - send feedback to NextTutor\n' +
    '/leave - delete your NextTutor account\n' +
    '/help - what each function does\n' +
    '/reset - erase all your data and start again\n\n' +
    'Tap a button below, or type a command.';

const HELP_TEXT =
    'NextTutor functions\n\n' +
    '/start - Register as a tutor. Choose your area, grades, gender and minimum salary.\n' +
    '/menu - Show the main menu.\n' +
    '/search - Search open offers. Pick grades, areas and gender, then tap Show offers. Multi-select works, and All selects every option.\n' +
    '/settings - Pause, resume or stop offer alerts.\n' +
    '/gender - Change your gender. This affects which offers match you.\n' +
    '/feedback - Send feedback to the NextTutor team.\n' +
    '/leave - Delete your NextTutor account and personal data.\n' +
    '/reset - Erase all your data, including grades, area, gender, settings and sent offers. Then you can register again.\n' +
    '/help - Show this list.\n\n' +
    'You get an alert when a new offer matches you, and a list of matching offers every Monday morning.';

function menuKeyboard() {
    return new InlineKeyboard()
        .text('🔎 Search offers', 'menu:search')
        .text('⚙️ Settings', 'menu:settings')
        .row()
        .text('🗑 Reset my data', 'menu:reset')
        .text('❓ Help', 'menu:help');
}

function resetQuestion() {
    return new InlineKeyboard().text('Yes, erase everything', 'reset:yes').row().text('Cancel', 'reset:no');
}

export function registerMenuHandlers(bot: Bot) {
    bot.command('menu', async (ctx) => {
        const role = await resolveRole(ctx);
        if (role === 'admin') return showAdminMenu(ctx);
        if (role === 'agency') return showAgencyMenu(ctx);
        if (role === 'parent') return showParentMenu(ctx);
        if (role === 'tutor') {
            await setChatCommands(ctx, TUTOR_COMMANDS);
            return ctx.reply(MENU_TEXT, { reply_markup: menuKeyboard() });
        }
        return showRolePicker(ctx);
    });

    bot.command('help', async (ctx) => {
        const role = await resolveRole(ctx);
        if (role === 'admin') { await setChatCommands(ctx, ADMIN_COMMANDS); return ctx.reply(ADMIN_HELP); }
        if (role === 'agency') { await setChatCommands(ctx, AGENCY_COMMANDS); return ctx.reply(AGENCY_HELP); }
        if (role === 'parent') { await setChatCommands(ctx, PARENT_COMMANDS); return ctx.reply(PARENT_HELP); }
        if (role === 'tutor') { await setChatCommands(ctx, TUTOR_COMMANDS); return ctx.reply(HELP_TEXT); }
        return showRolePicker(ctx);
    });

    bot.callbackQuery('menu:help', async (ctx) => {
        await ctx.answerCallbackQuery();
        const role = await resolveRole(ctx);
        if (role === 'admin') return ctx.reply(ADMIN_HELP);
        if (role === 'agency') return ctx.reply(AGENCY_HELP);
        if (role === 'parent') return ctx.reply(PARENT_HELP);
        return ctx.reply(HELP_TEXT);
    });

    const askReset = async (ctx: Context) => {
        if ((await resolveRole(ctx)) !== 'tutor') {
            return ctx.reply('Only registered tutors can erase tutor alert data from this menu.');
        }
        return ctx.reply(
            'This erases everything the bot knows about you: your grades, area, gender, alert settings and the offers already sent to you. Are you sure?',
            { reply_markup: resetQuestion() }
        );
    };

    bot.command('reset', askReset);

    bot.callbackQuery('menu:reset', async (ctx) => {
        await ctx.answerCallbackQuery();
        await askReset(ctx);
    });

    bot.callbackQuery('reset:no', async (ctx) => {
        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        await ctx.editMessageText('Cancelled. Your data is unchanged.');
    });

    bot.callbackQuery('reset:yes', async (ctx) => {
        if ((await resolveRole(ctx)) !== 'tutor') {
            await ctx.answerCallbackQuery({ text: 'This action is only available to registered tutors.', show_alert: true });
            return;
        }
        const id = ctx.from.id;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: accountRows } = await client.query<{ auditRef: string }>(
                `SELECT "auditRef" FROM "TelegramSubscriber" WHERE "telegramId" = $1 FOR UPDATE`,
                [id],
            );
            if (accountRows[0]) {
                await client.query(
                    `INSERT INTO "AuditEvent" ("actorRef", "actorType", action, "entityType")
                     VALUES ($1, 'TUTOR', 'ACCOUNT_RESET', 'TUTOR')`,
                    [accountRows[0].auditRef],
                );
            }
            await client.query(
                `DELETE FROM "OfferDelivery" WHERE "subscriberId" IN (SELECT id FROM "TelegramSubscriber" WHERE "telegramId" = $1)`,
                [id]
            );
            await client.query(
                `DELETE FROM "NotificationPreference" WHERE "subscriberId" IN (SELECT id FROM "TelegramSubscriber" WHERE "telegramId" = $1)`,
                [id]
            );
            await client.query(`DELETE FROM "TelegramSubscriber" WHERE "telegramId" = $1`, [id]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        await ctx.answerCallbackQuery();
        await ctx.editMessageText('All your data has been erased.');
        await ctx.reply('Before you go, why are you leaving NextTutor? This helps us improve the app.', {
            reply_markup: tutorLeaveKeyboard(),
        });
    });

    bot.callbackQuery('start:new', async (ctx) => {
        await ctx.answerCallbackQuery();
        await showRolePicker(ctx);
    });
}