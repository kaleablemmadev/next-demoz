import { Bot } from 'grammy';
import { pool } from './db.js';
import { areasNear } from '../../shared/rules/nearby-areas.js';
import type { Offer } from '../../shared/types/offer.js';

export type Agency = {
    name: string;
    telegramUsername: string;
};

type Subscriber = {
    telegramId: string;
    subCity: string;
    subjects: string[];
    grades: string[];
    minSalaryEtb: number | null;
};

// Active subscribers who haven't paused alerts or switched off offer alerts.
async function alertableSubscribers(): Promise<Subscriber[]> {
    const { rows } = await pool.query(`
        SELECT s."telegramId"::text AS "telegramId", s."subCity", s.subjects, s.grades, s."minSalaryEtb"
        FROM "TelegramSubscriber" s
        WHERE s.status = 'ACTIVE'
          AND s."subCity" IS NOT NULL
          AND (s."pausedUntil" IS NULL OR s."pausedUntil" < now())
          AND NOT EXISTS (
            SELECT 1 FROM "NotificationPreference" p
            WHERE p."subscriberId" = s.id
              AND p.category = 'OFFER_ALERTS'
              AND p.enabled = false
        )
    `);
    return rows;
}

// Nearby area, subject, grade, and the tutor's salary filter.
function matches(sub: Subscriber, offer: Offer): boolean {
    return (
        areasNear(sub.subCity).includes(offer.subCity) &&
        sub.subjects.includes(offer.subject) &&
        sub.grades.includes(offer.gradeLevel) &&
        (sub.minSalaryEtb === null || offer.monthlySalaryEtb >= sub.minSalaryEtb)
    );
}

function alertText(offer: Offer, agency: Agency): string {
    return [
        'New tutoring offer',
        '',
        offer.title,
        `${offer.subject} · ${offer.gradeLevel} · ${offer.subCity}`,
        `${offer.sessionsPerWeek} sessions a week`,
        `${offer.monthlySalaryEtb.toLocaleString()} ETB / month`,
        '',
        `Agency: ${agency.name}`,
        `Contact: @${agency.telegramUsername}`,
    ].join('\n');
}

// Sends the offer to every matching subscriber who hasn't had it yet.
// Returns how many messages were sent.
export async function sendOfferAlerts(bot: Bot, offer: Offer, agency: Agency): Promise<number> {
    if (offer.status !== 'OPEN') return 0;

    let sent = 0;

    for (const sub of await alertableSubscribers()) {
        if (!matches(sub, offer)) continue;

        const already = await pool.query(
            `SELECT 1 FROM "OfferDelivery" d
                               JOIN "TelegramSubscriber" s ON s.id = d."subscriberId"
             WHERE s."telegramId" = $1 AND d."offerId" = $2`,
            [sub.telegramId, offer.id]
        );
        if (already.rows.length > 0) continue;

        try {
            await bot.api.sendMessage(sub.telegramId, alertText(offer, agency));
        } catch (err) {
            // Usually means the tutor blocked the bot. Skip them and carry on.
            console.error(`Could not message ${sub.telegramId}:`, err);
            continue;
        }

        await pool.query(
            `INSERT INTO "OfferDelivery" ("subscriberId", "offerId")
             SELECT id, $2 FROM "TelegramSubscriber" WHERE "telegramId" = $1
                 ON CONFLICT DO NOTHING`,
            [sub.telegramId, offer.id]
        );
        sent++;
    }

    return sent;
}