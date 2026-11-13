import 'dotenv/config';
import { Bot } from 'grammy';
import { pool } from './db.js';
import { sendWeeklyDigest } from './digest.js';

async function main() {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
    const sent = await sendWeeklyDigest(bot, true);
    console.log(`Digest sent to ${sent} subscriber(s).`);
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});