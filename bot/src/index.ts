import 'dotenv/config';
import http from 'node:http';
import type { Context } from 'grammy';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import { pool } from './db.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { askSubjects, registerSubjectHandlers } from './subjects.js';
import { registerGradeHandlers } from './grades.js';
import { registerSalaryHandlers } from './salary.js';
import { registerOfferHandlers } from './offers.js';
import { sendPendingAlerts } from './publish.js';
import { startDigestScheduler } from './digest.js';
import { registerAgencyHandlers } from './agency.js';
import { registerSettingsHandlers } from './settings.js';
import { registerGenderHandlers } from './gender.js';
import { registerMenuHandlers } from './menu.js';
import { registerSearchHandlers } from './search.js';
import { registerRepostHandlers, startRepostScheduler } from './reposts.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const publicUrl = process.env.PUBLIC_URL;             // e.g. https://nextdemoz-bot.onrender.com
const pathSecret = process.env.WEBHOOK_PATH_SECRET;   // random string, part of the URL
const tokenSecret = process.env.WEBHOOK_TOKEN_SECRET; // random string, checked on every request

if (!token || !publicUrl || !pathSecret || !tokenSecret) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN, PUBLIC_URL, WEBHOOK_PATH_SECRET or WEBHOOK_TOKEN_SECRET.');
}

const bot = new Bot(token);

// Setup helper: prints the ID of every chat the bot sees, so you can copy it into the Organization table.
bot.use(async (ctx, next) => {
    if (ctx.chat) {
        console.log(`Chat ${ctx.chat.id} (${ctx.chat.type}): ${ctx.chat.title ?? ctx.chat.username ?? 'private'}`);
    }
    await next();
});

// /start, optionally with the channel that sent them: t.me/NextTutorBot?start=channelname
// Also used by the Start button after a reset, so it must work without a /start message.
async function startOnboarding(ctx: Context) {
    const source = ctx.match?.toString().trim() || 'direct';
    const from = ctx.from!;

    await pool.query(
        `INSERT INTO "TelegramSubscriber" ("telegramId", "firstName", "username", "sourceChannel")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("telegramId") DO NOTHING`,
        [from.id, from.first_name ?? null, from.username ?? null, source]
    );

    const keyboard = new InlineKeyboard();
    KNOWN_SUB_CITIES.forEach((city, i) => {
        keyboard.text(city, `area:${city}`);
        if (i % 2 === 1) keyboard.row();
    });

    await ctx.reply('Welcome to NextTutor alerts. Which sub-city do you teach in?', {
        reply_markup: keyboard,
    });
}

bot.command('start', startOnboarding);

// The tutor tapped a sub-city.
bot.callbackQuery(/^area:(.+)$/, async (ctx) => {
    const subCity = ctx.match[1];

    await pool.query(
        `UPDATE "TelegramSubscriber" SET "subCity" = $1 WHERE "telegramId" = $2`,
        [subCity, ctx.from.id]
    );

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Saved: ${subCity}.`);
    await askSubjects(ctx);
});

registerSubjectHandlers(bot);
registerGradeHandlers(bot);
registerSalaryHandlers(bot);
registerOfferHandlers(bot);
registerAgencyHandlers(bot);
registerSettingsHandlers(bot);
registerRepostHandlers(bot);
registerGenderHandlers(bot);
registerSearchHandlers(bot);
registerMenuHandlers(bot, startOnboarding);

bot.catch((err) => console.error('Bot error:', err.error));

// Checks for new offers every 30 seconds, skipping a check if the last one is still running.
let checking = false;
setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
        await sendPendingAlerts(bot);
    } catch (err) {
        console.error('Alert check failed:', err);
    } finally {
        checking = false;
    }
}, 30_000);

startDigestScheduler(bot);
startRepostScheduler(bot);

// Telegram sends each message here. Only requests with the right path and token are handled.
const handleUpdate = webhookCallback(bot, 'http', { secretToken: tokenSecret });
const webhookPath = `/webhook/${pathSecret}`;
const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    if (req.method === 'POST' && req.url === webhookPath) {
        handleUpdate(req, res);
        return;
    }

    res.writeHead(404);
    res.end();
});

server.listen(port, () => {
    console.log(`Listening on port ${port}`);

    bot.api
        .setWebhook(`${publicUrl}${webhookPath}`, { secret_token: tokenSecret })
        .then(() => console.log('Webhook set.'))
        .catch((err) => console.error('Could not set webhook:', err));
});