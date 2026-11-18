// src/supply.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { GRADES } from './curriculum.js';
import { findAgencyByUsername } from './roles.js';

// Shows agencies how many active tutors are registered for each grade. Counts only, no tutor details.
export function registerSupplyHandlers(bot: Bot) {
    bot.command('supply', async (ctx) => {
        const agency = await findAgencyByUsername(ctx.from?.username);
        if (!agency) return ctx.reply('This command is for registered tutoring businesses.');

        const { rows: byGrade } = await pool.query<{ grade: string; n: string }>(
            `SELECT g AS grade, count(*)::text AS n
             FROM "TelegramSubscriber" s, unnest(s.grades) AS g
             WHERE s.status = 'ACTIVE' AND s."subCity" IS NOT NULL
             GROUP BY g`
        );
        const { rows: total } = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "TelegramSubscriber"
             WHERE status = 'ACTIVE' AND "subCity" IS NOT NULL`
        );

        const counts = new Map(byGrade.map((r) => [r.grade, Number(r.n)]));
        const lines = GRADES.map((g) => `${g}: ${counts.get(g) ?? 0}`);

        return ctx.reply(
            [
                `Active tutors registered with NextTutor: ${total[0].n}`,
                'Tutors by grade (a tutor can teach more than one grade):',
                ...lines,
                '',
                'Use this to set realistic pay. Only counts are shown, never tutor details.',
            ].join('\n')
        );
    });
}
