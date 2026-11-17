// src/alerts.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { tutorMatchesOffer } from '../../shared/rules/offer-match.js';
import { offerCardText, type CardOffer } from './card.js';

export type AlertOffer = CardOffer & {
    id: string;
    status: 'OPEN' | 'CLOSED';
};

type Subscriber = {
    telegramId: string;
    subCity: string;
    grades: string[];
    minSalaryEtb: number | null;
    gender: 'MALE' | 'FEMALE' | null;
};

// Active subscribers who haven't paused alerts or switched off offer alerts.
async function alertableSubscribers(offerId: string): Promise<Subscriber[]> {
    const { rows } = await pool.query(`
        SELECT s."telegramId"::text AS "telegramId", s."subCity", s.grades, s."minSalaryEtb", s.gender
        FROM "TelegramSubscriber" s
        WHERE s."subCity" IS NOT NULL
          AND (
            s.status = 'ACTIVE'
            OR (s.status = 'PAUSED' AND s."pausedUntil" < now())
          )
          AND NOT EXISTS (
            SELECT 1 FROM "NotificationPreference" p
            WHERE p."subscriberId" = s.id
              AND p.category = 'OFFER_ALERTS'
              AND p.enabled = false
          )
          AND NOT EXISTS (
            SELECT 1 FROM "OfferDelivery" d
            WHERE d."subscriberId" = s.id AND d."offerId" = $1
          )
    `, [offerId]);
    return rows;
}

// Sends the offer to every fully matching subscriber who hasn't had it yet.
// Returns how many messages were sent.
export async function sendOfferAlerts(bot: Bot, offer: AlertOffer): Promise<number> {
    if (offer.status !== 'OPEN') return 0;

    let sent = 0;
    const text = offerCardText(offer);

    for (const sub of await alertableSubscribers(offer.id)) {
        const matches = tutorMatchesOffer(
            { subCity: sub.subCity, grades: sub.grades, minSalaryEtb: sub.minSalaryEtb, gender: sub.gender },
            {
                subCity: offer.subCity,
                gradeLevels: offer.gradeLevels,
                monthlyEtb: offer.monthlySalaryEtb,
                preferredGender: offer.preferredTutorGender,
            }
        );
        if (!matches) continue;

        try {
            await bot.api.sendMessage(sub.telegramId, text);
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