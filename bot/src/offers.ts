import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { tutorMatchesOffer } from '../../shared/rules/offer-match.js';

export type OpenOffer = {
    id: string;
    title: string;
    subjects: string[];
    gradeLevels: string[];
    subCity: string;
    monthlySalaryEtb: number;
    sessionsPerWeek: number;
    agencyName: string;
    agencyUsername: string;
};

// Every open offer this tutor fully matches: all subjects, all grades, area and salary.
export async function findMatchingOffers(telegramId: number): Promise<OpenOffer[]> {
    const me = await pool.query(
        `SELECT "subCity", subjects, grades, "minSalaryEtb" FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    const tutor = me.rows[0];
    if (!tutor || !tutor.subCity) return [];

    const { rows } = await pool.query(`
        SELECT t.id, t.title, t.subjects, t."gradeLevels", t."subCity", t."monthlySalaryEtb",
               t."sessionsPerWeek", o.name AS "agencyName", o."telegramUsername" AS "agencyUsername"
        FROM "TutoringOffer" t
                 JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t.status = 'OPEN'
        ORDER BY t."postedAt" DESC
    `);

    return rows.filter((o: OpenOffer) =>
        tutorMatchesOffer(
            {
                subCity: tutor.subCity,
                subjects: tutor.subjects,
                grades: tutor.grades,
                minSalaryEtb: tutor.minSalaryEtb,
            },
            {
                subCity: o.subCity,
                subjects: o.subjects,
                gradeLevels: o.gradeLevels,
                monthlyEtb: o.monthlySalaryEtb,
            }
        )
    );
}

function offerText(o: OpenOffer): string {
    return [
        o.title,
        `${o.subjects.join(', ')} · ${o.gradeLevels.join(' & ')} · ${o.subCity}`,
        `${o.sessionsPerWeek} sessions a week`,
        `${o.monthlySalaryEtb.toLocaleString()} ETB / month`,
        '',
        `Agency: ${o.agencyName}`,
        `Contact: @${o.agencyUsername}`,
    ].join('\n');
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