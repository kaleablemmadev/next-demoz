// src/alerts.ts

import { Api, Bot } from 'grammy';
import { pool } from './db.js';
import { areasNear } from '../../shared/rules/nearby-areas.js';
import { offerCardText, payLine, summaryLine, type CardOffer } from './card.js';
import { applyKeyboard } from './apply.js';

export type AlertOffer = CardOffer & {
    id: string;
    status: 'OPEN' | 'CLOSED';
    seferId?: string | null;
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
          AND cardinality($2::text[]) > 0
          AND s.grades @> $2::text[]
          AND (s."minSalaryEtb" IS NULL OR s."minSalaryEtb" <= $3)
          AND ($4::text IS NULL OR s.gender = $4::text)
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
          -- Sefers the tutor turned down: "too far" hides all of them, "not enough salary" hides pay at or below the rejected amount.
          AND NOT EXISTS (
            SELECT 1 FROM "SeferExclusion" x
            WHERE x."subscriberId" = s.id
              AND x."seferId" = $6::text
              AND (x.kind = 'TOO_FAR' OR (x.kind = 'LOW_SALARY' AND $3 <= x."salaryBelowEtb"))
          )
    `, [
        areasNear(offer.subCity),
        offer.gradeLevels,
        offer.monthlySalaryEtb,
        offer.preferredTutorGender,
        offer.id,
        offer.seferId ?? null,
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
                await bot.api.sendMessage(sub.telegramId, text, { reply_markup: applyKeyboard(offer.id) });
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

// After an edit, a short notice goes to every tutor who already received this offer.
// Tutors who were never sent it get the full offer through the normal alert instead.
export async function notifyUpdatedOffer(api: Api, offer: CardOffer & { id: string; title: string }): Promise<number> {
    const { rows } = await pool.query<Subscriber>(
        `SELECT s."telegramId"::text AS "telegramId"
         FROM "OfferDelivery" d
         JOIN "TelegramSubscriber" s ON s.id = d."subscriberId"
         WHERE d."offerId" = $1`,
        [offer.id]
    );

    const text =
        `An offer you received was updated:\n\n` +
        `${offer.title}\n${summaryLine(offer)}\n${payLine(offer)}\n\n` +
        `Check the agency's post for the full details.`;

    let sent = 0;
    for (const sub of rows) {
        try {
            await api.sendMessage(sub.telegramId, text);
            sent++;
        } catch (err) {
            console.error(`Could not send the update notice to ${sub.telegramId}:`, err);
        }
    }
    return sent;
}
