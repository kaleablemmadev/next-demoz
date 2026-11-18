// src/alerts.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { areasNear } from '../../shared/rules/nearby-areas.js';
import { offerCardText, type CardOffer } from './card.js';

export type AlertOffer = CardOffer & {
    id: string;
    subject?: string | null;
    subjects?: string[];
    status: 'OPEN' | 'CLOSED';
};

type Subscriber = {
    telegramId: string;
};

// A small bounded fan-out improves delivery time without overwhelming Telegram
// or creating an unbounded number of database/API requests.
const DELIVERY_CONCURRENCY = 5;

// Active subscribers who match this offer, haven't paused alerts, and haven't received it yet.
// Keep filtering in SQL so Node.js only loads subscribers who can actually receive this alert.
async function alertableSubscribers(offer: AlertOffer): Promise<Subscriber[]> {
    const { rows } = await pool.query<Subscriber>(`
        SELECT s."telegramId"::text AS "telegramId"
        FROM "TelegramSubscriber" s
        WHERE s."subCity" = ANY($1::text[])
          AND (
            cardinality(COALESCE($2::text[], ARRAY[]::text[])) = 0
            OR cardinality(s.subjects) = 0
            OR EXISTS (
              SELECT 1 FROM unnest(s.subjects) tutor_subject
              JOIN unnest($2::text[]) offer_subject
                ON lower(btrim(tutor_subject)) = lower(btrim(offer_subject))
            )
          )
          AND cardinality($3::text[]) > 0
          AND s.grades @> $3::text[]
          AND (s."minSalaryEtb" IS NULL OR s."minSalaryEtb" <= $4)
          AND ($5 IS NULL OR s.gender = $5)
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
            WHERE d."subscriberId" = s.id AND d."offerId" = $6
          )
    `, [
        areasNear(offer.subCity),
        offer.subjects?.length ? offer.subjects : (offer.subject ? [offer.subject] : []),
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

    const subscribers = await alertableSubscribers(offer);
    const text = offerCardText(offer);
    let nextIndex = 0;
    let sent = 0;

    async function deliver(): Promise<void> {
        while (true) {
            const index = nextIndex++;
            if (index >= subscribers.length) return;
            const sub = subscribers[index];

            try {
                await bot.api.sendMessage(sub.telegramId, text);
            } catch (err) {
                // Usually means the tutor blocked the bot. Skip them and carry on.
                console.error(`Could not message ${sub.telegramId}:`, err);
                continue;
            }

            try {
                await pool.query(
                    `INSERT INTO "OfferDelivery" ("subscriberId", "offerId")
                     SELECT id, $2 FROM "TelegramSubscriber" WHERE "telegramId" = $1
                     ON CONFLICT DO NOTHING`,
                    [sub.telegramId, offer.id]
                );
                sent++;
            } catch (err) {
                // A send succeeded but its receipt could not be persisted. Log explicitly:
                // the next retry may resend this one message because Telegram and PostgreSQL
                // cannot participate in one atomic transaction.
                console.error(`Message sent to ${sub.telegramId}, but delivery receipt failed for offer ${offer.id}:`, err);
            }
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(DELIVERY_CONCURRENCY, subscribers.length) },
            () => deliver()
        )
    );

    return sent;
}
