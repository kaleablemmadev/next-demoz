import { Bot } from 'grammy';
import { pool } from './db.js';
import { sendOfferAlerts, type Agency } from './alerts.js';
import type { Offer } from '../../shared/types/offer.js';

// Sends alerts for every open offer that hasn't been alerted yet.
// Any source that adds an offer to TutoringOffer gets alerts this way.
export async function sendPendingAlerts(bot: Bot): Promise<void> {
    const { rows } = await pool.query(`
        SELECT t.id, t.title, t.subject, t."gradeLevel", t.city, t."subCity",
               t."monthlySalaryEtb", t."sessionsPerWeek", t."postedAt", t."organizationId",
               o.name AS "agencyName", o."telegramUsername"
        FROM "TutoringOffer" t
        JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t."alertedAt" IS NULL AND t.status = 'OPEN'
        ORDER BY t."postedAt" ASC
        LIMIT 20
    `);

    for (const r of rows) {
        const offer: Offer = {
            id: r.id,
            agencyId: r.organizationId,
            title: r.title,
            subject: r.subject,
            gradeLevel: r.gradeLevel,
            city: r.city,
            subCity: r.subCity,
            monthlySalaryEtb: r.monthlySalaryEtb,
            sessionsPerWeek: r.sessionsPerWeek,
            status: 'OPEN',
            postedAt: new Date(r.postedAt).toISOString().slice(0, 10),
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