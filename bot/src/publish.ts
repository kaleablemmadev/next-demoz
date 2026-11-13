import { Bot } from 'grammy';
import { pool } from './db.js';
import { sendOfferAlerts, type Agency, type AlertOffer } from './alerts.js';

// Sends alerts for every open offer that hasn't been alerted yet.
export async function sendPendingAlerts(bot: Bot): Promise<void> {
    const { rows } = await pool.query(`
        SELECT t.id, t.title, t.subjects, t."gradeLevels", t."subCity",
               t."monthlySalaryEtb", t."sessionsPerWeek", t.status,
               o.name AS "agencyName", o."telegramUsername"
        FROM "TutoringOffer" t
                 JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t."alertedAt" IS NULL AND t.status = 'OPEN'
        ORDER BY t."postedAt" ASC
            LIMIT 20
    `);

    for (const r of rows) {
        const offer: AlertOffer = {
            id: r.id,
            title: r.title,
            subjects: r.subjects,
            gradeLevels: r.gradeLevels,
            subCity: r.subCity,
            monthlySalaryEtb: r.monthlySalaryEtb,
            sessionsPerWeek: r.sessionsPerWeek,
            status: r.status,
        };

        const agency: Agency = {
            name: r.agencyName,
            telegramUsername: r.telegramUsername,
        };

        const sent = await sendOfferAlerts(bot, offer, agency);

        // Mark as alerted even if nobody matched, so it's never re-sent.
        await pool.query(`UPDATE "TutoringOffer" SET "alertedAt" = now() WHERE id = $1`, [r.id]);

        console.log(`Offer ${r.id} (${r.title}): sent to ${sent} subscriber(s)`);
    }
}