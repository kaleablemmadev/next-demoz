import { Bot, type Context } from 'grammy';
import { pool } from './db.js';
import { areasNear } from '../../shared/rules/nearby-areas.js';

type OpenOffer = {
    id: string;
    title: string;
    subject: string;
    gradeLevel: string;
    subCity: string;
    monthlySalaryEtb: number;
    sessionsPerWeek: number;
    agencyName: string;
    agencyUsername: string;
};

// Every open offer that matches this tutor's area, subjects, grades and salary minimum.
export async function findMatchingOffers(telegramId: number): Promise<OpenOffer[]> {
    const me = await pool.query(
        `SELECT "subCity", subjects, grades, "minSalaryEtb" FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    const tutor = me.rows[0];
    if (!tutor || !tutor.subCity) return [];

    const { rows } = await pool.query(`
        SELECT t.id, t.title, t.subject, t."gradeLevel", t."subCity", t."monthlySalaryEtb",
               t."sessionsPerWeek", o.name AS "agencyName", o."telegramUsername" AS "agencyUsername"
        FROM "TutoringOffer" t
        JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t.status = 'OPEN'
        ORDER BY t."postedAt" DESC
    `);

    const areas = areasNear(tutor.subCity);
    return rows.filter(
        (o: OpenOffer) =>
            areas.includes(o.subCity) &&
            tutor.subjects.includes(o.subject) &&
            tutor.grades.includes(o.gradeLevel) &&
            (tutor.minSalaryEtb === null || o.monthlySalaryEtb >= tutor.minSalaryEtb)
    );
}

function offerText(o: OpenOffer): string {
    return [
        o.title,
        `${o.subject} · ${o.gradeLevel} · ${o.subCity}`,
        `${o.sessionsPerWeek} sessions a week`,
        `${o.monthlySalaryEtb.toLocaleString()} ETB / month`,
        '',
        `Agency: ${o.agencyName}`,
        `Contact: @${o.agencyUsername}`,
    ].join('\n');
}

const SHOW_LIMIT = 10;

export function registerOfferHandlers(bot: Bot) {
    bot.callbackQuery('offers:show', async (ctx) => {
        await ctx.answerCallbackQuery();

        const offers = await findMatchingOffers(ctx.from.id);

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