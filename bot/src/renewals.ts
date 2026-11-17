// src/renewals.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { ADMIN_USERNAME } from './admin.js';

const REMIND_DAYS = 3;                 // warn this many days before the end
const CHECK_EVERY_MS = 60 * 60 * 1000; // once an hour

async function notify(bot: Bot, agencyUserId: string | null, text: string): Promise<boolean> {
    if (!agencyUserId) return false;
    try {
        await bot.api.sendMessage(Number(agencyUserId), text);
        return true;
    } catch (err) {
        console.error('Could not send renewal notice:', err);
        return false;
    }
}

async function tick(bot: Bot) {
    // 1. Subscriptions whose time is up: mark them expired and tell the agency.
    const { rows: expired } = await pool.query<{ id: string; agencyUserId: string | null }>(
        `UPDATE "Subscription" s SET status = 'EXPIRED'
         WHERE s.status = 'ACTIVE' AND s."endsAt" <= now()
         RETURNING s.id,
                   (SELECT o."telegramUserId"::text FROM "Organization" o WHERE o.id = s."organizationId") AS "agencyUserId"`
    );
    for (const e of expired) {
        await notify(
            bot,
            e.agencyUserId,
            `Your NextTutor subscription has ended, so you will not receive new requests until you renew. ` +
            `To renew, contact @${ADMIN_USERNAME}.`
        );
    }

    // 2. Subscriptions ending soon: warn the agency once.
    const { rows: soon } = await pool.query<{ id: string; agencyUserId: string | null; endsAt: Date }>(
        `SELECT s.id, s."endsAt",
                (SELECT o."telegramUserId"::text FROM "Organization" o WHERE o.id = s."organizationId") AS "agencyUserId"
         FROM "Subscription" s
         WHERE s.status = 'ACTIVE'
           AND s."endsAt" > now()
           AND s."endsAt" <= now() + make_interval(days => $1::int)
           AND s."reminderSentAt" IS NULL`,
        [REMIND_DAYS]
    );
    for (const s of soon) {
        const ok = await notify(
            bot,
            s.agencyUserId,
            `Your NextTutor subscription ends on ${s.endsAt.toLocaleDateString('en-GB')}. ` +
            `To renew, contact @${ADMIN_USERNAME}.`
        );
        // Only mark the reminder as sent if it was delivered, so a failed send is retried.
        if (ok) {
            await pool.query(`UPDATE "Subscription" SET "reminderSentAt" = now() WHERE id = $1`, [s.id]);
        }
    }
}

// Runs once at start, then every hour.
export function startRenewalReminders(bot: Bot) {
    let running = false;

    const run = async () => {
        if (running) return;
        running = true;
        try {
            await tick(bot);
        } catch (err) {
            console.error('Renewal check failed:', err);
        } finally {
            running = false;
        }
    };

    run();
    setInterval(run, CHECK_EVERY_MS);
}