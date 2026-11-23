// src/trial.ts
// Unregistered businesses can post up to TRIAL_LIMIT offers before they must register.
// A trial business is an Organization row with status 'TRIAL', tied to the Telegram account.
// It has no group or channel, so trial offers reach tutors through alerts only.
// Registering upgrades the same row, so the trial offers stay attached to the business.

import { Bot, InlineKeyboard } from 'grammy';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { startBusinessSignup } from './signup.js';

export const TRIAL_LIMIT = 5;

export type TrialState = { id: string; offersPosted: number; atLimit: boolean };

// Finds the trial business for this Telegram account, or null.
export async function findTrialAgency(telegramId: number): Promise<{ id: string; name: string } | null> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM "Organization" WHERE status = 'TRIAL' AND "telegramUserId" = $1 LIMIT 1`,
        [telegramId]
    );
    return rows[0] ?? null;
}

export async function trialState(orgId: string): Promise<{ offersPosted: number; atLimit: boolean }> {
    const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "TutoringOffer" WHERE "organizationId" = $1`,
        [orgId]
    );
    const offersPosted = rows[0].n;
    return { offersPosted, atLimit: offersPosted >= TRIAL_LIMIT };
}

// Creates the trial business on first use. Existing registered businesses are never changed here.
export async function ensureTrialAgency(telegramId: number, username: string | undefined, firstName: string): Promise<string> {
    const existing = await findTrialAgency(telegramId);
    if (existing) return existing.id;
    const id = randomUUID();
    await pool.query(
        `INSERT INTO "Organization" (id, name, "telegramUsername", "telegramUserId", status)
         VALUES ($1, $2, $3, $4, 'TRIAL')`,
        [id, firstName.trim().slice(0, 60) || 'Trial business', username ?? null, telegramId]
    );
    return id;
}

export function registerTrialHandlers(bot: Bot) {
    // From the business choice: start trial posting.
    bot.callbackQuery('trial:start', async (ctx) => {
        await ctx.answerCallbackQuery();
        const from = ctx.from;
        if (!from.username) {
            return ctx.editMessageText(
                'Your Telegram account needs a username before you can post. Set one in Telegram settings, then send /start.'
            );
        }
        await ensureTrialAgency(from.id, from.username, from.first_name ?? '');
        await ctx.editMessageText(
            `You can post ${TRIAL_LIMIT} offers free to see how tutors respond. ` +
            'After that, register your business to keep posting. Send /new to post your first offer.'
        );
    });

    // Register the business (also the way out of the trial limit).
    bot.callbackQuery('trial:reg', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText('Registering your tutoring business.').catch(() => undefined);
        return startBusinessSignup(ctx);
    });
}

// Shown when a trial business has used its free offers.
export function trialLimitMessage(): { text: string; kb: InlineKeyboard } {
    return {
        text:
            `You have used your ${TRIAL_LIMIT} free offers. Register your business to keep posting. ` +
            'Your existing offers and their responses stay with you.',
        kb: new InlineKeyboard().text('Register my business', 'trial:reg'),
    };
}
