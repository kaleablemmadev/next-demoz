// src/sefers.ts

// Admin management of sefers: add, rename, move, set nearby sefers, delete, and review agency proposals.
import { Bot, InlineKeyboard, type Api, type Context } from 'grammy';
import { pool } from './db.js';
import { isAdmin } from './admin.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';

type Pending =
    | { kind: 'name'; subCity: string }
    | { kind: 'rename'; id: string }
    | { kind: 'nearby'; id: string };

const pending = new Map<number, Pending>();

type SeferRow = { id: string; name: string; subCity: string; status: string; proposedByTelegramId: string | null };

const adminOnly = 'This is for the NextTutor admin only.';

async function sendMenu(reply: (text: string, other?: { reply_markup: InlineKeyboard }) => Promise<unknown>) {
    const { rows } = await pool.query<{ pending: number; approved: number }>(
        `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                count(*) FILTER (WHERE status = 'APPROVED')::int AS approved
         FROM "Sefer"`
    );
    const c = rows[0];
    return reply(
        `Sefers: ${c.approved} approved, ${c.pending} waiting for review.\n\n` +
        'Sefers are used to order offers and digests. They never decide matching.',
        {
            reply_markup: new InlineKeyboard()
                .text('Add sefer', 'sf:add')
                .row()
                .text(`Review proposals (${c.pending})`, 'sf:review')
                .row()
                .text('Browse by sub-city', 'sf:browse'),
        }
    );
}

async function showSubCities(reply: (text: string, other?: { reply_markup: InlineKeyboard }) => Promise<unknown>) {
    const kb = new InlineKeyboard();
    KNOWN_SUB_CITIES.forEach((city, i) => kb.text(city, `sf:city:${i}`).row());
    return reply('Choose a sub-city.', { reply_markup: kb });
}

async function neighbourNames(id: string): Promise<string[]> {
    const { rows } = await pool.query<{ name: string }>(
        `SELECT s.name FROM "SeferNeighbour" n JOIN "Sefer" s ON s.id = n."neighbourId"
         WHERE n."seferId" = $1 ORDER BY s.name`,
        [id]
    );
    return rows.map((r) => r.name);
}

async function showSefer(
    reply: (text: string, other?: { reply_markup: InlineKeyboard }) => Promise<unknown>,
    id: string
) {
    const { rows } = await pool.query<SeferRow>(
        `SELECT id, name, "subCity", status, "proposedByTelegramId"::text FROM "Sefer" WHERE id = $1`,
        [id]
    );
    const s = rows[0];
    if (!s) return reply('That sefer no longer exists.');
    const nearby = await neighbourNames(id);
    const kb = new InlineKeyboard()
        .text('Rename', `sf:ren:${id}`)
        .text('Change sub-city', `sf:cty:${id}`)
        .row()
        .text('Set nearby sefers', `sf:nby:${id}`)
        .text('Delete', `sf:del:${id}`);
    if (s.status === 'PENDING') {
        kb.row().text('Approve', `sf:ok:${id}`).text('Reject', `sf:no:${id}`);
    }
    return reply(
        `${s.name}\nSub-city: ${s.subCity}\nStatus: ${s.status.toLowerCase()}\n` +
        `Nearby: ${nearby.length ? nearby.join(', ') : 'none set'}`,
        { reply_markup: kb }
    );
}

// Tells the agency that proposed a sefer what was decided. Failures are logged, not raised.
async function tellProposer(api: Api, telegramId: string | null, text: string) {
    if (!telegramId) return;
    try {
        await api.sendMessage(Number(telegramId), text);
    } catch (err) {
        console.error('Could not tell the agency about the sefer decision:', err);
    }
}

// Replaces the nearby sefers of one sefer, keeping both directions in step.
async function setNearby(id: string, names: string[]): Promise<{ saved: boolean; unknown: string[] }> {
    const wanted = names.map((n) => n.trim()).filter(Boolean);
    const unknown: string[] = [];
    const ids: string[] = [];

    for (const name of wanted) {
        const { rows } = await pool.query<{ id: string }>(
            `SELECT id FROM "Sefer" WHERE lower(name) = lower($1) AND status = 'APPROVED' AND id <> $2`,
            [name, id]
        );
        if (rows[0]) ids.push(rows[0].id);
        else unknown.push(name);
    }
    if (unknown.length > 0) return { saved: false, unknown };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM "SeferNeighbour" WHERE "seferId" = $1 OR "neighbourId" = $1`, [id]);
        for (const other of ids) {
            await client.query(
                `INSERT INTO "SeferNeighbour" ("seferId", "neighbourId") VALUES ($1, $2), ($2, $1)
                 ON CONFLICT DO NOTHING`,
                [id, other]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
    return { saved: true, unknown: [] };
}

export function registerSeferHandlers(bot: Bot) {
    bot.callbackQuery('sf:menu', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return sendMenu((text, other) => ctx.reply(text, other));
    });

    bot.command('sefers', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply(adminOnly);
        if (ctx.chat?.type !== 'private') return ctx.reply('Use /sefers in a private chat with the bot.');
        return sendMenu((text, other) => ctx.reply(text, other));
    });

    bot.callbackQuery('sf:add', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return showSubCities((text, other) => ctx.reply(text, other)).then(() => undefined);
    });

    bot.callbackQuery('sf:browse', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return showSubCities((text, other) => ctx.reply(text, other));
    });

    // Add flow: the sub-city is chosen by index, then the name is typed.
    bot.callbackQuery(/^sf:city:(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const city = KNOWN_SUB_CITIES[Number((ctx.match as RegExpMatchArray)[1])];
        if (!city) return ctx.answerCallbackQuery({ text: 'Unknown sub-city.', show_alert: true });
        await ctx.answerCallbackQuery();
        const { rows } = await pool.query<SeferRow>(
            `SELECT id, name, "subCity", status, "proposedByTelegramId"::text FROM "Sefer"
             WHERE "subCity" = $1 AND status = 'APPROVED' ORDER BY name`,
            [city]
        );
        const kb = new InlineKeyboard();
        for (const s of rows) kb.text(s.name, `sf:view:${s.id}`).row();
        kb.text('+ Add a sefer in ' + city, `sf:new:${KNOWN_SUB_CITIES.indexOf(city as never)}`);
        return ctx.reply(`${city}: ${rows.length} approved sefer(s).`, { reply_markup: kb });
    });

    bot.callbackQuery(/^sf:new:(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const city = KNOWN_SUB_CITIES[Number((ctx.match as RegExpMatchArray)[1])];
        if (!city) return ctx.answerCallbackQuery({ text: 'Unknown sub-city.', show_alert: true });
        pending.set(ctx.from.id, { kind: 'name', subCity: city });
        await ctx.answerCallbackQuery();
        return ctx.reply(`Type the sefer name for ${city}. Send /cancel to stop.`);
    });

    bot.callbackQuery(/^sf:view:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return showSefer((text, other) => ctx.reply(text, other), (ctx.match as RegExpMatchArray)[1]);
    });

    bot.callbackQuery(/^sf:ren:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        pending.set(ctx.from.id, { kind: 'rename', id: (ctx.match as RegExpMatchArray)[1] });
        await ctx.answerCallbackQuery();
        return ctx.reply('Type the new name. Send /cancel to stop.');
    });

    bot.callbackQuery(/^sf:nby:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        pending.set(ctx.from.id, { kind: 'nearby', id: (ctx.match as RegExpMatchArray)[1] });
        await ctx.answerCallbackQuery();
        return ctx.reply(
            'Type the nearby sefers, separated by commas. They must be approved sefers. ' +
            'Type "none" to clear them. Send /cancel to stop.'
        );
    });

    bot.callbackQuery(/^sf:cty:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const id = (ctx.match as RegExpMatchArray)[1];
        await ctx.answerCallbackQuery();
        const kb = new InlineKeyboard();
        KNOWN_SUB_CITIES.forEach((city, i) => kb.text(city, `sf:setcity:${id}:${i}`).row());
        return ctx.reply('Move this sefer to which sub-city?', { reply_markup: kb });
    });

    bot.callbackQuery(/^sf:setcity:([^:]+):(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const [, id, idx] = ctx.match as RegExpMatchArray;
        const city = KNOWN_SUB_CITIES[Number(idx)];
        if (!city) return ctx.answerCallbackQuery({ text: 'Unknown sub-city.', show_alert: true });
        // Nearby links may cross sub-cities, so they are kept. Only the sub-city changes.
        await pool.query(`UPDATE "Sefer" SET "subCity" = $2 WHERE id = $1`, [id, city]);
        await ctx.answerCallbackQuery({ text: `Moved to ${city}.` });
        return showSefer((text, other) => ctx.reply(text, other), id);
    });

    bot.callbackQuery(/^sf:del:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const id = (ctx.match as RegExpMatchArray)[1];
        await ctx.answerCallbackQuery();
        return ctx.reply('Delete this sefer? Offers and tutors that use it will have no sefer and will be sorted by sub-city only.', {
            reply_markup: new InlineKeyboard().text('Yes, delete', `sf:delok:${id}`).text('Cancel', 'sf:browse'),
        });
    });

    bot.callbackQuery(/^sf:delok:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const id = (ctx.match as RegExpMatchArray)[1];
        const { rowCount } = await pool.query(`DELETE FROM "Sefer" WHERE id = $1`, [id]);
        await ctx.answerCallbackQuery();
        return ctx.reply(rowCount ? 'Sefer deleted.' : 'That sefer was already deleted.');
    });

    bot.callbackQuery('sf:review', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        const { rows } = await pool.query<SeferRow>(
            `SELECT id, name, "subCity", status, "proposedByTelegramId"::text FROM "Sefer"
             WHERE status = 'PENDING' ORDER BY "createdAt"`
        );
        if (rows.length === 0) return ctx.reply('No sefer proposals are waiting.');
        for (const s of rows) {
            await ctx.reply(`Proposed: ${s.name}\nSub-city: ${s.subCity}`, {
                reply_markup: new InlineKeyboard().text('Approve', `sf:ok:${s.id}`).text('Reject', `sf:no:${s.id}`),
            });
        }
    });

    bot.callbackQuery(/^sf:(ok|no):([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const [, action, id] = ctx.match as RegExpMatchArray;
        const status = action === 'ok' ? 'APPROVED' : 'REJECTED';
        const { rows } = await pool.query<SeferRow>(
            `UPDATE "Sefer" SET status = $2, "reviewedAt" = now()
             WHERE id = $1 AND status = 'PENDING'
             RETURNING id, name, "subCity", status, "proposedByTelegramId"::text`,
            [id, status]
        );
        await ctx.answerCallbackQuery();
        const s = rows[0];
        if (!s) return ctx.editMessageText('This proposal was already reviewed.');
        await tellProposer(
            ctx.api,
            s.proposedByTelegramId,
            status === 'APPROVED'
                ? `The sefer you proposed, ${s.name}, has been approved. Offers and digests now use it for sorting.`
                : `The sefer you proposed, ${s.name}, was not approved. Offers that use it are sorted by sub-city only.`
        );
        return ctx.editMessageText(`${s.name}: ${status === 'APPROVED' ? 'approved' : 'rejected'}.`);
    });

    // Typed answers for the add, rename and nearby steps.
    bot.on('message:text', async (ctx, next) => {
        const p = pending.get(ctx.from.id);
        if (!p) return next();
        const text = ctx.message.text.trim();
        if (text.startsWith('/')) {
            pending.delete(ctx.from.id);
            return next();
        }
        if (!isAdmin(ctx)) {
            pending.delete(ctx.from.id);
            return next();
        }

        if (p.kind === 'name' || p.kind === 'rename') {
            const name = text.replace(/\s+/g, ' ').slice(0, 40);
            if (name.length < 2) return ctx.reply('Please type a name with at least 2 characters.');
            try {
                if (p.kind === 'name') {
                    await pool.query(
                        `INSERT INTO "Sefer" (name, "subCity", status) VALUES ($1, $2, 'APPROVED')`,
                        [name, p.subCity]
                    );
                } else {
                    await pool.query(`UPDATE "Sefer" SET name = $2 WHERE id = $1`, [p.id, name]);
                }
            } catch (err) {
                if ((err as { code?: string }).code === '23505') {
                    return ctx.reply('A sefer with this name already exists. Type a different name.');
                }
                throw err;
            }
            pending.delete(ctx.from.id);
            return ctx.reply(`Saved: ${name}.`);
        }

        // Nearby sefers
        const names = text.toLowerCase() === 'none' ? [] : text.split(',');
        const result = await setNearby(p.id, names);
        if (!result.saved) {
            return ctx.reply(`These are not approved sefers: ${result.unknown.join(', ')}. Check the names and type them again.`);
        }
        pending.delete(ctx.from.id);
        return ctx.reply('Nearby sefers saved.');
    });
}
