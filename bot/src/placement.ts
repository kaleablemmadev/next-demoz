// src/placement.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { ADMIN_USERNAME } from './admin.js';

const OWNER_SHARE = 0.65;   // your share of the commission
// The agency's share is the rest, so the two always add up to the commission.

export function registerPlacementHandlers(bot: Bot) {
    bot.command('placed', async (ctx, next) => {
        if (ctx.from?.username !== ADMIN_USERNAME) return next();

        const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
        if (parts.length !== 3) {
            await ctx.reply(
                'Usage: /placed <id> <first salary ETB> <commission %>\n' +
                'Example: /placed 3f2a9c1e-... 2500 75'
            );
            return;
        }

        const [id, salaryRaw, pctRaw] = parts;
        const salary = Number(salaryRaw);
        const pct = Number(pctRaw);

        if (!Number.isInteger(salary) || salary <= 0) {
            await ctx.reply('The first salary must be a whole number above 0.');
            return;
        }
        if (!Number.isInteger(pct) || pct < 50 || pct > 100) {
            await ctx.reply('The commission must be a whole number from 50 to 100.');
            return;
        }

        const commission = Math.round((salary * pct) / 100);
        const ownerShare = Math.round(commission * OWNER_SHARE);
        const agencyShare = commission - ownerShare;

        let rows: { agencyUserId: string | null; agencyName: string }[];
        try {
            ({ rows } = await pool.query(
                `UPDATE "Assignment" a
                 SET status = 'PLACED',
                     "placedAt" = now(),
                     "tutorFirstSalaryEtb" = $2,
                     "commissionPct" = $3,
                     "commissionEtb" = $4,
                     "ownerShareEtb" = $5,
                     "agencyShareEtb" = $6
                 FROM "Organization" o
                 WHERE a.id = $1
                   AND a.status = 'PAID'
                   AND o.id = a."organizationId"
                 RETURNING o."telegramUserId"::text AS "agencyUserId", o.name AS "agencyName"`,
                [id, salary, pct, commission, ownerShare, agencyShare]
            ));
        } catch {
            await ctx.reply('That id is not valid.');
            return;
        }

        if (rows.length === 0) {
            await ctx.reply('No paid request with that id. Confirm payment with /paid first.');
            return;
        }

        const a = rows[0];
        const fmt = (n: number) => `${n.toLocaleString()} ETB`;

        await ctx.reply(
            `Recorded for ${a.agencyName}.\n` +
            `First salary: ${fmt(salary)}\n` +
            `Commission (${pct}%): ${fmt(commission)}\n` +
            `Your share (65%): ${fmt(ownerShare)}\n` +
            `Agency share (35%): ${fmt(agencyShare)}`
        );

        if (a.agencyUserId) {
            try {
                await bot.api.sendMessage(
                    Number(a.agencyUserId),
                    `Placement recorded.\n\n` +
                    `Tutor's first salary: ${fmt(salary)}\n` +
                    `Your share: ${fmt(agencyShare)}`
                );
            } catch (err) {
                console.error('Could not send placement notice:', err);
            }
        }
    });
}