import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { tutorLeaveKeyboard } from './leave.js';
import { isAgency, showAgencyMenu, showRolePicker, AGENCY_HELP } from './roles.js';

const MENU_TEXT =
    'NextTutor menu\n\n' +
    '/search - find open offers by subject, grade, area and gender\n' +
    '/settings - pause, resume or stop offer alerts\n' +
    '/help - what each function does\n' +
    '/reset - erase all your data and start again\n\n' +
    'Tap a button below, or type a command.';

const HELP_TEXT =
    'NextTutor functions\n\n' +
    '/start - Register as a tutor. Choose your area, subjects, grades, gender and minimum salary.\n' +
    '/menu - Show the main menu.\n' +
    '/search - Search open offers. Pick subjects, grades, areas and gender, then tap Show offers. Multi-select works, and All selects every option.\n' +
    '/settings - Pause, resume or stop offer alerts.\n' +
    '/gender - Change your gender. This affects which offers match you.\n' +
    '/reset - Erase all your data, including subjects, grades, area, gender, settings and sent offers. Then you can register again.\n' +
    '/help - Show this list.\n\n' +
    'You get an alert when a new offer matches you, and a list of matching offers every Monday morning.';

function menuKeyboard() {
    return new InlineKeyboard().text('🗑 Reset my data', 'menu:reset').row().text('❓ Help', 'menu:help');
}

function resetQuestion() {
    return new InlineKeyboard().text('Yes, erase everything', 'reset:yes').row().text('Cancel', 'reset:no');
}

export function registerMenuHandlers(bot: Bot) {
    bot.command('menu', async (ctx) => {
        if (await isAgency(ctx)) return showAgencyMenu(ctx);
        return ctx.reply(MENU_TEXT, { reply_markup: menuKeyboard() });
    });

    bot.command('help', async (ctx) => {
        await ctx.reply((await isAgency(ctx)) ? AGENCY_HELP : HELP_TEXT);
    });

    bot.callbackQuery('menu:help', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.reply(HELP_TEXT);
    });

    const askReset = async (ctx: Context) => {
        if (await isAgency(ctx)) {
            return ctx.reply('Agency accounts have no tutor data to erase.');
        }
        return ctx.reply(
            'This erases everything the bot knows about you: your subjects, grades, area, gender, alert settings and the offers already sent to you. Are you sure?',
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
        const id = ctx.from.id;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
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