import 'dotenv/config';
import { Bot } from 'grammy';
import { pool } from './db.js';
import { findMatchingOffers } from './offers.js';
import { payLine, summaryLine } from './card.js';

// Sends a test digest to ONE Telegram account only (yours). It never messages other tutors.
const MY_TELEGRAM_ID = Number(process.env.TEST_TELEGRAM_ID);

async function main() {
    if (!MY_TELEGRAM_ID) throw new Error('Set TEST_TELEGRAM_ID in .env to your own Telegram ID.');

    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
    const offers = await findMatchingOffers(MY_TELEGRAM_ID);

    const text = offers.length === 0
        ? 'Test digest: no matching offers.'
        : `Test digest (${offers.length}):\n\n` +
        offers.slice(0, 5).map((o, i) =>
            `${i + 1}. ${o.title}\n   ${summaryLine(o)}\n   ${payLine(o)}`
        ).join('\n\n');

    await bot.api.sendMessage(MY_TELEGRAM_ID, text);
    console.log('Test digest sent to your account only.');
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});