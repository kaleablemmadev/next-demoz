import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { pool } from './db.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { askSubjects, registerSubjectHandlers } from './subjects.js';
import { registerGradeHandlers } from './grades.js';
import {registerSalaryHandlers} from "./salary";
import { registerOfferHandlers } from './offers.js';
import { sendPendingAlerts } from './publish.js';
import { startDigestScheduler } from './digest.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set.');

const bot = new Bot(token);

// /start, optionally with the channel that sent them: t.me/NextTutorBot?start=channelname
bot.command('start', async (ctx) => {
    const source = ctx.match?.trim() || 'direct';
    const from = ctx.from!;

    // Save the subscriber, or do nothing if they already exist.
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
});

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

bot.catch((err) => console.error('Bot error:', err.error));

console.log('Bot is running. Press Ctrl+C to stop.');
registerSubjectHandlers(bot);
registerGradeHandlers(bot);
registerSalaryHandlers(bot);
registerOfferHandlers(bot);
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
bot.start();