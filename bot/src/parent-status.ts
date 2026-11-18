// src/parent-status.ts

import { Bot } from 'grammy';
import { pool } from './db.js';

type Row = {
    id: string;
    gradeLevel: string;
    subCity: string;
    createdAt: Date;
    status: string;
    lastAssignment: string | null;
};

// What a parent sees, based on the request and the agency's latest response.
function describe(r: Row): string {
    if (r.status === 'CLOSED') return 'Closed';
    if (r.status === 'PLACED' || r.lastAssignment === 'PLACED') return 'A tutor was placed';
    if (r.lastAssignment === 'PAID') return 'An agency is arranging a tutor for you';
    if (r.lastAssignment === 'ACCEPTED') return 'An agency accepted your request and is arranging payment';
    if (r.lastAssignment === 'SENT') return 'Sent to an agency, waiting for a reply';
    if (r.status === 'ASSIGNED') return 'Waiting for the next agency';
    return 'Waiting for an agency';
}

export function registerParentStatusHandlers(bot: Bot) {
    bot.command('myrequests', async (ctx) => {
        const { rows } = await pool.query<Row>(
            `SELECT r.id, r."gradeLevel", r."subCity", r."createdAt", r.status,
                    (SELECT a.status FROM "Assignment" a
                     WHERE a."requestId" = r.id ORDER BY a."sentAt" DESC LIMIT 1) AS "lastAssignment"
             FROM "ParentRequest" r
             JOIN "Parent" p ON p.id = r."parentId"
             WHERE p."telegramId" = $1
             ORDER BY r."createdAt" DESC
             LIMIT 10`,
            [ctx.from!.id]
        );

        if (rows.length === 0) {
            return ctx.reply('You have no requests yet. Send /post to ask for a tutor.');
        }

        const lines = rows.map((r) => {
            const date = new Date(r.createdAt).toLocaleDateString('en-GB', { timeZone: 'Africa/Nairobi' });
            return `${date} · ${r.gradeLevel}, ${r.subCity}\n${describe(r)}`;
        });
        return ctx.reply(['Your recent requests:', '', ...lines].join('\n\n'));
    });
}
