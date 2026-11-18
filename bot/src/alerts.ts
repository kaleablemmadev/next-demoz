// src/alerts.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { areasNear } from '../../shared/rules/nearby-areas.js';
import { offerCardText, type CardOffer } from './card.js';

export type AlertOffer = CardOffer & {
    id: string;
    status: 'OPEN' | 'CLOSED';
};

type Subscriber = {
    telegramId: string;
};

// Active subscribers who match this offer, haven't paused alerts, and haven't received it yet.
// Keep filtering in SQL so Node.js only loads subscribers who can actually receive this alert.
async function alertableSubscribers(offer: AlertOffer): Promise<Subscriber[]> {
    const { rows } = await pool.query<Subscriber>(`
        SELECT s."telegramId"::text AS "telegramId"
        FROM "TelegramSubscriber" s
        WHERE s."subCity" = ANY($1::text[])
          AND cardinality($2::text[]) > 0
          AND s.grades @> $2::text[]
          AND (s."minSalaryEtb" IS NULL OR s."minSalaryEtb" <= $3)
          AND ($4 IS NULL OR s.gender = $4)
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
            WHERE d."subscriberId" = s.id AND d."offerId" = $5
          )
    `, [
        areasNear(offer.subCity),
        offer.gradeLevels,
        offer.monthlySalaryEtb,
        offer.preferredTutorGender,
        offer.id,
    ]);
    return rows;
}

// Sends the offer to every fully matching subscriber who hasn't had it yet.
// Returns how many messages were sent.
export async function sendOfferAlerts(bot: Bot, offer: AlertOffer): Promise<number> {
    if (offer.status !== 'OPEN') return 0;

    let sent = 0;
    const text = offerCardText(offer);

    for (const sub of await alertableSubscribers(offer)) {
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
