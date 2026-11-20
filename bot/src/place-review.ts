// src/place-review.ts
// Admin review of sefers and specific locations that people typed: approve as is, or merge into an existing place.

import { Bot, InlineKeyboard } from 'grammy';
import { pool } from './db.js';
import { isAdmin } from './admin.js';
import { approvePlace, mergePlace, pendingPlaces, type PlaceKind } from './places.js';

const KIND: Record<string, PlaceKind> = { S: 'SEFER', L: 'LOCATION' };
const CODE: Record<PlaceKind, string> = { SEFER: 'S', LOCATION: 'L' };

// The pending place an admin is merging. Kept here because two ids do not fit in one button.
const merging = new Map<number, { kind: PlaceKind; id: string }>();

async function mergeTargets(kind: PlaceKind, id: string): Promise<{ id: string; name: string }[]> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        kind === 'SEFER'
            ? `SELECT s2.id, s2.name FROM "Sefer" p
               JOIN "Sefer" s2 ON s2."subCity" = p."subCity" AND s2.status = 'APPROVED' AND s2.id <> p.id
               WHERE p.id = $1 ORDER BY s2.name LIMIT 30`
            : `SELECT l2.id, l2.name FROM "SpecificLocation" p
               JOIN "SpecificLocation" l2 ON l2."seferId" = p."seferId" AND l2.status = 'APPROVED' AND l2.id <> p.id
               WHERE p.id = $1 ORDER BY l2.name LIMIT 30`,
        [id]
    );
    return rows;
}

export function registerPlaceReviewHandlers(bot: Bot) {
    const adminOnly = 'This is for the NextTutor admin only.';

    async function showList(reply: (text: string, other?: { reply_markup: InlineKeyboard }) => Promise<unknown>) {
        const items = await pendingPlaces();
        if (items.length === 0) return reply('No places are waiting for review.');
        for (const p of items.slice(0, 20)) {
            const label = p.kind === 'SEFER' ? `Sefer in ${p.context}` : `Location in ${p.context}`;
            const kb = new InlineKeyboard()
                .text('Approve', `pl:ok:${CODE[p.kind]}:${p.id}`)
                .text('Merge into…', `pl:mg:${CODE[p.kind]}:${p.id}`);
            await reply(`${label}\n"${p.name}"`, { reply_markup: kb });
        }
    }

    bot.command('places', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply(adminOnly);
        return showList((text, other) => ctx.reply(text, other));
    });

    bot.callbackQuery(/^pl:ok:(S|L):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const [, code, id] = ctx.match as RegExpMatchArray;
        const ok = await approvePlace(KIND[code], id);
        await ctx.answerCallbackQuery({ text: ok ? 'Approved.' : 'Already reviewed.' });
        await ctx.editMessageText(ok ? 'Approved. Future matches use this place.' : 'Already reviewed.').catch(() => undefined);
    });

    bot.callbackQuery(/^pl:mg:(S|L):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const [, code, id] = ctx.match as RegExpMatchArray;
        const kind = KIND[code];
        const targets = await mergeTargets(kind, id);
        await ctx.answerCallbackQuery();
        if (targets.length === 0) {
            return ctx.reply('There is no approved place here to merge into. Approve this one instead.');
        }
        merging.set(ctx.from.id, { kind, id });
        const kb = new InlineKeyboard();
        for (const t of targets) kb.text(t.name, `pl:to:${t.id}`).row();
        await ctx.reply('Merge this wording into which existing place? Future typing of it will go to that place.', { reply_markup: kb });
    });

    bot.callbackQuery(/^pl:to:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const pending = merging.get(ctx.from.id);
        if (!pending) {
            return ctx.answerCallbackQuery({ text: 'Start again with Merge into…', show_alert: true });
        }
        const targetId = (ctx.match as RegExpMatchArray)[1];
        const name = await mergePlace(pending.kind, pending.id, targetId);
        merging.delete(ctx.from.id);
        if (!name) {
            return ctx.answerCallbackQuery({ text: 'That place can no longer be merged.', show_alert: true });
        }
        await ctx.answerCallbackQuery({ text: 'Merged.' });
        await ctx.editMessageText(`Merged into "${name}". Future typing of this wording goes there.`).catch(() => undefined);
    });
}
