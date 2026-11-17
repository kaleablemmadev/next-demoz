// src/leave.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { findAgencyByUsername, findAgencyForUser } from './roles.js';
import { startPersonalDeparture, registerPersonalDepartureCallbacks } from './account-departure.js';
import { recordAuditEvent, withTransaction } from './audit.js';
import { isAdmin } from './admin.js';
import { closeOfferEverywhere } from './reposts.js';

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);

const AGENCY_REASONS: [string, string][] = [
    ['NO_TUTORS', 'Not getting enough tutors'],
    ['NO_STUDENTS', 'Not getting enough students'],
    ['PRICE', 'Too expensive'],
    ['TECH', 'Technical problems'],
    ['OTHER', 'Other'],
];

const TUTOR_REASONS: [string, string][] = [
    ['NO_OFFERS', 'Not getting enough offers'],
    ['FOUND_WORK', 'Found work or a tutoring job'],
    ['TECH', 'Technical problems'],
    ['OTHER', 'Other'],
];

const FEEDBACK_CATEGORIES: [string, string][] = [
    ['BUG', 'Bug'],
    ['IDEA', 'Idea'],
    ['COMPLAINT', 'Complaint'],
    ['OTHER', 'Other'],
];

// Waiting for a typed reply, keyed by Telegram user ID.
type Pending = { kind: 'leaveNote'; reason: string } | { kind: 'feedback'; category: string };
const pending = new Map<number, Pending>();

function labelOf(code: string): string {
    return [...AGENCY_REASONS, ...TUTOR_REASONS].find(([c]) => c === code)?.[1] ?? code;
}

function buttons(prefix: string, options: [string, string][]) {
    const kb = new InlineKeyboard();
    options.forEach(([code, label]) => kb.text(label, `${prefix}:${code}`).row());
    return kb;
}

// Shown to tutors after /reset erases their data.
export function tutorLeaveKeyboard() {
    return buttons('leftreason', TUTOR_REASONS).text('Skip', 'leftreason:skip');
}

async function notifyAdmin(ctx: Context, text: string, keyboard?: InlineKeyboard) {
    if (!ADMIN_TELEGRAM_ID) {
        console.error('ADMIN_TELEGRAM_ID is not set, so the admin was not told:', text);
        return;
    }
    try {
        await ctx.api.sendMessage(ADMIN_TELEGRAM_ID, text, keyboard ? { reply_markup: keyboard } : undefined);
    } catch (err) {
        console.error('Could not message the admin:', err);
    }
}

async function createLeaveRequest(ctx: Context, reason: string, note: string | null) {
    const agency = ctx.from ? await findAgencyForUser(ctx.from.id, ctx.from.username) : null;
    if (!agency) return ctx.reply('Only registered tutoring businesses can request to leave.');

    const { rows } = await pool.query(
        `INSERT INTO "LeaveRequest" ("organizationId", "reasonCode", "reasonText") VALUES ($1, $2, $3) RETURNING id`,
        [agency.id, reason, note]
    );
    const requestId = rows[0].id;
    pending.delete(ctx.from!.id);

    await notifyAdmin(
        ctx,
        `Leave request from ${agency.name} (@${agency.telegramUsername})\n` +
        `Reason: ${labelOf(reason)}` +
        (note ? `\nNote: ${note}` : '') +
        '\n\nTheir offers stay open until you approve.',
        new InlineKeyboard()
            .text('Approve', `leave:approve:${requestId}`)
            .text('Reject', `leave:reject:${requestId}`)
    );

    return ctx.reply(
        'Your request was sent to NextTutor. Your offers stay open until it is approved. ' +
        'You will get a message when it is done.'
    );
}

// Agency: /leave
async function startLeave(ctx: Context) {
    if (!ctx.from) return;
    const agency = await findAgencyForUser(ctx.from.id, ctx.from.username);
    if (!agency) return startPersonalDeparture(ctx);

    const { rows } = await pool.query(
        `SELECT 1 FROM "LeaveRequest" WHERE "organizationId" = $1 AND status = 'PENDING'`,
        [agency.id]
    );
    if (rows.length > 0) {
        return ctx.reply('You already have a leave request waiting for approval.');
    }

    return ctx.reply('Why are you leaving NextTutor? Your offers stay open until the admin confirms.', {
        reply_markup: buttons('leave:reason', AGENCY_REASONS),
    });
}

// Tutor or agency: /feedback
async function startFeedback(ctx: Context) {
    return ctx.reply('What is your feedback about?', {
        reply_markup: buttons('fb:cat', FEEDBACK_CATEGORIES),
    });
}

// Admin: list pending leave requests, each with Approve and Reject.
async function listLeaveRequests(ctx: Context) {
    const { rows } = await pool.query(`
        SELECT r.id, r."reasonCode", r."reasonText", r."requestedAt", o.name, o."telegramUsername"
        FROM "LeaveRequest" r
                 JOIN "Organization" o ON o.id = r."organizationId"
        WHERE r.status = 'PENDING'
        ORDER BY r."requestedAt" ASC
    `);

    if (rows.length === 0) return ctx.reply('No leave requests waiting.');

    for (const r of rows) {
        await ctx.reply(
            `${r.name} (@${r.telegramUsername})\nReason: ${labelOf(r.reasonCode)}` +
            (r.reasonText ? `\nNote: ${r.reasonText}` : ''),
            {
                reply_markup: new InlineKeyboard()
                    .text('Approve', `leave:approve:${r.id}`)
                    .text('Reject', `leave:reject:${r.id}`),
            }
        );
    }
}

// Admin: list the latest feedback.
async function listFeedback(ctx: Context) {
    const { rows } = await pool.query(`
        SELECT role, category, message, "fromUsername", "createdAt"
        FROM "Feedback" ORDER BY "createdAt" DESC LIMIT 20
    `);

    if (rows.length === 0) return ctx.reply('No feedback yet.');

    const lines = rows.map(
        (r) =>
            `${new Date(r.createdAt).toISOString().slice(0, 10)} · ${r.role} · ${r.category}\n` +
            `${r.fromUsername ? '@' + r.fromUsername : 'no username'}: ${r.message}`
    );
    return ctx.reply(lines.join('\n\n'));
}

async function listAuditEvents(ctx: Context) {
    const { rows } = await pool.query(
        `SELECT "createdAt", "actorType", action, "entityType", metadata
         FROM "AuditEvent" ORDER BY "createdAt" DESC LIMIT 20`,
    );
    if (rows.length === 0) return ctx.reply('No audit events yet.');
    const lines = rows.map((row) =>
        `${new Date(row.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${row.actorType} · ${row.action}` +
        (row.entityType ? ` · ${row.entityType}` : '') +
        (row.metadata && Object.keys(row.metadata).length ? `\n  ${JSON.stringify(row.metadata)}` : ''),
    );
    return ctx.reply(`Latest audit events (newest first):\n\n${lines.join('\n\n')}`);
}

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

export function registerLeaveHandlers(bot: Bot) {
    registerPersonalDepartureCallbacks(bot, (telegramId) => pending.delete(telegramId));
    bot.command('leave', startLeave);
    bot.command('feedback', startFeedback);
    bot.command('leaverequests', adminOnly(listLeaveRequests));
    bot.command('feedbacks', adminOnly(listFeedback));
    bot.command('auditlogs', adminOnly(listAuditEvents));

    // Agency leave reason
    bot.callbackQuery(/^leave:reason:(.+)$/, async (ctx) => {
        const reason = ctx.match[1];
        pending.set(ctx.from.id, { kind: 'leaveNote', reason });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Reason: ${labelOf(reason)}`);
        await ctx.reply('Type a short note, or tap Skip.', {
            reply_markup: new InlineKeyboard().text('Skip', 'leave:skip'),
        });
    });

    bot.callbackQuery('leave:skip', async (ctx) => {
        const p = pending.get(ctx.from.id);
        await ctx.answerCallbackQuery();
        if (!p || p.kind !== 'leaveNote') return ctx.reply('Send /leave to start again.');
        return createLeaveRequest(ctx, p.reason, null);
    });

    // Admin approve: asks for the settled confirmation first.
    bot.callbackQuery(
        /^leave:approve:(.+)$/,
        adminCallback(async (ctx) => {
            const requestId = ctx.match![1];
            await ctx.answerCallbackQuery();
            return ctx.reply('Confirm that the account is settled (all payments received) before approving.', {
                reply_markup: new InlineKeyboard()
                    .text('Yes, settled. Approve', `leave:settled:${requestId}`)
                    .row()
                    .text('Cancel', 'leave:cancel'),
            });
        })
    );

    // Admin confirmed: approve, close offers, mark the business as left.
    bot.callbackQuery(
        /^leave:settled:(.+)$/,
        adminCallback(async (ctx) => {
            const requestId = ctx.match![1];

            const { rows } = await pool.query(
                `SELECT r.id, r.status, r."organizationId", o.name, o."telegramUsername", o."telegramUserId"
                 FROM "LeaveRequest" r JOIN "Organization" o ON o.id = r."organizationId"
                 WHERE r.id = $1`,
                [requestId]
            );
            const req = rows[0];
            if (!req || req.status !== 'PENDING') {
                await ctx.answerCallbackQuery({ text: 'This request was already handled.', show_alert: true });
                return ctx.editMessageText('This request was already handled.');
            }

            const { rows: offers } = await pool.query(
                `SELECT id FROM "TutoringOffer" WHERE "organizationId" = $1 AND status = 'OPEN'`,
                [req.organizationId]
            );
            // Update public Telegram posts before removing their database records.
            for (const offer of offers) {
                await closeOfferEverywhere(ctx.api, offer.id);
            }

            const departure = await withTransaction(async (client) => {
                const { rows: lockedRequests } = await client.query(
                    `SELECT id, status, "organizationId" FROM "LeaveRequest" WHERE id = $1 FOR UPDATE`,
                    [requestId],
                );
                const locked = lockedRequests[0];
                if (!locked || locked.status !== 'PENDING') return { handled: false, retained: false };

                const { rows: organizations } = await client.query(
                    `SELECT "auditRef" FROM "Organization" WHERE id = $1 FOR UPDATE`,
                    [req.organizationId],
                );
                const organization = organizations[0];
                if (!organization) return { handled: false, retained: false };

                await recordAuditEvent(client, {
                    actorRef: organization.auditRef,
                    actorType: 'AGENCY',
                    action: 'ACCOUNT_LEFT',
                    entityType: 'ORGANIZATION',
                    entityRef: req.organizationId,
                    metadata: { closedOpenOffers: offers.length, settlementConfirmed: true },
                });

                await client.query(
                    `UPDATE "LeaveRequest"
                     SET status = 'APPROVED', "decidedAt" = now(), "settledConfirmed" = true
                     WHERE id = $1`,
                    [requestId],
                );

                await client.query(
                    `DELETE FROM "TutoringOffer" WHERE "organizationId" = $1`,
                    [req.organizationId],
                );
                await client.query(
                    `DELETE FROM "LeaveRequest" WHERE "organizationId" = $1`,
                    [req.organizationId],
                );
                await client.query(
                    `DELETE FROM "OrganizationEvent" WHERE "organizationId" = $1`,
                    [req.organizationId],
                );
                if (req.telegramUserId) {
                    await client.query(`DELETE FROM "BusinessSignup" WHERE "telegramId" = $1`, [req.telegramUserId]);
                    await client.query(`DELETE FROM "SignupChat" WHERE "telegramId" = $1`, [req.telegramUserId]);
                }

                const { rows: references } = await client.query(
                    `SELECT
                        EXISTS (SELECT 1 FROM "Assignment" WHERE "organizationId" = $1) AS has_assignments,
                        EXISTS (SELECT 1 FROM "Subscription" WHERE "organizationId" = $1) AS has_subscriptions`,
                    [req.organizationId],
                );
                const retained = Boolean(references[0]?.has_assignments || references[0]?.has_subscriptions);

                if (retained) {
                    await client.query(
                        `UPDATE "Organization"
                         SET status = 'LEFT',
                             name = 'Former NextTutor business',
                             "telegramUsername" = 'former_' || replace("auditRef"::text, '-', ''),
                             "telegramUserId" = NULL,
                             "ownerUsername" = NULL,
                             "paymentReference" = NULL,
                             "groupChatId" = NULL,
                             "channelChatId" = NULL,
                             "postTemplate" = NULL
                         WHERE id = $1`,
                        [req.organizationId],
                    );
                } else {
                    await client.query(`DELETE FROM "Organization" WHERE id = $1`, [req.organizationId]);
                }
                return { handled: true, retained };
            });

            if (!departure.handled) {
                await ctx.answerCallbackQuery({ text: 'This request was already handled.', show_alert: true });
                return ctx.editMessageText('This request was already handled.');
            }

            if (req.telegramUserId) {
                try {
                    await ctx.api.sendMessage(
                        Number(req.telegramUserId),
                        'Your NextTutor account has been closed, as requested. Your personal account details have been removed.'
                    );
                } catch (err) {
                    console.error('Could not tell the agency it has left:', err);
                }
            }

            await ctx.answerCallbackQuery({ text: 'Approved.' });
            return ctx.editMessageText(
                `Approved. ${req.name} has left. ${offers.length} open offer(s) closed. ` +
                (departure.retained
                    ? 'An anonymized business record remains for existing placement/subscription history.'
                    : 'The business account record was deleted.')
            );
        })
    );

    bot.callbackQuery(
        /^leave:reject:(.+)$/,
        adminCallback(async (ctx) => {
            const requestId = ctx.match![1];

            const { rows } = await pool.query(
                `UPDATE "LeaveRequest" SET status = 'REJECTED', "decidedAt" = now()
                 WHERE id = $1 AND status = 'PENDING'
                     RETURNING "organizationId"`,
                [requestId]
            );
            if (rows.length === 0) {
                await ctx.answerCallbackQuery({ text: 'Already handled.' });
                return ctx.editMessageText('This request was already handled.');
            }

            const { rows: org } = await pool.query(
                `SELECT "telegramUserId" FROM "Organization" WHERE id = $1`,
                [rows[0].organizationId]
            );
            if (org[0]?.telegramUserId) {
                try {
                    await ctx.api.sendMessage(
                        Number(org[0].telegramUserId),
                        'Your leave request was not approved yet. Please contact NextTutor so we can settle your account.'
                    );
                } catch (err) {
                    console.error('Could not tell the agency its request was rejected:', err);
                }
            }

            await ctx.answerCallbackQuery({ text: 'Rejected.' });
            return ctx.editMessageText('Rejected. The offers stay open.');
        })
    );

    bot.callbackQuery('leave:cancel', async (ctx) => {
        await ctx.answerCallbackQuery({ text: 'Cancelled.' });
        await ctx.editMessageText('Cancelled. Nothing was changed.');
    });

    // Feedback categories
    bot.callbackQuery(/^fb:cat:(.+)$/, async (ctx) => {
        const category = ctx.match[1];
        pending.set(ctx.from.id, { kind: 'feedback', category });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Category: ${FEEDBACK_CATEGORIES.find(([c]) => c === category)?.[1] ?? category}`);
        await ctx.reply('Type your message. It goes straight to the NextTutor team.');
    });

    // Tutor's reason after /reset
    bot.callbackQuery(/^leftreason:(.+)$/, async (ctx) => {
        const code = ctx.match[1];

        if (code !== 'skip') {
            await pool.query(
                `INSERT INTO "Feedback" ("fromTelegramId", "fromUsername", role, category, message)
                 VALUES ($1, $2, 'TUTOR', 'LEFT_REASON', $3)`,
                [ctx.from.id, ctx.from.username ?? null, labelOf(code)]
            );
        }

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(code === 'skip' ? 'Skipped.' : 'Thank you for your feedback.');
        await ctx.reply('Tap Start to register again.', {
            reply_markup: new InlineKeyboard().text('Start', 'start:new'),
        });
    });

    // Typed replies: leave note or feedback message.
    bot.on('message:text', async (ctx, next) => {
        const p = pending.get(ctx.from.id);
        const text = ctx.message.text.trim();

        // A command cancels any waiting reply.
        if (text.startsWith('/')) {
            pending.delete(ctx.from.id);
            return next();
        }
        if (!p) return next();

        if (p.kind === 'leaveNote') {
            return createLeaveRequest(ctx, p.reason, text.slice(0, 300) || null);
        }

        if (p.kind === 'feedback') {
            const agency = await findAgencyByUsername(ctx.from.username);
            await pool.query(
                `INSERT INTO "Feedback" ("fromTelegramId", "fromUsername", role, category, message)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    ctx.from.id,
                    ctx.from.username ?? null,
                    agency ? 'AGENCY' : 'TUTOR',
                    p.category,
                    text.slice(0, 2000),
                ]
            );
            pending.delete(ctx.from.id);
            return ctx.reply('Thank you. Your feedback was sent.');
        }

        return next();
    });
}