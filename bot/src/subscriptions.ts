// src/subscriptions.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { ADMIN_USERNAME } from './admin.js';

const DAYS = 30;
const PRICES: Record<string, { plan: 'NORMAL' | 'PREMIUM'; priceEtb: number }> = {
    normal: { plan: 'NORMAL', priceEtb: 2500 },
    premium: { plan: 'PREMIUM', priceEtb: 4000 },
};

export function registerSubscriptionHandlers(bot: Bot) {
    bot.command('subscribe', async (ctx, next) => {
        if (ctx.from?.username !== ADMIN_USERNAME) return next();

        const [rawUser, rawPlan] = (ctx.match ?? '').trim().split(/\s+/);
        const choice = PRICES[(rawPlan ?? '').toLowerCase()];
        if (!rawUser || !choice) {
            await ctx.reply(
                'Usage: /subscribe <agency owner username> <normal|premium>\n' +
                'Example: /subscribe @agencyowner premium'
            );
            return;
        }
        const handle = rawUser.replace(/^@/, '');

        const client = await pool.connect();
        let created: { orgName: string; endsAt: Date } | null = null;
        try {
            await client.query('BEGIN');

            const { rows: orgs } = await client.query<{ id: string; name: string }>(
                `SELECT id, name FROM "Organization"
                 WHERE LOWER("telegramUsername") = LOWER($1) AND status = 'ACTIVE'`,
                [handle]
            );
            if (orgs.length === 0) {
                await client.query('ROLLBACK');
                await ctx.reply(`No active agency has the username @${handle}.`);
                return;
            }
            if (orgs.length > 1) {
                await client.query('ROLLBACK');
                await ctx.reply(`More than one agency has the username @${handle}. Check the records.`);
                return;
            }
            const org = orgs[0];

            // A new subscription replaces any active one, so the premium count starts again.
            await client.query(
                `UPDATE "Subscription" SET status = 'EXPIRED'
                 WHERE "organizationId" = $1 AND status = 'ACTIVE'`,
                [org.id]
            );

            const { rows } = await client.query<{ endsAt: Date }>(
                `INSERT INTO "Subscription"
                    (id, "organizationId", plan, "priceEtb", "paidAt", "startsAt", "endsAt", "premiumUsed", status)
                 VALUES (gen_random_uuid()::text, $1, $2, $3, now(), now(), now() + make_interval(days => $4::int), 0, 'ACTIVE')
                 RETURNING "endsAt"`,
                [org.id, choice.plan, choice.priceEtb, DAYS]
            );

            await client.query('COMMIT');
            created = { orgName: org.name, endsAt: rows[0].endsAt };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            console.error('Subscribe failed:', err);
        } finally {
            client.release();
        }

        // Reply only after the transaction is settled, so a reply error cannot misreport the result.
        if (created) {
            await ctx.reply(
                `Subscribed ${created.orgName} to ${choice.plan} for ${DAYS} days.\n` +
                `Price: ${choice.priceEtb.toLocaleString()} ETB\n` +
                `Ends: ${created.endsAt.toLocaleDateString('en-GB')}\n\n` +
                `Collect the payment manually, as agreed.`
            );
        } else {
            await ctx.reply('Could not create the subscription. Nothing was changed.');
        }
    });
}