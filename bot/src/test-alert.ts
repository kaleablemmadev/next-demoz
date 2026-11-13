import 'dotenv/config';
import { Bot } from 'grammy';
import { pool } from './db.js';
import { sendOfferAlerts, type Agency } from './alerts.js';
import type { Offer } from '../../shared/types/offer.js';

async function main() {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

    // Load the agency profile once; every alert shows its contact.
    const { rows } = await pool.query(
        `SELECT name, "telegramUsername" FROM "Organization" WHERE "telegramUsername" = 'demo_agency_a'`
    );
    const agency: Agency = {
        name: rows[0].name,
        telegramUsername: rows[0].telegramUsername,
    };

    // Use a new id each time you test, or the same tutors won't get it again.
    const offer: Offer = {
        id: `test-${Date.now()}`,
        agencyId: 'demo-agency-a',
        title: 'Grade 8 Maths tutor (TEST)',
        subject: 'Mathematics',
        gradeLevel: 'Grade 8',
        city: 'Addis Ababa',
        subCity: 'Kolfe Keranio',
        monthlySalaryEtb: 2500,
        sessionsPerWeek: 3,
        status: 'OPEN',
        postedAt: new Date().toISOString().slice(0, 10),
    };

    const sent = await sendOfferAlerts(bot, offer, agency);
    console.log(`Sent to ${sent} subscriber(s).`);

    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});