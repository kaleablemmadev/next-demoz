// src/admin-summary.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { ADMIN_USERNAME } from './admin.js';

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);
const SEND_HOUR = 8; // 08:00 Nairobi time
const CHECK_EVERY_MS = 10 * 60 * 1000;

async function buildSummary(): Promise<string> {
    const { rows } = await pool.query(`
        SELECT
          (SELECT count(*) FROM "ParentRequest" WHERE "createdAt" > now() - interval '24 hours')::int AS "newRequests",
          (SELECT count(*) FROM "ParentRequest" WHERE status = 'OPEN')::int AS unassigned,
          (SELECT count(*) FROM "Assignment" WHERE status = 'SENT')::int AS "waitingAccept",
          (SELECT count(*) FROM "Assignment" WHERE status = 'ACCEPTED')::int AS "waitingPayment",
          (SELECT count(*) FROM "Subscription" WHERE status = 'ACTIVE' AND "endsAt" < now() + interval '7 days')::int AS "endingSoon",
          (SELECT count(*) FROM "Organization" WHERE status = 'PENDING_APPROVAL')::int AS "signupsPending",
          (SELECT count(*) FROM "LeaveRequest" WHERE status = 'PENDING')::int AS "leavePending",
          (SELECT count(*) FROM "TutoringOffer" WHERE status = 'OPEN' AND "postFailures" >= 5)::int AS "failingOffers",
          (SELECT count(*) FROM "TutoringOffer" WHERE "postedAt" > now() - interval '24 hours')::int AS "offersToday"
    `);
    const s = rows[0];

    return [
        `NextTutor summary, ${new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Nairobi' })}`,
        '',
        'Parents',
        `• New requests (last 24 hours): ${s.newRequests}`,
        `• Requests with no agency yet: ${s.unassigned}`,
        '',
        'Agencies',
        `• Waiting to accept: ${s.waitingAccept}`,
        `• Accepted, waiting for payment: ${s.waitingPayment}`,
        `• Subscriptions ending in 7 days: ${s.endingSoon}`,
        `• Signups waiting for approval: ${s.signupsPending}`,
        `• Leave requests waiting: ${s.leavePending}`,
        '',
        'Offers',
        `• Posted in the last 24 hours: ${s.offersToday}`,
        `• Paused after failing to post: ${s.failingOffers}`,
    ].join('\n');
}

export function startAdminSummary(bot: Bot) {
    let lastSentOn = '';

    const check = async () => {
        if (!ADMIN_TELEGRAM_ID) return;
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Nairobi',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
        }).formatToParts(new Date());
        const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
        const today = `${get('year')}-${get('month')}-${get('day')}`;
        const hour = Number(get('hour'));

        if (hour !== SEND_HOUR || today === lastSentOn) return;
        lastSentOn = today;

        try {
            await bot.api.sendMessage(ADMIN_TELEGRAM_ID, await buildSummary());
        } catch (err) {
            lastSentOn = ''; // try again on the next check
            console.error('Could not send the daily summary:', err);
        }
    };

    check();
    setInterval(check, CHECK_EVERY_MS);
}

export function registerSummaryCommand(bot: Bot) {
    bot.command('summary', async (ctx, next) => {
        if (ctx.from?.username !== ADMIN_USERNAME) return next();
        await ctx.reply(await buildSummary());
    });
}