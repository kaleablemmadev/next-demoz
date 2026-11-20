// src/offer-report.ts

import { Bot } from 'grammy';
import { pool } from './db.js';
import { areasNear } from '../../shared/rules/nearby-areas.js';
import { countsLine, offerResponseCounts } from './apply.js';

type Offer = {
    id: string;
    title: string;
    subCity: string;
    gradeLevels: string[];
    monthlySalaryEtb: number;
    preferredTutorGender: 'MALE' | 'FEMALE' | null;
    agencyTelegramUserId: string | null;
    hasDestination: boolean;
    posted: boolean;
    postFailures: number;
};

type Tutor = {
    subCity: string;
    grades: string[];
    minSalaryEtb: number | null;
    gender: 'MALE' | 'FEMALE' | null;
};

// Works out why each tutor who is not matched was left out, and what tips follow from it.
function tipsFor(o: Offer, tutors: Tutor[], matched: number): string[] {
    if (matched >= 3) return [];

    let areaMiss = 0;
    let gradeMiss = 0;
    let salaryMiss = 0;
    let genderMiss = 0;
    const salaryMins: number[] = [];

    for (const t of tutors) {
        const inArea = areasNear(t.subCity).includes(o.subCity);
        const hasGrades = o.gradeLevels.every((g) => t.grades.includes(g));
        const meetsSalary = t.minSalaryEtb === null || o.monthlySalaryEtb >= t.minSalaryEtb;
        const genderOk = o.preferredTutorGender === null || t.gender === o.preferredTutorGender;

        const misses = [!inArea, !hasGrades, !meetsSalary, !genderOk].filter(Boolean).length;
        if (misses !== 1) continue; // only tutors who missed exactly one thing are useful to point out

        if (!inArea) areaMiss++;
        else if (!hasGrades) gradeMiss++;
        else if (!meetsSalary) {
            salaryMiss++;
            if (t.minSalaryEtb !== null) salaryMins.push(t.minSalaryEtb);
        } else if (!genderOk) genderMiss++;
    }

    const tips: string[] = [];
    if (salaryMiss > 0) {
        const needed = Math.max(...salaryMins);
        tips.push(
            `${salaryMiss} tutor(s) fit everything except the pay. Raising the monthly pay to ${needed.toLocaleString()} ETB would reach them.`
        );
    }
    if (genderMiss > 0) {
        tips.push(`${genderMiss} tutor(s) fit everything except the gender preference. Setting it to Any would reach them.`);
    }
    if (gradeMiss > 0) {
        tips.push(`${gradeMiss} tutor(s) fit everything except the grades. Check whether the grade range is too narrow.`);
    }
    if (areaMiss > 0) {
        tips.push(`${areaMiss} tutor(s) are in other areas. The offer area is fixed, so these tutors cannot be reached for this offer.`);
    }
    return tips;
}

async function reportFor(bot: Bot, o: Offer, tutors: Tutor[]) {
    const { rows: delivered } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "OfferDelivery" WHERE "offerId" = $1`,
        [o.id]
    );
    const sent = Number(delivered[0].n);

    const postedLine = o.posted
        ? 'Posted to your group or channel.'
        : o.postFailures >= 5
            ? 'Could not post to your group or channel. Check that the bot is an admin there with permission to post.'
            : !o.hasDestination
                ? 'No group or channel is set up, so the offer was only sent to tutors.'
                : 'Not posted yet. The bot will try again.';

    const matched = sent;
    const tips = tipsFor(o, tutors, matched);

    const lines = [
        `Offer report: ${o.title}`,
        '',
        postedLine,
        `Sent to ${sent} matching tutor(s) so far.`,
        countsLine(await offerResponseCounts(o.id)),
    ];
    if (tips.length > 0) {
        lines.push('', 'Tips to get more tutors:', ...tips.map((t) => `• ${t}`));
    }

    await bot.api.sendMessage(Number(o.agencyTelegramUserId), lines.join('\n'));
}

// Sends each agency its report once, after the offer is alerted and posted (or cannot be posted).
export async function sendOfferReports(bot: Bot): Promise<void> {
    const { rows } = await pool.query<Offer>(`
        SELECT t.id, t.title, t."subCity", t."gradeLevels", t."monthlySalaryEtb", t."preferredTutorGender",
               o."telegramUserId"::text AS "agencyTelegramUserId",
               (o."groupChatId" IS NOT NULL OR o."channelChatId" IS NOT NULL) AS "hasDestination",
               (t."groupMessageId" IS NOT NULL OR t."channelMessageId" IS NOT NULL) AS posted,
               t."postFailures"
        FROM "TutoringOffer" t
        JOIN "Organization" o ON o.id = t."organizationId"
        WHERE t."alertedAt" IS NOT NULL
          AND t."agencyReportedAt" IS NULL
          AND t.status = 'OPEN'
          AND (
              t."lastPostedToChannelAt" IS NOT NULL
              OR t."postFailures" >= 5
              OR (o."groupChatId" IS NULL AND o."channelChatId" IS NULL)
          )
        ORDER BY t."postedAt" ASC
        LIMIT 20
    `);
    if (rows.length === 0) return;

    const { rows: tutorRows } = await pool.query<Tutor>(`
        SELECT "subCity", grades, "minSalaryEtb", gender
        FROM "TelegramSubscriber"
        WHERE "subCity" IS NOT NULL AND status IN ('ACTIVE', 'PAUSED')
    `);

    for (const o of rows) {
        try {
            if (o.agencyTelegramUserId) {
                await reportFor(bot, o, tutorRows);
            }
            await pool.query(`UPDATE "TutoringOffer" SET "agencyReportedAt" = now() WHERE id = $1`, [o.id]);
        } catch (err) {
            // Not marked as reported, so it is tried again on the next check.
            console.error(`Offer report failed for ${o.id}:`, err);
        }
    }
}