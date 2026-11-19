// src/sefers.ts

// Admin management of sefers: add, rename, move, link nearby sefers, delete, and review agency proposals.
import { Bot, InlineKeyboard, type Api, type Context } from 'grammy';
import { pool } from './db.js';
import { isAdmin } from './admin.js';
import { KNOWN_SUB_CITIES, getDirectNeighbours } from '../../shared/rules/nearby-areas.js';

type Pending = { kind: 'addName' } | { kind: 'addCity'; name: string } | { kind: 'rename'; id: string };

type Candidate = { id: string; name: string; subCity: string };

// The nearby picker. In add mode the sefer is created when Done is tapped; in edit mode the links of an existing sefer change.
type Picker = {
    mode: 'add' | 'edit';
    id: string | null;
    name: string;
    subCity: string;
    candidates: Candidate[];
    selected: Set<string>;
    awaiting: null | 'newName' | 'newCity';
    newName?: string;
};

const pending = new Map<number, Pending>();
const pickers = new Map<number, Picker>();

type SeferRow = { id: string; name: string; subCity: string; status: string; proposedByTelegramId: string | null };
type Reply = (text: string, other?: { reply_markup: InlineKeyboard }) => Promise<unknown>;

const adminOnly = 'This is for the NextTutor admin only.';

async function sendMenu(reply: Reply) {
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

function subCityKeyboard(prefix: string) {
    const kb = new InlineKeyboard();
    KNOWN_SUB_CITIES.forEach((city, i) => kb.text(city, `${prefix}:${i}`).row());
    return kb;
}

async function showSubCities(reply: Reply) {
    return reply('Choose a sub-city.', { reply_markup: subCityKeyboard('sf:city') });
}

async function neighbourNames(id: string): Promise<string[]> {
    const { rows } = await pool.query<{ name: string }>(
        `SELECT s.name FROM "SeferNeighbour" n JOIN "Sefer" s ON s.id = n."neighbourId"
         WHERE n."seferId" = $1 ORDER BY s.name`,
        [id]
    );
    return rows.map((r) => r.name);
}

async function showSefer(reply: Reply, id: string) {
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

// Sefers in the sub-city and its bordering sub-cities, which are the likely nearby ones.
async function candidatesFor(subCity: string, exceptId: string | null): Promise<Candidate[]> {
    const areas = [subCity, ...getDirectNeighbours(subCity)];
    const { rows } = await pool.query<Candidate>(
        `SELECT id, name, "subCity" FROM "Sefer"
         WHERE status = 'APPROVED' AND "subCity" = ANY($1::text[]) AND id IS DISTINCT FROM $2
         ORDER BY "subCity", name
         LIMIT 60`,
        [areas, exceptId]
    );
    return rows;
}

async function currentNearbyIds(id: string): Promise<string[]> {
    const { rows } = await pool.query<{ neighbourId: string }>(
        `SELECT "neighbourId" FROM "SeferNeighbour" WHERE "seferId" = $1`,
        [id]
    );
    return rows.map((r) => r.neighbourId);
}

// Replaces the nearby sefers of one sefer, keeping both directions in step.
async function writeNearby(id: string, ids: string[]) {
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
}

// Creates an approved sefer. Returns null if the name is already used.
async function createSefer(name: string, subCity: string): Promise<string | null> {
    try {
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO "Sefer" (name, "subCity", status) VALUES ($1, $2, 'APPROVED') RETURNING id`,
            [name, subCity]
        );
        return rows[0].id;
    } catch (err) {
        if ((err as { code?: string }).code === '23505') return null;
        throw err;
    }
}

function pickerText(p: Picker): string {
    const head = p.mode === 'add'
        ? `Nearby sefers for ${p.name} (${p.subCity}).`
        : `Nearby sefers for ${p.name} (${p.subCity}).`;
    const hint = p.candidates.length === 0
        ? '\nNo sefers in this area or its neighbours yet. Create one below.'
        : '';
    return `${head}\nTap to select, tap again to remove. Selected: ${p.selected.size}.${hint}`;
}

function pickerKeyboard(p: Picker): InlineKeyboard {
    const kb = new InlineKeyboard();
    p.candidates.forEach((c, i) => {
        const mark = p.selected.has(c.id) ? '✅ ' : '';
        kb.text(`${mark}${c.name} · ${c.subCity}`.slice(0, 60), `sf:pk:${i}`).row();
    });
    kb.text('Create a sefer not listed', 'sf:pnew').row();
    kb.text('Done', 'sf:pdone');
    return kb;
}

export function registerSeferHandlers(bot: Bot) {
    bot.command('sefers', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply(adminOnly);
        if (ctx.chat?.type !== 'private') return ctx.reply('Use /sefers in a private chat with the bot.');
        return sendMenu((text, other) => ctx.reply(text, other));
    });

    bot.callbackQuery('sf:menu', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return sendMenu((text, other) => ctx.reply(text, other));
    });

    bot.callbackQuery('sf:add', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        pending.set(ctx.from.id, { kind: 'addName' });
        await ctx.answerCallbackQuery();
        return ctx.reply('Type the sefer name. Send /cancel to stop.');
    });

    bot.callbackQuery('sf:browse', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        await ctx.answerCallbackQuery();
        return showSubCities((text, other) => ctx.reply(text, other));
    });

    // Browse: the approved sefers of one sub-city.
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
        kb.text('+ Add a sefer', 'sf:add');
        return ctx.reply(`${city}: ${rows.length} approved sefer(s).`, { reply_markup: kb });
    });

    // Add, step 2: the sub-city of the new sefer. Then the nearby picker.
    bot.callbackQuery(/^sf:addcity:(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const p = pending.get(ctx.from.id);
        const city = KNOWN_SUB_CITIES[Number((ctx.match as RegExpMatchArray)[1])];
        if (!p || p.kind !== 'addCity' || !city) {
            return ctx.answerCallbackQuery({ text: 'This step has expired. Send /sefers to start again.', show_alert: true });
        }
        pending.delete(ctx.from.id);
        await ctx.answerCallbackQuery();
        const picker: Picker = {
            mode: 'add', id: null, name: p.name, subCity: city,
            candidates: await candidatesFor(city, null), selected: new Set(), awaiting: null,
        };
        pickers.set(ctx.from.id, picker);
        return ctx.reply(pickerText(picker), { reply_markup: pickerKeyboard(picker) });
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

    // Edit nearby: the same picker, starting from the current links.
    bot.callbackQuery(/^sf:nby:([^:]+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const id = (ctx.match as RegExpMatchArray)[1];
        const { rows } = await pool.query<SeferRow>(
            `SELECT id, name, "subCity", status, "proposedByTelegramId"::text FROM "Sefer" WHERE id = $1`,
            [id]
        );
        if (!rows[0]) return ctx.answerCallbackQuery({ text: 'That sefer no longer exists.', show_alert: true });
        await ctx.answerCallbackQuery();
        const s = rows[0];
        const current = await currentNearbyIds(id);
        const candidates = await candidatesFor(s.subCity, id);
        const picker: Picker = {
            mode: 'edit', id, name: s.name, subCity: s.subCity,
            candidates, selected: new Set(current), awaiting: null,
        };
        pickers.set(ctx.from.id, picker);
        return ctx.reply(pickerText(picker), { reply_markup: pickerKeyboard(picker) });
    });

    // Picker: toggle one candidate.
    bot.callbackQuery(/^sf:pk:(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const p = pickers.get(ctx.from.id);
        const c = p?.candidates[Number((ctx.match as RegExpMatchArray)[1])];
        if (!p || !c) return ctx.answerCallbackQuery({ text: 'This picker has expired. Start again.', show_alert: true });
        if (p.selected.has(c.id)) p.selected.delete(c.id);
        else p.selected.add(c.id);
        await ctx.answerCallbackQuery();
        return ctx.editMessageText(pickerText(p), { reply_markup: pickerKeyboard(p) });
    });

    // Picker: create a sefer that is not listed, then pick its sub-city.
    bot.callbackQuery('sf:pnew', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const p = pickers.get(ctx.from.id);
        if (!p) return ctx.answerCallbackQuery({ text: 'This picker has expired. Start again.', show_alert: true });
        p.awaiting = 'newName';
        await ctx.answerCallbackQuery();
        return ctx.reply('Type the name of the new sefer. Send /cancel to stop.');
    });

    bot.callbackQuery(/^sf:pcity:(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const p = pickers.get(ctx.from.id);
        const city = KNOWN_SUB_CITIES[Number((ctx.match as RegExpMatchArray)[1])];
        if (!p || p.awaiting !== 'newCity' || !p.newName || !city) {
            return ctx.answerCallbackQuery({ text: 'This step has expired. Start again.', show_alert: true });
        }
        const id = await createSefer(p.newName, city);
        if (!id) {
            p.awaiting = null;
            await ctx.answerCallbackQuery();
            return ctx.reply('A sefer with this name already exists. Tap it in the list, or create a different one.');
        }
        p.candidates.unshift({ id, name: p.newName, subCity: city });
        p.selected.add(id);
        p.awaiting = null;
        p.newName = undefined;
        await ctx.answerCallbackQuery({ text: `${city === p.subCity ? 'Created.' : 'Created in ' + city + '.'}` });
        return ctx.reply(pickerText(p), { reply_markup: pickerKeyboard(p) });
    });

    // Picker: save.
    bot.callbackQuery('sf:pdone', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: adminOnly, show_alert: true });
        const p = pickers.get(ctx.from.id);
        if (!p) return ctx.answerCallbackQuery({ text: 'This picker has expired. Start again.', show_alert: true });
        await ctx.answerCallbackQuery();
        const links = [...p.selected];
        if (p.mode === 'add') {
            const id = await createSefer(p.name, p.subCity);
            if (!id) {
                pickers.delete(ctx.from.id);
                return ctx.reply('A sefer with this name already exists. Send /sefers to start again.');
            }
            await writeNearby(id, links);
        } else if (p.id) {
            await writeNearby(p.id, links);
        }
        pickers.delete(ctx.from.id);
        const count = links.length ? `${links.length} nearby sefer(s)` : 'no nearby sefers';
        return ctx.reply(p.mode === 'add'
            ? `Saved: ${p.name} in ${p.subCity} with ${count}.`
            : `Nearby sefers for ${p.name} saved: ${count}.`);
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

    // Typed answers: the add name, the rename, and the new sefer inside the picker.
    bot.on('message:text', async (ctx, next) => {
        const text = ctx.message.text.trim();
        const pick = pickers.get(ctx.from.id);
        const p = pending.get(ctx.from.id);
        if (!pick && !p) return next();
        if (text.startsWith('/')) {
            pending.delete(ctx.from.id);
            pickers.delete(ctx.from.id);
            return next();
        }
        if (!isAdmin(ctx)) {
            pending.delete(ctx.from.id);
            pickers.delete(ctx.from.id);
            return next();
        }

        if (pick && pick.awaiting === 'newName') {
            const name = text.replace(/\s+/g, ' ').slice(0, 40);
            if (name.length < 2) return ctx.reply('Please type a name with at least 2 characters.');
            const { rows } = await pool.query(`SELECT 1 FROM "Sefer" WHERE lower(name) = lower($1)`, [name]);
            if (rows[0]) return ctx.reply('A sefer with this name already exists. Tap it in the list instead.');
            pick.awaiting = 'newCity';
            pick.newName = name;
            return ctx.reply(`Which sub-city is ${name} in?`, { reply_markup: subCityKeyboard('sf:pcity') });
        }

        if (pick) return ctx.reply('Tap a button above, or send /cancel to stop.');

        if (p?.kind === 'addName') {
            const name = text.replace(/\s+/g, ' ').slice(0, 40);
            if (name.length < 2) return ctx.reply('Please type a name with at least 2 characters.');
            const { rows } = await pool.query(`SELECT 1 FROM "Sefer" WHERE lower(name) = lower($1)`, [name]);
            if (rows[0]) return ctx.reply('A sefer with this name already exists. Type a different name.');
            pending.set(ctx.from.id, { kind: 'addCity', name });
            return ctx.reply(`Which sub-city is ${name} in?`, { reply_markup: subCityKeyboard('sf:addcity') });
        }

        if (p?.kind === 'addCity') return ctx.reply('Tap the sub-city above, or send /cancel to stop.');

        if (p?.kind === 'rename') {
            const name = text.replace(/\s+/g, ' ').slice(0, 40);
            if (name.length < 2) return ctx.reply('Please type a name with at least 2 characters.');
            try {
                await pool.query(`UPDATE "Sefer" SET name = $2 WHERE id = $1`, [p.id, name]);
            } catch (err) {
                if ((err as { code?: string }).code === '23505') {
                    return ctx.reply('A sefer with this name already exists. Type a different name.');
                }
                throw err;
            }
            pending.delete(ctx.from.id);
            return ctx.reply(`Saved: ${name}.`);
        }
        return next();
    });
}
