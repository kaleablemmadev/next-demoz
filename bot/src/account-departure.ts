import { Bot, InlineKeyboard, type Context } from 'grammy';
import { pool } from './db.js';
import { recordAuditEvent, withTransaction } from './audit.js';
import { clearParentDraft } from './parent.js';

export async function startPersonalDeparture(ctx: Context) {
    if (!ctx.from) return;
    const { rows } = await pool.query(
        `SELECT
            EXISTS (SELECT 1 FROM "Parent" WHERE "telegramId" = $1) AS parent,
            EXISTS (SELECT 1 FROM "TelegramSubscriber" WHERE "telegramId" = $1) AS tutor,
            EXISTS (SELECT 1 FROM "BusinessSignup" WHERE "telegramId" = $1) AS signup`,
        [ctx.from.id],
    );
    if (!rows[0]?.parent && !rows[0]?.tutor && !rows[0]?.signup) {
        return ctx.reply('I could not find a parent or tutor account linked to this Telegram account.');
    }

    return ctx.reply(
        'This will permanently remove your NextTutor account data. ' +
        'For a parent account, requests already linked to a placement may be retained in anonymized form for the placement record. ' +
        'For a tutor account, your profile, preferences, and offer-delivery history will be deleted. ' +
        'This cannot be undone. Do you want to continue?',
        {
            reply_markup: new InlineKeyboard()
                .text('Yes, delete my account', 'account:leave:confirm')
                .text('Cancel', 'account:leave:cancel'),
        },
    );
}

export function registerPersonalDepartureCallbacks(bot: Bot, onDepartureComplete?: (telegramId: number) => void) {
    bot.callbackQuery('account:leave:cancel', async (ctx) => {
        await ctx.answerCallbackQuery({ text: 'Cancelled.' });
        return ctx.editMessageText('Cancelled. Your account was not changed.');
    });

    bot.callbackQuery('account:leave:confirm', async (ctx) => {
        const telegramId = ctx.from.id;
        const result = await withTransaction(async (client) => {
            const { rows: parents } = await client.query<{
                id: string; auditRef: string;
            }>(
                `SELECT id, "auditRef" FROM "Parent" WHERE "telegramId" = $1 FOR UPDATE`,
                [telegramId],
            );
            const parent = parents[0];
            let parentRemoved = false;
            let retainedRequests = 0;

            if (parent) {
                await client.query('DELETE FROM "Feedback" WHERE "fromTelegramId" = $1 AND role <> \'AGENCY\'', [telegramId]);
                const { rows: assigned } = await client.query<{ id: string }>(
                    `SELECT DISTINCT pr.id
                     FROM "ParentRequest" pr
                     JOIN "Assignment" a ON a."requestId" = pr.id
                     WHERE pr."parentId" = $1`,
                    [parent.id],
                );
                retainedRequests = assigned.length;

                await client.query(
                    `DELETE FROM "ParentRequest" pr
                     WHERE pr."parentId" = $1
                       AND NOT EXISTS (
                           SELECT 1 FROM "Assignment" a WHERE a."requestId" = pr.id
                       )`,
                    [parent.id],
                );

                if (retainedRequests > 0) {
                    // Keep only the parent/request keys needed by the historical placement.
                    await client.query(
                        `UPDATE "ParentRequest"
                         SET "locationDetail" = NULL, "weakSubjects" = NULL, notes = NULL
                         WHERE "parentId" = $1
                           AND EXISTS (
                               SELECT 1 FROM "Assignment" a WHERE a."requestId" = "ParentRequest".id
                           )`,
                        [parent.id],
                    );
                    await client.query(
                        `UPDATE "Parent"
                         SET "telegramId" = -(floor(random() * 9000000000000000000)::bigint + 1),
                             "telegramUsername" = NULL,
                             "contactHandle" = NULL
                         WHERE id = $1`,
                        [parent.id],
                    );
                } else {
                    await client.query(`DELETE FROM "Parent" WHERE id = $1`, [parent.id]);
                    parentRemoved = true;
                }

                await recordAuditEvent(client, {
                    actorRef: parent.auditRef,
                    actorType: 'PARENT',
                    action: 'ACCOUNT_LEFT',
                    entityType: 'PARENT',
                    metadata: { retainedAssignedRequests: retainedRequests },
                });
            }

            const { rows: tutors } = await client.query<{ id: string; auditRef: string }>(
                `SELECT id, "auditRef" FROM "TelegramSubscriber" WHERE "telegramId" = $1 FOR UPDATE`,
                [telegramId],
            );
            const tutor = tutors[0];
            if (tutor) {
                await recordAuditEvent(client, {
                    actorRef: tutor.auditRef,
                    actorType: 'TUTOR',
                    action: 'ACCOUNT_LEFT',
                    entityType: 'TUTOR',
                });
                // Feedback can contain free-text and direct Telegram identifiers.
                await client.query(
                    `DELETE FROM "Feedback" WHERE "fromTelegramId" = $1 AND role = 'TUTOR'`,
                    [telegramId],
                );
                // NotificationPreference and OfferDelivery are configured to cascade.
                await client.query(`DELETE FROM "TelegramSubscriber" WHERE id = $1`, [tutor.id]);
            }

            const { rowCount: deletedSignupRows } = await client.query(
                `DELETE FROM "BusinessSignup" WHERE "telegramId" = $1`,
                [telegramId],
            );
            await client.query(`DELETE FROM "SignupChat" WHERE "telegramId" = $1`, [telegramId]);
            const signupRemoved = (deletedSignupRows ?? 0) > 0;

            if (!parent && !tutor && !signupRemoved) {
                return { found: false, parentRemoved: false, retainedRequests: 0, tutorRemoved: false, signupRemoved: false };
            }
            return {
                found: true,
                parentRemoved,
                retainedRequests,
                tutorRemoved: Boolean(tutor),
                signupRemoved,
            };;
        });

        clearParentDraft(telegramId);
        onDepartureComplete?.(telegramId);
        await ctx.answerCallbackQuery({ text: result.found ? 'Account data processed.' : 'Account not found.' });
        if (!result.found) return ctx.editMessageText('No active parent or tutor account was found. Nothing was changed.');

        const details = [
            result.parentRemoved ? 'Your parent account and unassigned requests were deleted.' : null,
            result.retainedRequests > 0
                ? `${result.retainedRequests} request(s) connected to an existing placement were retained with personal details removed.`
                : null,
            result.tutorRemoved ? 'Your tutor profile, preferences, and delivery history were deleted.' : null,
            result.signupRemoved ? 'Your unfinished business signup data was deleted.' : null,
        ].filter(Boolean);

        return ctx.editMessageText(
            `Your NextTutor account departure is complete.\n\n${details.join('\n')}\n\nThank you for using NextTutor.`,
        );
    });
}
