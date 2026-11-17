// src/payments.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { ADMIN_USERNAME } from './admin.js';

const PAY_DAYS = 3;

export function registerPaymentHandlers(bot: Bot) {
    bot.command('paid', async (ctx, next) => {
        if (ctx.from?.username !== ADMIN_USERNAME) return next();

        const id = (ctx.match ?? '').trim();

        // "/paid" with no id: list accepted requests waiting for payment.
        if (!id) {
            const { rows } = await pool.query<{
                id: string;
                agencyName: string;
                subject: string;
                subCity: string;
            }>(
                `SELECT a.id, o.name AS "agencyName", r.subject, r."subCity"
                 FROM "Assignment" a
                 JOIN "Organization" o ON o.id = a."organizationId"
                 JOIN "ParentRequest" r ON r.id = a."requestId"
                 WHERE a.status = 'ACCEPTED'
                   AND a."acceptedAt" > now() - make_interval(days => $1::int)
                 ORDER BY a."acceptedAt" ASC`,
                [PAY_DAYS]
            );
            if (rows.length === 0) {
                await ctx.reply('No accepted requests are waiting for payment.');
                return;
            }
            const lines = rows.map((r) => `${r.id}\n  ${r.agencyName}, ${r.subject}, ${r.subCity}`);
            await ctx.reply(['Waiting for payment:', '', ...lines, '', 'To confirm: /paid <id>'].join('\n'));
            return;
        }

        // "/paid <id>": confirm payment and send the parent's contact to that agency only.
        let rows: { agencyUserId: string | null; agencyName: string; contactHandle: string | null }[];
        try {
            ({ rows } = await pool.query(
                `UPDATE "Assignment" a SET status = 'PAID', "paidAt" = now()
                 FROM "Organization" o, "ParentRequest" r
                 WHERE a.id = $1
                   AND a.status = 'ACCEPTED'
                   AND a."acceptedAt" > now() - make_interval(days => $2::int)
                   AND o.id = a."organizationId"
                   AND r.id = a."requestId"
                 RETURNING o."telegramUserId"::text AS "agencyUserId",
                           o.name AS "agencyName",
                           (SELECT p."contactHandle" FROM "Parent" p WHERE p.id = r."parentId") AS "contactHandle"`,
                [id, PAY_DAYS]
            ));
        } catch {
            await ctx.reply('That id is not valid.');
            return;
        }

        if (rows.length === 0) {
            await ctx.reply('No accepted request with that id. It may have expired or already been paid.');
            return;
        }

        const p = rows[0];
        const contact = p.contactHandle ?? 'no contact on file';

        if (!p.agencyUserId) {
            await ctx.reply(`Marked paid, but ${p.agencyName} has no Telegram user id on file. Contact was not sent.`);
            return;
        }

        try {
            await bot.api.sendMessage(
                Number(p.agencyUserId),
                `Payment confirmed for this request.\n\nParent contact: ${contact}\n\n` +
                `Please reach the parent and tell us the tutor's first salary when the tutor is placed.`
            );
            await ctx.reply(`Marked paid. Contact sent to ${p.agencyName}.`);
        } catch (err) {
            console.error('Could not send parent contact:', err);
            await ctx.reply(`Marked paid, but the message to ${p.agencyName} failed. Send the contact manually: ${contact}`);
        }
    });
}