// src/agency-lifecycle.ts

import { Bot } from 'grammy';
import { pool } from './db.js';

type Org = { id: string; name: string; status: string };

async function log(orgId: string, event: 'LEFT' | 'BLOCKED' | 'RETURNED') {
    await pool.query(`INSERT INTO "OrganizationEvent" ("organizationId", event) VALUES ($1, $2)`, [orgId, event]);
}

// Called when an approved leave request marks the agency as LEFT.
export async function logLeft(orgId: string) {
    await log(orgId, 'LEFT');
}

// If an agency that left or blocked the bot is back, makes it ACTIVE and logs the return.
// Returns the agency if it is active after the check, otherwise null.
export async function reactivateIfReturning(telegramUserId: number): Promise<Org | null> {
    const { rows } = await pool.query<Org>(
        `SELECT id, name, status FROM "Organization" WHERE "telegramUserId" = $1`,
        [telegramUserId]
    );
    const org = rows[0];
    if (!org) return null;
    if (org.status === 'PENDING_APPROVAL' || org.status === 'REJECTED') return null;

    const { rows: last } = await pool.query<{ event: string }>(
        `SELECT event FROM "OrganizationEvent" WHERE "organizationId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
        [org.id]
    );
    const wasAway = org.status === 'LEFT' || last[0]?.event === 'BLOCKED';
    if (!wasAway) return org;

    await pool.query(`UPDATE "Organization" SET status = 'ACTIVE' WHERE id = $1`, [org.id]);
    await log(org.id, 'RETURNED');
    return { ...org, status: 'ACTIVE' };
}

// Watches the agency's private chat with the bot: blocking logs BLOCKED, unblocking brings it back.
// Must be registered before the signup handlers, which stop the chain for these events.
export function registerAgencyLifecycle(bot: Bot) {
    bot.on('my_chat_member', async (ctx, next) => {
        if (ctx.chat.type !== 'private') return next();

        const telegramId = ctx.myChatMember.from.id;
        const status = ctx.myChatMember.new_chat_member.status;

        const { rows } = await pool.query<Org>(
            `SELECT id, name, status FROM "Organization" WHERE "telegramUserId" = $1`,
            [telegramId]
        );
        const org = rows[0];
        if (!org) return next();

        if (status === 'kicked') {
            if (org.status === 'ACTIVE') await log(org.id, 'BLOCKED');
            return;
        }

        if (status === 'member') {
            const back = await reactivateIfReturning(telegramId);
            if (back) {
                await ctx.api.sendMessage(
                    telegramId,
                    `Welcome back, ${back.name}. Your business is active again. Send /new to post an offer.`
                ).catch((err) => console.error('Could not send welcome back:', err));
            }
        }

        return next();
    });
}