import { Bot } from 'grammy';
import { pool } from './db.js';
import { sendOfferAlerts, type AlertOffer } from './alerts.js';

// Sends alerts for every open offer that hasn't been alerted yet.
// Each offer is handled on its own, so one failure doesn't block the rest.
export async function sendPendingAlerts(bot: Bot): Promise<void> {
    const { rows } = await pool.query<AlertOffer>(`
        SELECT t.id, t.title, t.subject, t.subjects, t."gradeLevels", t."subCity", t."locationDetail",
               t."sessionsPerWeek", t."sessionHours", t."salaryUnit", t."salaryAmountEtb",
               t."monthlySalaryEtb", t."preferredTutorGender", t.requirements, t.status,
               o."postTemplate", o.name AS "agencyName",
                o."telegramUsername" AS "agencyUsername"
                FROM "TutoringOffer" t
                 JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t."alertedAt" IS NULL AND t.status = 'OPEN'
        ORDER BY t."postedAt" ASC
            LIMIT 20
    `);

    for (const offer of rows) {
        try {
            const sent = await sendOfferAlerts(bot, offer);

            // Mark as alerted even if nobody matched, so it's never re-sent.
            await pool.query(`UPDATE "TutoringOffer" SET "alertedAt" = now() WHERE id = $1`, [offer.id]);

            console.log(`Offer ${offer.id} (${offer.title}): sent to ${sent} subscriber(s)`);
        } catch (err) {
            // Not marked as alerted, so it is tried again on the next check.
            // Tutors who already got it are skipped, because OfferDelivery records each send.
            console.error(`Alerts failed for offer ${offer.id}:`, err);
        }
    }
}