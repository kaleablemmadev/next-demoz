// src/search.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import type { SearchFilters } from '../../shared/rules/search.js';
import { GRADES } from './curriculum.js';
import { offerText, type OpenOffer } from './offers.js';

type Field = 'grades' | 'areas';

const OPTIONS: Record<Field, readonly string[]> = {
    grades: GRADES,
    areas: KNOWN_SUB_CITIES,
};

const LABEL: Record<Field, string> = {
    grades: 'Grades',
    areas: 'Areas',
};

// Each searcher's current filters. Lost on restart, so they send /search again.
const filters = new Map<number, SearchFilters>();
const lastSearchTap = new Map<number, { key: string; at: number }>();

async function ignoreRapidRepeat(ctx: Context, key: string): Promise<boolean> {
    const previous = lastSearchTap.get(ctx.from!.id);
    const now = Date.now();
    if (previous?.key === key && now - previous.at < 700) {
        await ctx.answerCallbackQuery({ text: 'Already processing that tap.' });
        return true;
    }
    lastSearchTap.set(ctx.from!.id, { key, at: now });
    return false;
}

// Start from the searcher's own grades and area. Gender starts at Any.
async function fromProfile(telegramId: number): Promise<SearchFilters> {
    const { rows } = await pool.query(
        `SELECT "subCity", grades FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    const me = rows[0];
    return {
        grades: me?.grades ?? [],
        areas: me?.subCity ? [me.subCity] : [],
        gender: null,
    };
}

function menuText(): string {
    return 'Search offers. Change any filter, then tap Show offers.';
}

function menuKeyboard(f: SearchFilters) {
    return new InlineKeyboard()
        .text(`Grades: ${f.grades.length || 'any'}`, 'sr:pick:grades').row()
        .text(`Areas: ${f.areas.length || 'any'}`, 'sr:pick:areas').row()
        .text(`Gender: ${f.gender ? (f.gender === 'MALE' ? 'Male' : 'Female') : 'any'}`, 'sr:gender').row()
        .text('Show offers', 'sr:show').row()
        .text('Reset to my profile', 'sr:reset');
}

async function showMenu(ctx: Context, f: SearchFilters, edit: boolean) {
    if (edit) {
        return ctx.editMessageText(menuText(), { reply_markup: menuKeyboard(f) });
    }
    return ctx.reply(menuText(), { reply_markup: menuKeyboard(f) });
}

function pickKeyboard(field: Field, selected: string[], options: readonly string[]) {
    const kb = new InlineKeyboard();
    options.forEach((value, i) => {
        kb.text(`${selected.includes(value) ? '✅ ' : ''}${value}`, `sr:toggle:${field}:${value}`);
        if (i % 2 === 1) kb.row();
    });
    kb.row().text('All', `sr:all:${field}`).text('Clear', `sr:clear:${field}`);
    kb.row().text('Done', 'sr:menu');
    return kb;
}

export function registerSearchHandlers(bot: Bot) {
    bot.callbackQuery('menu:search', async (ctx) => {
        await ctx.answerCallbackQuery();
        const f = await fromProfile(ctx.from.id);
        filters.set(ctx.from.id, f);
        await showMenu(ctx, f, false);
    });

    bot.command('search', async (ctx) => {
        const f = await fromProfile(ctx.from!.id);
        filters.set(ctx.from!.id, f);
        await showMenu(ctx, f, false);
    });

    // Every callback below needs an active search.
    async function current(ctx: Context): Promise<SearchFilters | null> {
        const f = filters.get(ctx.from!.id);
        if (!f) {
            await ctx.answerCallbackQuery();
            await ctx.reply('Send /search to start a search.');
            return null;
        }
        return f;
    }

    bot.callbackQuery(/^sr:pick:(grades|areas)$/, async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        const field = ctx.match[1] as Field;
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Choose ${LABEL[field].toLowerCase()}:`, {
            reply_markup: pickKeyboard(field, f[field], OPTIONS[field]),
        });
    });

    bot.callbackQuery(/^sr:toggle:(grades|areas):(.+)$/, async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        const field = ctx.match[1] as Field;
        const value = ctx.match[2];
        if (await ignoreRapidRepeat(ctx, `toggle:${field}:${value}`)) return;
        const list = f[field];
        f[field] = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: pickKeyboard(field, f[field], OPTIONS[field]) });
    });

    bot.callbackQuery(/^sr:all:(grades|areas)$/, async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        const field = ctx.match[1] as Field;
        if (await ignoreRapidRepeat(ctx, `all:${field}`)) return;
        f[field] = [...OPTIONS[field]];
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: pickKeyboard(field, f[field], OPTIONS[field]) });
    });

    bot.callbackQuery(/^sr:clear:(grades|areas)$/, async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        const field = ctx.match[1] as Field;
        if (await ignoreRapidRepeat(ctx, `clear:${field}`)) return;
        f[field] = [];
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: pickKeyboard(field, f[field], OPTIONS[field]) });
    });

    bot.callbackQuery('sr:menu', async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        await ctx.answerCallbackQuery();
        await showMenu(ctx, f, true);
    });

    bot.callbackQuery('sr:gender', async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        if (await ignoreRapidRepeat(ctx, 'gender')) return;
        // Cycles: any, male, female, any.
        f.gender = f.gender === null ? 'MALE' : f.gender === 'MALE' ? 'FEMALE' : null;
        await ctx.answerCallbackQuery();
        await showMenu(ctx, f, true);
    });

    bot.callbackQuery('sr:reset', async (ctx) => {
        if (await ignoreRapidRepeat(ctx, 'reset')) return;
        const f = await fromProfile(ctx.from.id);
        filters.set(ctx.from.id, f);
        await ctx.answerCallbackQuery({ text: 'Reset to your profile.' });
        await showMenu(ctx, f, true);
    });

    bot.callbackQuery('sr:show', async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        if (await ignoreRapidRepeat(ctx, 'show')) return;
        await ctx.answerCallbackQuery();

        const { rows } = await pool.query<OpenOffer>(`
            SELECT t.id, t.title, t.subject, t.subjects, t."gradeLevels", t."subCity", t."locationDetail",
                   t."sessionsPerWeek", t."sessionHours", t."salaryUnit", t."salaryAmountEtb",
                   t."monthlySalaryEtb", t."preferredTutorGender", t.requirements,
                   o."postHeader", o."postFooter", o.name AS "agencyName",
                   o."telegramUsername" AS "agencyUsername"
            FROM "TutoringOffer" t
            JOIN "Organization" o ON o.id = t."organizationId"
            WHERE t.status = 'OPEN'
              AND (cardinality($1::text[]) = 0 OR t."gradeLevels" && $1::text[])
              AND (cardinality($2::text[]) = 0 OR t."subCity" = ANY($2::text[]))
              AND ($3::text IS NULL OR t."preferredTutorGender" IS NULL OR t."preferredTutorGender" = $3::text)
            ORDER BY t."postedAt" DESC
        `, [f.grades, f.areas, f.gender]);

        const results = rows;

        if (results.length === 0) {
            return ctx.reply('No open offers match these filters. Try widening them from the menu.');
        }

        await ctx.reply(`${results.length} offer(s) found. Here are the newest ${Math.min(results.length, 10)}.`);
        for (const offer of results.slice(0, 10)) {
            await ctx.reply(offerText(offer));
        }
    });
}
