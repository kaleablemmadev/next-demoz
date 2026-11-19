// src/admin.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { recordAuditEvent, withTransaction } from './audit.js';
import { closeOfferEverywhere } from './reposts.js';

export const ADMIN_USERNAME = 'next_tutor_admin';
const DESTINATIONS = ['GROUP', 'CHANNEL', 'BOTH'];
const MAX_POST_FAILURES = 5; // Must match reposts.ts

// Fields /editagency can change, mapped to database columns.
const FIELDS: Record<string, string> = {
    name: 'name',
    header: 'postHeader',
    footer: 'postFooter',
    group: 'groupChatId',
    channel: 'channelChatId',
    destination: 'postDestination',
};

export const ADMIN_COMMANDS = [
    { command: 'start', description: 'Open the admin menu' },
    { command: 'admin', description: 'Show the admin menu' },
    { command: 'signups', description: 'Businesses waiting for approval' },
    { command: 'agencies', description: 'List tutoring businesses' },
    { command: 'addagency', description: 'Add a tutoring business' },
    { command: 'showagency', description: 'Show one business' },
    { command: 'editagency', description: 'Change a business field' },
    { command: 'deleteagency', description: 'Delete a business' },
    { command: 'pausedoffers', description: 'Offers paused after failed posts' },
    { command: 'resumeoffer', description: 'Restart a paused offer' },
    { command: 'closeoffer', description: 'Close any offer' },
    { command: 'leaverequests', description: 'Leave requests waiting for approval' },
    { command: 'feedbacks', description: 'Latest feedback' },
    { command: 'auditlogs', description: 'Recent account lifecycle audit events' },
    { command: 'stats', description: 'Counts for tutors, businesses, parents and offers' },
    { command: 'parents', description: 'Parent contacts and their requests' },
    { command: 'help', description: 'List admin functions' },
];

export const ADMIN_HELP = [
    'NextTutor admin functions',
    '',
    '/agencies - list tutoring businesses',
    '/signups - businesses waiting for approval',
    '/addagency username Business name - add a business',
    '/showagency username - show one business',
    '/editagency username field value - change a field. Fields: name, header, footer, group, channel, destination (GROUP, CHANNEL or BOTH). Use "none" to clear a field.',
    '/deleteagency username - delete a business with no offers or placement/subscription history',
    '/pausedoffers - offers paused after failed posts',
    '/resumeoffer offer-id - restart a paused offer',
    '/closeoffer offer-id - close any offer',
    '/leaverequests - leave requests waiting for approval',
    '/feedbacks - latest feedback from tutors and businesses',
    '/auditlogs - recent account lifecycle events (no personal identifiers)',
    '/stats - counts for tutors, businesses, parents and offers',
    '/parents - parent contacts and their latest requests',
    '/admin - show the admin menu',
    '/help - show this list',
].join('\n');

export function isAdmin(ctx: Context): boolean {
    return (ctx.from?.username ?? '').toLowerCase() === ADMIN_USERNAME;
}

export function isAdminUsername(username: string | undefined): boolean {
    return (username ?? '').toLowerCase() === ADMIN_USERNAME;
}

function normalize(username: string | undefined): string {
    return (username ?? '').replace(/^@/, '').trim();
}

// The words after a command, split on spaces.
function args(ctx: Context): string[] {
    return (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
}

type AgencyRow = {
    id: string;
    name: string;
    telegramUsername: string;
    postDestination: string;
    groupChatId: string | null;
    channelChatId: string | null;
};

async function findAgency(username: string): Promise<AgencyRow | null> {
    const { rows } = await pool.query<AgencyRow>(
        `SELECT id, name, "telegramUsername", COALESCE("postDestination", 'GROUP') AS "postDestination",
                "groupChatId", "channelChatId"
         FROM "Organization" WHERE lower("telegramUsername") = lower($1)`,
        [username]
    );
    return rows[0] ?? null;
}

async function hasAgencyHistory(orgId: string): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT
            EXISTS (SELECT 1 FROM "Assignment" WHERE "organizationId" = $1) AS has_assignments,
            EXISTS (SELECT 1 FROM "Subscription" WHERE "organizationId" = $1) AS has_subscriptions`,
        [orgId],
    );
    return Boolean(rows[0]?.has_assignments || rows[0]?.has_subscriptions);
}

async function offerCount(orgId: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM "TutoringOffer" WHERE "organizationId" = $1`,
        [orgId]
    );
    return rows[0].n;
}

async function listAgencies(ctx: Context) {
    const { rows } = await pool.query(`
        SELECT o.name, o."telegramUsername",
               COALESCE(o."postDestination", 'GROUP') AS dest,
               (o."groupChatId" IS NOT NULL) AS "hasGroup",
               (o."channelChatId" IS NOT NULL) AS "hasChannel",
               (SELECT count(*)::int FROM "TutoringOffer" t
                WHERE t."organizationId" = o.id AND t.status = 'OPEN') AS open
        FROM "Organization" o
        ORDER BY o.name
    `);

    if (rows.length === 0) {
        return ctx.reply('No tutoring businesses yet. Add one with /addagency.');
    }

    const lines = rows.map(
        (r, i) =>
            `${i + 1}. ${r.name} · @${r.telegramUsername}\n` +
            `   ${r.dest} · group ${r.hasGroup ? 'set' : 'not set'} · channel ${r.hasChannel ? 'set' : 'not set'} · ${r.open} open offers`
    );
    return ctx.reply(lines.join('\n\n'));
}

// Latest parents with their contact and most recent request. Admin-only views.
async function parentRows(limit: number) {
    const { rows } = await pool.query(
        `SELECT p."contactHandle", p."telegramUsername", p."createdAt",
                (SELECT count(*)::int FROM "ParentRequest" r WHERE r."parentId" = p.id) AS requests,
                (SELECT r.status FROM "ParentRequest" r WHERE r."parentId" = p.id
                 ORDER BY r."createdAt" DESC LIMIT 1) AS "lastStatus",
                (SELECT r."gradeLevel" || ', ' || r."subCity" FROM "ParentRequest" r WHERE r."parentId" = p.id
                 ORDER BY r."createdAt" DESC LIMIT 1) AS "lastRequest"
         FROM "Parent" p
         ORDER BY p."createdAt" DESC
         LIMIT $1`,
        [limit]
    );
    return rows;
}

function parentLine(p: { contactHandle: string | null; telegramUsername: string | null; requests: number; lastStatus: string | null; lastRequest: string | null }, i: number) {
    const contact = p.contactHandle ?? 'no contact on file';
    const user = p.telegramUsername ? ` · @${p.telegramUsername}` : '';
    const last = p.lastRequest ? `last: ${p.lastRequest} (${p.lastStatus ?? '-'})` : 'no requests yet';
    return `${i + 1}. ${contact}${user}\n   ${p.requests} request(s) · ${last}`;
}

async function showParents(ctx: Context, limit: number) {
    const rows = await parentRows(limit);
    if (rows.length === 0) return ctx.reply('No parents yet.');
    return ctx.reply(
        `Latest parents (${rows.length}, newest first)\n\n` + rows.map((p, i) => parentLine(p, i)).join('\n\n')
    );
}

async function showStats(ctx: Context) {
    const { rows } = await pool.query(`
        SELECT (SELECT count(*)::int FROM "TelegramSubscriber") AS tutors,
               (SELECT count(*)::int FROM "TelegramSubscriber" WHERE status = 'ACTIVE') AS "activeTutors",
               (SELECT count(*)::int FROM "Organization") AS agencies,
               (SELECT count(*)::int FROM "TutoringOffer" WHERE status = 'OPEN') AS "openOffers",
               (SELECT count(*)::int FROM "TutoringOffer" WHERE status = 'OPEN' AND "postFailures" >= $1) AS paused,
               (SELECT count(*)::int FROM "Parent") AS parents,
               (SELECT count(DISTINCT "parentId")::int FROM "ParentRequest" WHERE "parentId" IS NOT NULL) AS "parentsWithRequests",
               (SELECT count(*)::int FROM "ParentRequest") AS requests,
               (SELECT count(*)::int FROM "ParentRequest" WHERE status = 'OPEN') AS "requestsWaiting",
               (SELECT count(*)::int FROM "ParentRequest" WHERE status = 'PLACED') AS "requestsPlaced"
    `, [MAX_POST_FAILURES]);
    const s = rows[0];
    const latest = await parentRows(5);
    const latestText = latest.length === 0
        ? 'none yet'
        : '\n' + latest.map((p, i) => parentLine(p, i)).join('\n');
    return ctx.reply(
        `Stats\n\n` +
        `Tutors: ${s.tutors} (${s.activeTutors} active)\n` +
        `Businesses: ${s.agencies}\n` +
        `Open offers: ${s.openOffers}\n` +
        `Paused offers: ${s.paused}\n\n` +
        `Parents: ${s.parents} (${s.parentsWithRequests} with requests)\n` +
        `Requests: ${s.requests} total, ${s.requestsWaiting} waiting for an agency, ${s.requestsPlaced} placed\n\n` +
        `Latest parents:${latestText}`
    );
}

async function listPaused(ctx: Context) {
    const { rows } = await pool.query(
        `SELECT t.id, t.title, o."telegramUsername" AS agency, t."postFailures"
         FROM "TutoringOffer" t
         JOIN "Organization" o ON o.id = t."organizationId"
         WHERE t.status = 'OPEN' AND t."postFailures" >= $1`,
        [MAX_POST_FAILURES]
    );

    if (rows.length === 0) return ctx.reply('No paused offers.');

    const lines = rows.map(
        (r, i) => `${i + 1}. ${r.title} · @${r.agency}\n   Offer ID: ${r.id} · ${r.postFailures} failed posts`
    );
    return ctx.reply(`Paused offers. Restart one with /resumeoffer offer-id.\n\n${lines.join('\n\n')}`);
}

export async function showAdminMenu(ctx: Context) {
    await ctx.api.setMyCommands(ADMIN_COMMANDS, {
        scope: { type: 'chat', chat_id: ctx.chat!.id },
    });
    return ctx.reply('Admin menu', {
        reply_markup: new InlineKeyboard()
            .text('Businesses', 'adm:agencies')
            .text('Stats', 'adm:stats')
            .row()
            .text('Paused offers', 'adm:paused')
            .text('Parents', 'adm:parents')
            .text('Help', 'adm:help'),
    });
}

// Only the admin account can run these, even if someone types the command.
function adminOnly(handler: (ctx: Context) => Promise<unknown>) {
    return async (ctx: Context) => {
        if (!isAdmin(ctx)) return ctx.reply('This command is for admins only.');
        return handler(ctx);
    };
}

function adminCallback(handler: (ctx: Context) => Promise<unknown>) {
    return async (ctx: Context) => {
        if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true });
        return handler(ctx);
    };
}

export function registerAdminHandlers(bot: Bot) {
    bot.command('admin', adminOnly(showAdminMenu));
    bot.command('agencies', adminOnly(listAgencies));
    bot.command('stats', adminOnly(showStats));
    bot.command('parents', adminOnly((ctx) => showParents(ctx, 20)));
    bot.command('pausedoffers', adminOnly(listPaused));

    // CREATE
    bot.command(
        'addagency',
        adminOnly(async (ctx) => {
            const [rawUser, ...nameParts] = args(ctx);
            const username = normalize(rawUser);
            const name = nameParts.join(' ');

            if (!username || !name) {
                return ctx.reply('Usage: /addagency username Business name');
            }
            if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
                return ctx.reply('That is not a valid Telegram username.');
            }
            if (await findAgency(username)) {
                return ctx.reply('A business with that username already exists.');
            }

            await pool.query(
                `INSERT INTO "Organization" (id, name, "telegramUsername") VALUES ($1, $2, $3)`,
                [randomUUID(), name, username]
            );
            return ctx.reply(
                `Added ${name} (@${username}).\nSet its group with: /editagency ${username} group -100XXXXXXXXXX`
            );
        })
    );

    // READ
    bot.command(
        'showagency',
        adminOnly(async (ctx) => {
            const [rawUser] = args(ctx);
            if (!rawUser) return ctx.reply('Usage: /showagency username');

            const a = await findAgency(normalize(rawUser));
            if (!a) return ctx.reply('No business with that username.');

            return ctx.reply(
                `${a.name}\n@${a.telegramUsername}\n` +
                `Destination: ${a.postDestination}\n` +
                `Group: ${a.groupChatId ?? 'not set'}\n` +
                `Channel: ${a.channelChatId ?? 'not set'}`
            );
        })
    );

    // UPDATE
    bot.command(
        'editagency',
        adminOnly(async (ctx) => {
            const [rawUser, rawField, ...valueParts] = args(ctx);
            const column = FIELDS[(rawField ?? '').toLowerCase()];

            if (!rawUser || !column || valueParts.length === 0) {
                return ctx.reply(
                    'Usage: /editagency username field value\n' +
                    `Fields: ${Object.keys(FIELDS).join(', ')}\n` +
                    'Use "none" to clear a field other than name or destination.'
                );
            }

            const agency = await findAgency(normalize(rawUser));
            if (!agency) return ctx.reply('No business with that username.');

            let value: string | null = valueParts.join(' ');

            if (value.toLowerCase() === 'none') {
                if (column === 'name' || column === 'postDestination') {
                    return ctx.reply('That field cannot be cleared.');
                }
                value = null;
            } else if (column === 'groupChatId' || column === 'channelChatId') {
                if (!/^-?\d+$/.test(value)) {
                    return ctx.reply('Chat IDs are numbers, for example -1001234567890.');
                }
            } else if (column === 'postDestination') {
                value = value.toUpperCase();
                if (!DESTINATIONS.includes(value)) {
                    return ctx.reply('Destination must be GROUP, CHANNEL or BOTH.');
                }
            }

            // The column name comes from the fixed FIELDS list above, so it is safe to place in the query.
            await pool.query(`UPDATE "Organization" SET "${column}" = $2 WHERE id = $1`, [agency.id, value]);
            return ctx.reply(`Updated ${rawField} for @${agency.telegramUsername}.`);
        })
    );

    // DELETE (asks for confirmation)
    bot.command(
        'deleteagency',
        adminOnly(async (ctx) => {
            const [rawUser] = args(ctx);
            if (!rawUser) return ctx.reply('Usage: /deleteagency username');

            const agency = await findAgency(normalize(rawUser));
            if (!agency) return ctx.reply('No business with that username.');

            const offers = await offerCount(agency.id);
            if (offers > 0) {
                return ctx.reply(
                    `Cannot delete @${agency.telegramUsername}: it has ${offers} offer(s) in the database. ` +
                    'Use the account departure flow so public posts and history are handled safely.'
                );
            }
            if (await hasAgencyHistory(agency.id)) {
                return ctx.reply('This business has placement or subscription history. Use /leave and the settlement approval flow; its history will be retained in anonymized form.');
            }

            return ctx.reply(`Delete ${agency.name} (@${agency.telegramUsername})? This cannot be undone.`, {
                reply_markup: new InlineKeyboard()
                    .text('Yes, delete', `adm:delete:${agency.id}`)
                    .text('Cancel', 'adm:cancel'),
            });
        })
    );

    bot.callbackQuery(
        /^adm:delete:(.+)$/,
        adminCallback(async (ctx) => {
            const id = (ctx.match as RegExpMatchArray)[1];
            const outcome = await withTransaction(async (client) => {
                const { rows } = await client.query<{ name: string; auditRef: string; telegramUserId: string | null }>(
                    `SELECT name, "auditRef", "telegramUserId" FROM "Organization" WHERE id = $1 FOR UPDATE`,
                    [id],
                );
                if (!rows[0]) return { deleted: false, missing: true, name: null };

                const { rows: checks } = await client.query(
                    `SELECT
                        EXISTS (SELECT 1 FROM "TutoringOffer" WHERE "organizationId" = $1) AS has_offers,
                        EXISTS (SELECT 1 FROM "Assignment" WHERE "organizationId" = $1) AS has_assignments,
                        EXISTS (SELECT 1 FROM "Subscription" WHERE "organizationId" = $1) AS has_subscriptions`,
                    [id],
                );
                if (checks[0]?.has_offers || checks[0]?.has_assignments || checks[0]?.has_subscriptions) {
                    return { deleted: false, missing: false, name: rows[0].name };
                }

                await recordAuditEvent(client, {
                    actorRef: rows[0].auditRef,
                    actorType: 'AGENCY',
                    action: 'ACCOUNT_DELETED_BY_ADMIN',
                    entityType: 'ORGANIZATION',
                    entityRef: id,
                });
                await client.query(`DELETE FROM "LeaveRequest" WHERE "organizationId" = $1`, [id]);
                await client.query(`DELETE FROM "OrganizationEvent" WHERE "organizationId" = $1`, [id]);
                if (rows[0].telegramUserId) {
                    await client.query(`DELETE FROM "Feedback" WHERE "fromTelegramId" = $1`, [rows[0].telegramUserId]);
                    await client.query(`DELETE FROM "BusinessSignup" WHERE "telegramId" = $1`, [rows[0].telegramUserId]);
                    await client.query(`DELETE FROM "SignupChat" WHERE "telegramId" = $1`, [rows[0].telegramUserId]);
                }
                await client.query(`DELETE FROM "Organization" WHERE id = $1`, [id]);
                return { deleted: true, missing: false, name: rows[0].name };
            });

            if (outcome.missing) {
                await ctx.answerCallbackQuery();
                return ctx.editMessageText('That business no longer exists.');
            }
            if (!outcome.deleted) {
                await ctx.answerCallbackQuery({ text: 'Offers or history now exist.', show_alert: true });
                return ctx.editMessageText('Not deleted: offers or placement/subscription history now exist. Use the leave workflow.');
            }

            await ctx.answerCallbackQuery({ text: 'Deleted.' });
            return ctx.editMessageText(`Deleted ${outcome.name}. An audit event was retained.`);
        })
    );

    bot.callbackQuery(
        'adm:cancel',
        adminCallback(async (ctx) => {
            await ctx.answerCallbackQuery({ text: 'Cancelled.' });
            return ctx.editMessageText('Cancelled. Nothing was deleted.');
        })
    );

    // OFFER ADMIN
    bot.command(
        'resumeoffer',
        adminOnly(async (ctx) => {
            const [id] = args(ctx);
            if (!id) return ctx.reply('Usage: /resumeoffer offer-id');

            const { rows } = await pool.query(
                `UPDATE "TutoringOffer" SET "postFailures" = 0 WHERE id = $1 RETURNING id`,
                [id]
            );
            if (rows.length === 0) return ctx.reply('No offer with that ID.');
            return ctx.reply('Offer restarted. It will be posted again within a minute.');
        })
    );

    bot.command(
        'closeoffer',
        adminOnly(async (ctx) => {
            const [id] = args(ctx);
            if (!id) return ctx.reply('Usage: /closeoffer offer-id');

            const { rows } = await pool.query(`SELECT id FROM "TutoringOffer" WHERE id = $1`, [id]);
            if (rows.length === 0) return ctx.reply('No offer with that ID.');

            // Closes the offer in the database and updates its group and channel posts.
            await closeOfferEverywhere(ctx.api, id);
            return ctx.reply('Offer closed. Its group and channel posts were updated.');
        })
    );

    // Menu buttons
    bot.callbackQuery('adm:agencies', adminCallback(async (ctx) => { await ctx.answerCallbackQuery(); return listAgencies(ctx); }));
    bot.callbackQuery('adm:stats', adminCallback(async (ctx) => { await ctx.answerCallbackQuery(); return showStats(ctx); }));
    bot.callbackQuery('adm:parents', adminCallback(async (ctx) => { await ctx.answerCallbackQuery(); return showParents(ctx, 20); }));
    bot.callbackQuery('adm:paused', adminCallback(async (ctx) => { await ctx.answerCallbackQuery(); return listPaused(ctx); }));
    bot.callbackQuery('adm:help', adminCallback(async (ctx) => { await ctx.answerCallbackQuery(); return ctx.reply(ADMIN_HELP); }));
}