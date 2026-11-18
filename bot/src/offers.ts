// src/offers.ts

import { Bot, type Context } from 'grammy';
import { pool } from './db.js';
import { areasNear } from '../../shared/rules/nearby-areas.js';
import { offerCardText, type CardOffer } from './card.js';

export type OpenOffer = CardOffer & {
    id: string;
    title: string;
    agencyName: string;
};

// Every open offer this tutor fully matches: all grades, area, salary and gender.
// Apply the matching rules in PostgreSQL so the bot does not download every open offer.
export async function findMatchingOffers(telegramId: number | string): Promise<OpenOffer[]> {
    const me = await pool.query(
        `SELECT "subCity", subjects, grades, "minSalaryEtb", gender FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    const tutor = me.rows[0];
    if (!tutor || !tutor.subCity) return [];

    const { rows } = await pool.query<OpenOffer>(`
        SELECT t.id, t.title, t.subject, t.subjects, t."gradeLevels", t."subCity", t."locationDetail",
               t."sessionsPerWeek", t."sessionHours", t."salaryUnit", t."salaryAmountEtb",
               t."monthlySalaryEtb", t."preferredTutorGender", t.requirements,
               o."postTemplate", o.name AS "agencyName",
               o."telegramUsername" AS "agencyUsername"
        FROM "TutoringOffer" t
                 JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t.status = 'OPEN'
          AND t."subCity" = ANY($1::text[])
          AND cardinality(t."gradeLevels") > 0
          AND t."gradeLevels" <@ $2::text[]
          AND ($3 IS NULL OR t."monthlySalaryEtb" >= $3)
          AND (t."preferredTutorGender" IS NULL OR t."preferredTutorGender" = $4)
          AND (
            cardinality(COALESCE(NULLIF(t.subjects, ARRAY[]::text[]),
              CASE WHEN t.subject IS NOT NULL AND btrim(t.subject) <> '' THEN ARRAY[t.subject]::text[] ELSE ARRAY[]::text[] END)) = 0
            OR cardinality($5::text[]) = 0
            OR EXISTS (
              SELECT 1
              FROM unnest(COALESCE(NULLIF(t.subjects, ARRAY[]::text[]),
                CASE WHEN t.subject IS NOT NULL AND btrim(t.subject) <> '' THEN ARRAY[t.subject]::text[] ELSE ARRAY[]::text[] END)) offer_subject
              JOIN unnest($5::text[]) tutor_subject
                ON lower(btrim(offer_subject)) = lower(btrim(tutor_subject))
            )
          )
        ORDER BY t."postedAt" DESC
    `, [
        areasNear(tutor.subCity),
        tutor.grades ?? [],
        tutor.minSalaryEtb,
        tutor.gender,
        tutor.subjects ?? [],
    ]);

    return rows;
}

// The same card the alerts and group posts use, with the agency name added.
export function offerText(o: OpenOffer): string {
    return `${offerCardText(o, 'OPEN')}\n\nAgency: ${o.agencyName}`;
}

const SHOW_LIMIT = 10;

export function registerOfferHandlers(bot: Bot) {
    bot.callbackQuery('offers:show', async (ctx: Context) => {
        await ctx.answerCallbackQuery();

        const offers = await findMatchingOffers(ctx.from!.id);

        if (offers.length === 0) {
            return ctx.reply("No open offers match your setup yet. We'll message you when one does.");
        }

        await ctx.reply(
            offers.length > SHOW_LIMIT
                ? `${offers.length} offers match you. Here are the newest ${SHOW_LIMIT}.`
                : `${offers.length} offer(s) match you.`
        );

        for (const offer of offers.slice(0, SHOW_LIMIT)) {
            await ctx.reply(offerText(offer));
        }
    });
}
