// src/index.ts

import 'dotenv/config';
import http from 'node:http';
import { Bot, webhookCallback } from 'grammy';
import { registerOnboardingHandlers, startTutorOnboarding } from './onboarding.js';
import { registerGradeHandlers } from './grades.js';
import { registerSalaryHandlers } from './salary.js';
import { registerOfferHandlers } from './offers.js';
import { sendPendingAlerts } from './publish.js';
import { startDigestScheduler } from './digest.js';
import { registerPlacementHandlers } from './placement.js';
import { registerAgencyHandlers } from './agency.js';
import { startParentRouter, registerRoutingHandlers } from './routing.js';
import { registerSettingsHandlers } from './settings.js';
import { registerGenderHandlers } from './gender.js';
import { registerPaymentHandlers } from './payments.js';
import { registerMenuHandlers } from './menu.js';
import { registerParentHandlers } from './parent.js';
import { registerAdminHandlers } from './admin.js';
import { registerSignupHandlers } from './signup.js';
import { registerRoleHandlers } from './roles.js';
import { registerLeaveHandlers } from './leave.js';
import { registerSubscriptionHandlers } from './subscriptions.js';
import { registerAgencyLifecycle } from './agency-lifecycle.js';
import { registerSearchHandlers } from './search.js';
import { registerGenderSettingsHandlers } from './gender-settings.js';
import { registerRepostHandlers, startRepostScheduler } from './reposts.js';
import { startRenewalReminders } from './renewals.js';
import { sendOfferReports } from './offer-report.js';
import { startAdminSummary, registerSummaryCommand } from './admin-summary.js';
import { UserUpdateCoordinator } from './update-coordinator.js';
import { registerParentStatusHandlers } from './parent-status.js';
import { registerSupplyHandlers } from './supply.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const publicUrl = process.env.PUBLIC_URL;             // e.g. https://nextdemoz-bot.onrender.com
const pathSecret = process.env.WEBHOOK_PATH_SECRET;   // random string, part of the URL
const tokenSecret = process.env.WEBHOOK_TOKEN_SECRET; // random string, checked on every request

if (!token || !publicUrl || !pathSecret || !tokenSecret) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN, PUBLIC_URL, WEBHOOK_PATH_SECRET or WEBHOOK_TOKEN_SECRET.');
}

const bot = new Bot(token);

// A user's updates must not mutate their conversation concurrently. In particular,
// a second role-selection callback must not start another onboarding flow while the
// first role-selection callback is still creating the account and sending its prompt.
// Other users remain fully concurrent. Messages are serialized; overlapping button
// callbacks are acknowledged and dropped rather than replayed against a stale screen.
const updateCoordinator = new UserUpdateCoordinator();

bot.use(async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (telegramId === undefined) return next();

    const startedAt = Date.now();
    const updateType = ctx.callbackQuery
        ? 'callback'
        : ctx.message
            ? 'message'
            : ctx.update.my_chat_member
                ? 'my_chat_member'
                : 'other';

    const outcome = await updateCoordinator.run(
        telegramId,
        Boolean(ctx.callbackQuery),
        async () => {
            try {
                await ctx.answerCallbackQuery({
                    text: 'Another action is still processing. Please wait.',
                });
            } catch (err) {
                console.warn('Could not acknowledge overlapping callback:', err);
            }
        },
        next,
    );

    if (outcome.status === 'busy') {
        console.warn(
            `Dropped overlapping callback: user=${telegramId} update=${ctx.update.update_id} data=${ctx.callbackQuery?.data ?? 'unknown'}`,
        );
        return;
    }

    const durationMs = Date.now() - startedAt;
    if (durationMs >= 1500) {
        console.warn(
            `Slow Telegram update: type=${updateType} user=${telegramId} update=${ctx.update.update_id} durationMs=${durationMs}`,
        );
    }
});

// Setup helper: prints the ID of every chat the bot sees, so you can copy it into the Organization table.
bot.use(async (ctx, next) => {
    if (ctx.chat) {
        console.log(`Chat ${ctx.chat.id} (${ctx.chat.type}): ${ctx.chat.title ?? ctx.chat.username ?? 'private'}`);
    }
    await next();
});

registerOnboardingHandlers(bot);

bot.on('callback_query:data', (ctx, next) => { console.log('Button pressed:', ctx.callbackQuery.data); return next(); });

registerAdminHandlers(bot);
registerAgencyLifecycle(bot);
registerSignupHandlers(bot);
registerGradeHandlers(bot);
registerPlacementHandlers(bot);
registerSalaryHandlers(bot);
registerOfferHandlers(bot);
registerSubscriptionHandlers(bot);
registerPaymentHandlers(bot);
registerAgencyHandlers(bot);
registerSummaryCommand(bot);
registerSupplyHandlers(bot);
registerParentStatusHandlers(bot);
registerParentHandlers(bot);
registerSettingsHandlers(bot);
registerRepostHandlers(bot);
registerGenderHandlers(bot);
registerSearchHandlers(bot);
registerRoleHandlers(bot, startTutorOnboarding);
registerMenuHandlers(bot);
registerRoutingHandlers(bot);
registerLeaveHandlers(bot);
registerGenderSettingsHandlers(bot);

bot.catch(async (err) => {
    const { ctx, error } = err;
    console.error(
        `Bot handler failed: update=${ctx.update.update_id} user=${ctx.from?.id ?? 'unknown'}`,
        error,
    );

    // Make a failed callback stop spinning, even when its handler failed before
    // acknowledging it. Telegram may reject this if it was already answered.
    if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({
            text: 'Something went wrong. Please try again.',
        }).catch(() => undefined);
    }

    // Do not send unsolicited error messages into groups/channels.
    if (ctx.chat?.type === 'private' && ctx.from) {
        await ctx.reply(
            'I could not complete that action. Your previous step may not have been saved. Please try again or send /start.',
        ).catch((replyError) => {
            console.error('Could not send the user-facing error message:', replyError);
        });
    }
});

// Checks for new offers every 30 seconds, skipping a check if the last one is still running.
let checking = false;
setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
        await sendPendingAlerts(bot);
        await sendOfferReports(bot);
    } catch (err) {
        console.error('Alert check failed:', err);
    } finally {
        checking = false;
    }
}, 30_000);

startDigestScheduler(bot);
startRepostScheduler(bot);
startAdminSummary(bot);
startParentRouter(bot);
startRenewalReminders(bot);

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
