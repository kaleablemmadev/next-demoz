// src/broadcast.ts
// Admin broadcast: a plain text message to all or chosen agencies, tutors, parents, or any mix.
// Each person gets it once even if they are in more than one group.

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { isAdmin } from './admin.js';

const ADMIN_ONLY = 'This is for the NextTutor admin only.';
const MAX_LENGTH = 3500;
// About 16 messages a second, well under Telegram's limit for one bot.
const SEND_DELAY_MS = 60;

type Selection = {
    agencies: 'off' | 'all' | 'chosen';
    chosen: Set<string>;   // Organization ids, when agencies is 'chosen'
    tutors: boolean;
    parents: boolean;
    step: 'choose' | 'pick_agencies' | 'text' | 'preview';
    text?: string;
};

const selections = new Map<number, Selection>();

type Counts = { agencies: number; tutors: number; parents: number; unique: number; ids: string[] };

async function agencyIds(sel: Selection): Promise<string[]> {
    if (sel.agencies === 'off') return [];
    const { rows } = await pool.query<{ tg: string }>(
        sel.agencies === 'all'
            ? `SELECT "telegramUserId"::text AS tg FROM "Organization"
               WHERE "telegramUserId" IS NOT NULL AND status NOT IN ('LEFT', 'REJECTED', 'PENDING_APPROVAL')`
            : `SELECT "telegramUserId"::text AS tg FROM "Organization"
               WHERE "telegramUserId" IS NOT NULL AND status NOT IN ('LEFT', 'REJECTED', 'PENDING_APPROVAL')
                 AND id = ANY($1::text[])`,
        sel.agencies === 'all' ? [] : [[...sel.chosen]]
    );
    return rows.map((r) => r.tg);
}

// Everyone who would receive the message, de-duplicated by Telegram id.
async function recipientsOf(sel: Selection): Promise<Counts> {
    const agencies = await agencyIds(sel);
    const tutors = sel.tutors
        ? (await pool.query<{ tg: string }>(
            `SELECT "telegramId"::text AS tg FROM "TelegramSubscriber" WHERE status IN ('ACTIVE', 'PAUSED')`
        )).rows.map((r) => r.tg)
        : [];
    const parents = sel.parents
        ? (await pool.query<{ tg: string }>(
            `SELECT "telegramId"::text AS tg FROM "Parent" WHERE "telegramId" IS NOT NULL`
        )).rows.map((r) => r.tg)
        : [];
    const ids = [...new Set([...agencies, ...tutors, ...parents])];
    return { agencies: agencies.length, tutors: tutors.length, parents: parents.length, unique: ids.length, ids };
}

function summary(sel: Selection): string {
    const parts: string[] = [];
    if (sel.agencies === 'all') parts.push('All agencies');
    if (sel.agencies === 'chosen') parts.push(`${sel.chosen.size} chosen agenc${sel.chosen.size === 1 ? 'y' : 'ies'}`);
    if (sel.tutors) parts.push('All tutors');
    if (sel.parents) parts.push('All parents');
    return parts.length ? parts.join(', ') : 'Nobody yet';
}

function chooseScreen(sel: Selection) {
    const mark = (on: boolean, text: string) => (on ? `✅ ${text}` : text);
    const kb = new InlineKeyboard()
        .text(mark(sel.agencies === 'all', 'All agencies'), 'bc:ag:all')
        .text(mark(sel.agencies === 'chosen', 'Choose agencies…'), 'bc:ag:chosen')
        .row()
        .text(mark(sel.tutors, 'All tutors'), 'bc:tu')
        .text(mark(sel.parents, 'All parents'), 'bc:pa')
        .row()
        .text('Continue', 'bc:go')
        .text('Cancel', 'bc:x');
    return {
        text: `Broadcast. Choose who receives the message. Tap again to remove a group.\n\nSelected: ${summary(sel)}`,
        kb,
    };
}

async function agencyPicker(sel: Selection) {
    const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM "Organization"
         WHERE "telegramUserId" IS NOT NULL AND status NOT IN ('LEFT', 'REJECTED', 'PENDING_APPROVAL')
         ORDER BY name LIMIT 60`
    );
    const kb = new InlineKeyboard();
    for (const o of rows) {
        kb.text(`${sel.chosen.has(o.id) ? '✅ ' : ''}${o.name}`.slice(0, 60), `bc:ap:${o.id}`).row();
    }
    kb.text('Done', 'bc:apd');
    return {
        text: `Tap the agencies to include. Selected: ${sel.chosen.size}.`,
        kb,
    };
}

async function previewScreen(sel: Selection) {
    const c = await recipientsOf(sel);
    return {
        text:
            `Ready to send to ${c.unique} person(s): ${c.agencies} agenc${c.agencies === 1 ? 'y' : 'ies'}, ` +
            `${c.tutors} tutor(s), ${c.parents} parent(s). People in more than one group get it once.\n\n` +
            `Message:\n${sel.text}`,
        kb: new InlineKeyboard().text(`Send to ${c.unique}`, 'bc:send').text('Cancel', 'bc:x'),
        unique: c.unique,
    };
}

// Sends one message at a time with a short pause, and reports the result to the admin.
async function deliver(bot: Bot, adminChatId: number, ids: string[], text: string) {
    let sent = 0;
    let failed = 0;
    for (const tg of ids) {
        try {
            await bot.api.sendMessage(tg, text);
            sent++;
        } catch (err) {
            // Usually means the person blocked the bot or left.
            failed++;
            console.error(`Broadcast to ${tg} failed:`, err);
        }
        await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    }
    await bot.api.sendMessage(adminChatId, `Broadcast finished. Sent: ${sent}. Could not reach: ${failed}.`).catch(() => undefined);
}

export function registerBroadcastHandlers(bot: Bot) {
    async function showChoose(ctx: Context, sel: Selection, edit: boolean) {
        const screen = chooseScreen(sel);
        if (edit) return ctx.editMessageText(screen.text, { reply_markup: screen.kb }).catch(() => undefined);
        return ctx.reply(screen.text, { reply_markup: screen.kb });
    }

    bot.command('broadcast', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply(ADMIN_ONLY);
        if (ctx.chat?.type !== 'private') return ctx.reply('Use /broadcast in a private chat with the bot.');
        const sel: Selection = { agencies: 'off', chosen: new Set(), tutors: false, parents: false, step: 'choose' };
        selections.set(ctx.from!.id, sel);
        return showChoose(ctx, sel, false);
    });

    bot.callbackQuery(/^bc:(ag:all|ag:chosen|tu|pa|go|x|apd)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const sel = selections.get(ctx.from.id);
        if (!sel) return ctx.answerCallbackQuery({ text: 'Start again with /broadcast.', show_alert: true });
        const action = (ctx.match as RegExpMatchArray)[1];
        await ctx.answerCallbackQuery();

        if (action === 'x') {
            selections.delete(ctx.from.id);
            return ctx.editMessageText('Broadcast cancelled.').catch(() => undefined);
        }
        if (action === 'ag:all') sel.agencies = sel.agencies === 'all' ? 'off' : 'all';
        if (action === 'ag:chosen') {
            sel.agencies = sel.agencies === 'chosen' ? 'off' : 'chosen';
            if (sel.agencies === 'chosen') {
                sel.step = 'pick_agencies';
                const picker = await agencyPicker(sel);
                return ctx.editMessageText(picker.text, { reply_markup: picker.kb }).catch(() => undefined);
            }
            sel.chosen.clear();
        }
        if (action === 'tu') sel.tutors = !sel.tutors;
        if (action === 'pa') sel.parents = !sel.parents;
        if (action === 'apd') {
            sel.step = 'choose';
            return showChoose(ctx, sel, true);
        }
        if (action === 'go') {
            if (sel.agencies === 'off' && !sel.tutors && !sel.parents) {
                return ctx.reply('Choose at least one group first.');
            }
            if (sel.agencies === 'chosen' && sel.chosen.size === 0) {
                return ctx.reply('Choose at least one agency, or tap Done after picking.');
            }
            sel.step = 'text';
            return ctx.reply(
                `Type the message to send to: ${summary(sel)}.\n\n` +
                `Plain text, up to ${MAX_LENGTH} characters. Send /cancel to stop.`
            );
        }
        return showChoose(ctx, sel, true);
    });

    bot.callbackQuery(/^bc:ap:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const sel = selections.get(ctx.from.id);
        if (!sel || sel.agencies !== 'chosen') return ctx.answerCallbackQuery({ text: 'Start again with /broadcast.', show_alert: true });
        const id = (ctx.match as RegExpMatchArray)[1];
        if (sel.chosen.has(id)) sel.chosen.delete(id);
        else sel.chosen.add(id);
        await ctx.answerCallbackQuery();
        const picker = await agencyPicker(sel);
        return ctx.editMessageText(picker.text, { reply_markup: picker.kb }).catch(() => undefined);
    });

    bot.callbackQuery('bc:send', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: ADMIN_ONLY, show_alert: true });
        const sel = selections.get(ctx.from.id);
        if (!sel || sel.step !== 'preview' || !sel.text) {
            return ctx.answerCallbackQuery({ text: 'This broadcast has expired. Start again with /broadcast.', show_alert: true });
        }
        const c = await recipientsOf(sel);
        const text = sel.text;
        selections.delete(ctx.from.id);
        await ctx.answerCallbackQuery({ text: 'Sending…' });
        await ctx.editMessageText(`Sending to ${c.unique} person(s). You will get a message here when it is finished.`).catch(() => undefined);
        // Runs in the background so the admin is not kept waiting.
        void deliver(bot, ctx.chat!.id, c.ids, text);
    });

    // The message text the admin types for a broadcast. Anything else passes on to the other handlers.
    bot.on('message:text', async (ctx, next) => {
        const sel = selections.get(ctx.from.id);
        if (!sel || sel.step !== 'text' || !isAdmin(ctx) || ctx.chat?.type !== 'private') return next();
        const text = ctx.message.text.trim();
        if (text.startsWith('/')) {
            if (text === '/cancel') {
                selections.delete(ctx.from.id);
                return ctx.reply('Broadcast cancelled.');
            }
            return next();
        }
        if (text.length === 0) return ctx.reply('Type the message as plain text.');
        if (text.length > MAX_LENGTH) return ctx.reply(`That is ${text.length} characters. Please shorten it to ${MAX_LENGTH}.`);
        sel.text = text;
        sel.step = 'preview';
        const p = await previewScreen(sel);
        if (p.unique === 0) {
            selections.delete(ctx.from.id);
            return ctx.reply('Nobody matches the chosen groups yet, so nothing was sent.');
        }
        return ctx.reply(p.text, { reply_markup: p.kb });
    });
}
