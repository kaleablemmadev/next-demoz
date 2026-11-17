// src/offers.ts

import { Bot, type Context } from 'grammy';
import { pool } from './db.js';
import { tutorMatchesOffer } from '../../shared/rules/offer-match.js';
import { offerCardText, type CardOffer } from './card.js';

export type OpenOffer = CardOffer & {
    id: string;
    title: string;
    agencyName: string;
};

// Every open offer this tutor fully matches: all grades, area, salary and gender.
export async function findMatchingOffers(telegramId: number): Promise<OpenOffer[]> {
    const me = await pool.query(
        `SELECT "subCity", grades, "minSalaryEtb", gender FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    const tutor = me.rows[0];
    if (!tutor || !tutor.subCity) return [];

    const { rows } = await pool.query<OpenOffer>(`
        SELECT t.id, t.title, t."gradeLevels", t."subCity", t."locationDetail",
               t."sessionsPerWeek", t."sessionHours", t."salaryUnit", t."salaryAmountEtb",
               t."monthlySalaryEtb", t."preferredTutorGender", t.requirements,
               o."postTemplate", o.name AS "agencyName",
               o."telegramUsername" AS "agencyUsername"
        FROM "TutoringOffer" t
                 JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t.status = 'OPEN'
        ORDER BY t."postedAt" DESC
    `);

    return rows.filter((o) =>
        tutorMatchesOffer(
            {
                subCity: tutor.subCity,
                grades: tutor.grades,
                minSalaryEtb: tutor.minSalaryEtb,
                gender: tutor.gender,
            },
            {
                subCity: o.subCity,
                gradeLevels: o.gradeLevels,
                monthlyEtb: o.monthlySalaryEtb,
                preferredGender: o.preferredTutorGender,
            }
        )
    );
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