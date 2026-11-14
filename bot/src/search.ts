import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { offerMatchesSearch, type SearchFilters } from '../../shared/rules/search.js';
import { SUBJECTS } from './subjects.js';
import { GRADES } from './grades.js';
import { offerText, type OpenOffer } from './offers.js';

type Field = 'subjects' | 'grades' | 'areas';

const OPTIONS: Record<Field, string[]> = {
    subjects: SUBJECTS,
    grades: GRADES,
    areas: KNOWN_SUB_CITIES,
};

const LABEL: Record<Field, string> = {
    subjects: 'Subjects',
    grades: 'Grades',
    areas: 'Areas',
};

// Each searcher's current filters. Lost on restart, so they send /search again.
const filters = new Map<number, SearchFilters>();

// Start from the searcher's own subjects, grades and area. Gender starts at Any.
async function fromProfile(telegramId: number): Promise<SearchFilters> {
    const { rows } = await pool.query(
        `SELECT "subCity", subjects, grades FROM "TelegramSubscriber" WHERE "telegramId" = $1`,
        [telegramId]
    );
    const me = rows[0];
    return {
        subjects: me?.subjects ?? [],
        grades: me?.grades ?? [],
        areas: me?.subCity ? [me.subCity] : [],
        gender: null,
    };
}

function menuText(f: SearchFilters): string {
    return 'Search offers. Change any filter, then tap Show offers.';
}

function menuKeyboard(f: SearchFilters) {
    return new InlineKeyboard()
        .text(`Subjects: ${f.subjects.length || 'any'}`, 'sr:pick:subjects').row()
        .text(`Grades: ${f.grades.length || 'any'}`, 'sr:pick:grades').row()
        .text(`Areas: ${f.areas.length || 'any'}`, 'sr:pick:areas').row()
        .text(`Gender: ${f.gender ? (f.gender === 'MALE' ? 'Male' : 'Female') : 'any'}`, 'sr:gender').row()
        .text('Show offers', 'sr:show').row()
        .text('Reset to my profile', 'sr:reset');
}

async function showMenu(ctx: Context, f: SearchFilters, edit: boolean) {
    if (edit) {
        return ctx.editMessageText(menuText(f), { reply_markup: menuKeyboard(f) });
    }
    return ctx.reply(menuText(f), { reply_markup: menuKeyboard(f) });
}

function pickKeyboard(field: Field, selected: string[]) {
    const kb = new InlineKeyboard();
    OPTIONS[field].forEach((value, i) => {
        kb.text(`${selected.includes(value) ? '✅ ' : ''}${value}`, `sr:toggle:${field}:${value}`);
        if (i % 2 === 1) kb.row();
    });
    kb.row().text('All', `sr:all:${field}`).text('Clear', `sr:clear:${field}`);
    kb.row().text('Done', 'sr:menu');
    return kb;
}

function selectedFor(f: SearchFilters, field: Field): string[] {
    return f[field];
}

export function registerSearchHandlers(bot: Bot) {
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

    bot.callbackQuery(/^sr:pick:(subjects|grades|areas)$/, async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        const field = ctx.match[1] as Field;
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Choose ${LABEL[field].toLowerCase()}:`, {
            reply_markup: pickKeyboard(field, selectedFor(f, field)),
        });
    });

    bot.callbackQuery(/^sr:toggle:(subjects|grades|areas):(.+)$/, async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        const field = ctx.match[1] as Field;
        const value = ctx.match[2];
        const list = f[field];
        f[field] = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: pickKeyboard(field, f[field]) });
    });

    bot.callbackQuery(/^sr:all:(subjects|grades|areas)$/, async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        const field = ctx.match[1] as Field;
        f[field] = [...OPTIONS[field]];
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: pickKeyboard(field, f[field]) });
    });

    bot.callbackQuery(/^sr:clear:(subjects|grades|areas)$/, async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        const field = ctx.match[1] as Field;
        f[field] = [];
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: pickKeyboard(field, f[field]) });
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
        // Cycles: any, male, female, any.
        f.gender = f.gender === null ? 'MALE' : f.gender === 'MALE' ? 'FEMALE' : null;
        await ctx.answerCallbackQuery();
        await showMenu(ctx, f, true);
    });

    bot.callbackQuery('sr:reset', async (ctx) => {
        const f = await fromProfile(ctx.from.id);
        filters.set(ctx.from.id, f);
        await ctx.answerCallbackQuery({ text: 'Reset to your profile.' });
        await showMenu(ctx, f, true);
    });

    bot.callbackQuery('sr:show', async (ctx) => {
        const f = await current(ctx);
        if (!f) return;
        await ctx.answerCallbackQuery();

        const { rows } = await pool.query(`
            SELECT t.id, t.title, t.subjects, t."gradeLevels", t."subCity", t."locationDetail",
                   t."sessionsPerWeek", t."sessionHours", t."salaryUnit", t."salaryAmountEtb",
                   t."monthlySalaryEtb", t."preferredTutorGender", t.requirements,
                   o."postHeader", o."postFooter", o.name AS "agencyName",
                   o."telegramUsername" AS "agencyUsername"
            FROM "TutoringOffer" t
            JOIN "Organization" o ON o.id = t."organizationId"
            WHERE t.status = 'OPEN'
            ORDER BY t."postedAt" DESC
        `);

        const results: OpenOffer[] = rows.filter((o) => offerMatchesSearch(o, f));

        if (results.length === 0) {
            return ctx.reply('No open offers match these filters. Try widening them from the menu.');
        }

        await ctx.reply(`${results.length} offer(s) found. Here are the newest ${Math.min(results.length, 10)}.`);
        for (const offer of results.slice(0, 10)) {
            await ctx.reply(offerText(offer));
        }
    });
}