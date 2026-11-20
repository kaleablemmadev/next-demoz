// src/place-review.ts
// Admin review of sefers and specific locations that people typed.
// Actions: approve as is, merge into an existing place, file a location under a sefer, or reject.
// The person who typed it is told the outcome.

import { Api, Bot, InlineKeyboard } from 'grammy';
import { isAdmin } from './admin.js';
import {
    approvePlace, approvedSefersIn, assignSefer, getPendingPlace, mergePlace, mergeTargets,
    pendingPlaces, rejectPlace, type PendingPlace, type PlaceKind,
} from './places.js';

const KIND: Record<string, PlaceKind> = { S: 'SEFER', L: 'LOCATION' };
const CODE: Record<PlaceKind, string> = { SEFER: 'S', LOCATION: 'L' };
const ADMIN_ONLY = 'This is for the NextTutor admin only.';

// An admin's choice in progress (merge or file under sefer). Kept here because the ids do not fit in one button.
type Pick = { action: 'merge' | 'assign'; place: PendingPlace };
const picking = new Map<number, Pick>();

function label(p: PendingPlace): string {
    if (p.kind === 'SEFER') return `Sefer · ${p.subCity}\n"${p.name}"`;
    const where = p.seferName ? `Sefer: ${p.seferName}` : `No sefer yet · ${p.subCity}`;
    return `Location · ${where}\n"${p.name}"`;
}

function listKeyboard(p: PendingPlace): InlineKeyboard {
    const c = CODE[p.kind];
    const kb = new InlineKeyboard()
        .text('Approve', `pl:ok:${c}:${p.id}`)
        .text('Merge into…', `pl:mg:${c}:${p.id}`);
    if (p.kind === 'LOCATION' && !p.seferId) kb.row().text('File under a sefer…', `pl:as:${p.id}`);
    kb.row().text('Reject', `pl:no:${c}:${p.id}`);
    return kb;
}

// Tells the person who typed the place what happened to it. Never throws.
async function notifyProposer(api: Api, p: PendingPlace, text: string) {
    if (!p.proposedByTelegramId) return;
    await api.sendMessage(p.proposedByTelegramId, text).catch((err) =>
        console.error(`Could not tell ${p.proposedByTelegramId} about place ${p.id}:`, err)
    );
}

export function registerPlaceReviewHandlers(bot: Bot) {
    async function showList(reply: (text: string, other?: { reply_markup: InlineKeyboard }) => Promise<unknown>) {
        const items = await pendingPlaces();
        if (items.length === 0) return reply('No places are waiting for review.');
        await reply(`${items.length} place(s) waiting for review. Oldest first.`);
        for (const p of items.slice(0, 25)) {
            await reply(label(p), { reply_markup: listKeyboard(p) });
        }
        if (items.length > 25) await reply(`${items.length - 25} more. Review these first, then run /places again.`);
    }

    bot.command('places', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply(ADMIN_ONLY);
        return showList((text, other) => ctx.reply(text, other));
    });

    // Approve as it is.
    bot.callbackQuery(/^pl:ok:(S|L):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const [, code, id] = ctx.match as RegExpMatchArray;
        const kind = KIND[code];
        const p = await getPendingPlace(kind, id);
        const ok = await approvePlace(kind, id);
        if (!ok || !p) {
            await ctx.answerCallbackQuery({ text: 'Already reviewed.' });
            return ctx.editMessageText('Already reviewed.').catch(() => undefined);
        }
        await ctx.answerCallbackQuery({ text: 'Approved.' });
        await ctx.editMessageText(`Approved: ${label(p)}`).catch(() => undefined);
        await notifyProposer(ctx.api, p, `The place "${p.name}" you sent was approved and is now available to everyone.`);
    });

    // Reject.
    bot.callbackQuery(/^pl:no:(S|L):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const [, code, id] = ctx.match as RegExpMatchArray;
        const kind = KIND[code];
        const p = await getPendingPlace(kind, id);
        const ok = await rejectPlace(kind, id);
        if (!ok || !p) {
            await ctx.answerCallbackQuery({ text: 'Already reviewed.' });
            return ctx.editMessageText('Already reviewed.').catch(() => undefined);
        }
        await ctx.answerCallbackQuery({ text: 'Rejected.' });
        await ctx.editMessageText(`Rejected: ${label(p)}`).catch(() => undefined);
        await notifyProposer(ctx.api, p, `The place "${p.name}" you sent was not approved. Offers already posted keep the wording you used.`);
    });

    // Merge: show the approved places in the same scope.
    bot.callbackQuery(/^pl:mg:(S|L):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const [, code, id] = ctx.match as RegExpMatchArray;
        const p = await getPendingPlace(KIND[code], id);
        await ctx.answerCallbackQuery();
        if (!p) return ctx.reply('Already reviewed.');
        const targets = await mergeTargets(p);
        if (targets.length === 0) {
            return ctx.reply(
                p.kind === 'LOCATION' && !p.seferId
                    ? 'No approved location with no sefer in this sub-city yet. Approve this one, or file it under a sefer first.'
                    : 'No approved place in this scope to merge into. Approve this one instead.'
            );
        }
        picking.set(ctx.from.id, { action: 'merge', place: p });
        const kb = new InlineKeyboard();
        for (const t of targets) kb.text(t.name, `pl:to:${t.id}`).row();
        await ctx.reply(`Merge "${p.name}" into which existing place? Anyone who types "${p.name}" later will go to that place.`, { reply_markup: kb });
    });

    // File a location under a sefer: show approved sefers in its sub-city.
    bot.callbackQuery(/^pl:as:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const id = (ctx.match as RegExpMatchArray)[1];
        const p = await getPendingPlace('LOCATION', id);
        await ctx.answerCallbackQuery();
        if (!p || p.seferId) return ctx.reply('Already reviewed.');
        const sefers = await approvedSefersIn(p.subCity);
        if (sefers.length === 0) return ctx.reply(`There is no approved sefer in ${p.subCity} yet. Approve the sefer first, in /sefers.`);
        picking.set(ctx.from.id, { action: 'assign', place: p });
        const kb = new InlineKeyboard();
        for (const s of sefers) kb.text(s.name, `pl:sf:${s.id}`).row();
        await ctx.reply(`File "${p.name}" under which sefer in ${p.subCity}?`, { reply_markup: kb });
    });

    // Target chosen for a merge.
    bot.callbackQuery(/^pl:to:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const pick = picking.get(ctx.from.id);
        if (!pick || pick.action !== 'merge') return ctx.answerCallbackQuery({ text: 'Start again with Merge into…', show_alert: true });
        picking.delete(ctx.from.id);
        const targetId = (ctx.match as RegExpMatchArray)[1];
        const result = await mergePlace(pick.place.kind, pick.place.id, targetId);
        if (result === 'DUPLICATE') {
            return ctx.answerCallbackQuery({ text: 'That name already exists in the target. Approve or reject this one instead.', show_alert: true });
        }
        if (!result) {
            return ctx.answerCallbackQuery({ text: 'Already reviewed, or the target changed. Run /places again.', show_alert: true });
        }
        await ctx.answerCallbackQuery({ text: 'Merged.' });
        await ctx.editMessageText(`Merged "${pick.place.name}" into "${result}".`).catch(() => undefined);
        await notifyProposer(ctx.api, pick.place, `The place "${pick.place.name}" you sent was merged into "${result}". Future offers use "${result}".`);
    });

    // Sefer chosen for filing a location.
    bot.callbackQuery(/^pl:sf:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const pick = picking.get(ctx.from.id);
        if (!pick || pick.action !== 'assign') return ctx.answerCallbackQuery({ text: 'Start again with File under a sefer…', show_alert: true });
        picking.delete(ctx.from.id);
        const seferId = (ctx.match as RegExpMatchArray)[1];
        const result = await assignSefer(pick.place.id, seferId);
        if (result === 'DUPLICATE') {
            return ctx.answerCallbackQuery({ text: 'That location name already exists under this sefer. Merge it instead.', show_alert: true });
        }
        if (!result) {
            return ctx.answerCallbackQuery({ text: 'Already reviewed, or the sefer changed. Run /places again.', show_alert: true });
        }
        await ctx.answerCallbackQuery({ text: 'Filed.' });
        await ctx.editMessageText(`Filed "${pick.place.name}" under sefer "${result.seferName}". It is approved.`).catch(() => undefined);
        await notifyProposer(ctx.api, pick.place, `The location "${pick.place.name}" you sent was approved under sefer "${result.seferName}".`);
    });
}
