
// src/signup.ts

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomInt, randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { isAdmin, ADMIN_USERNAME } from './admin.js';

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);
const BOT_USERNAME = 'NextTutorBot';

// Set this to a positive amount if registration requires payment.
const PAYMENT_ETB = 0;

type Kind = 'GROUP' | 'CHANNEL';
type Destination = Kind | 'BOTH';

type Stage =
    | 'DESTINATION'
    | 'NAME'
    | 'OWNER'
    | 'CHAT_USERNAME'
    | 'ADD_BOT'
    | 'CODE'
    | 'PAYMENT_REF';

type Signup = {
    telegramId: string;
    telegramUsername: string | null;
    step: Stage;
    destination: Destination | null;
    businessName: string | null;
    ownerUsername: string | null;
};

type ChatRow = {
    kind: Kind;
    username: string | null;
    chatId: string | null;
    code: string | null;
    verified: boolean;
};

type PaymentProof = {
    kind: 'photo' | 'document';
    fileId: string;
    messageId: number;
};

const KIND_ORDER: Kind[] = ['GROUP', 'CHANNEL'];

const WELCOME = [
    'Welcome to NextTutor business registration.',
    '',
    'You will need:',
    '• A Telegram group, a channel, or both',
    '• The Telegram username of the business owner',
    '• Your business name',
    `• @${BOT_USERNAME} added to each group or channel as an admin, with permission to post`,
    '',
    ...(PAYMENT_ETB > 0
        ? [
            `Registration fee: ${PAYMENT_ETB.toLocaleString()} ETB`,
            'Your business can post offers after payment verification and admin approval.',
        ]
        : [
            'Registration is currently free.',
            'Your business can post offers after admin approval.',
        ]),
].join('\n');

const SIGNUP_COLUMNS = [
    'step',
    'destination',
    'businessName',
    'ownerUsername',
];

function label(kind: Kind): string {
    return kind === 'GROUP' ? 'group' : 'channel';
}

function destinationLabel(destination: Destination): string {
    if (destination === 'BOTH') {
        return 'Telegram group and channel';
    }

    return destination === 'GROUP'
        ? 'Telegram group'
        : 'Telegram channel';
}

function kindsFor(destination: Destination): Kind[] {
    return destination === 'BOTH'
        ? ['GROUP', 'CHANNEL']
        : [destination];
}

function cleanUsername(raw: string): string | null {
    const username = raw.trim().replace(/^@/, '');

    return /^[A-Za-z0-9_]{5,32}$/.test(username)
        ? username
        : null;
}

async function getSignup(telegramId: number): Promise<Signup | null> {
    const { rows } = await pool.query<Signup>(
        `SELECT
            "telegramId"::text AS "telegramId",
            "telegramUsername",
            step,
            destination,
            "businessName",
            "ownerUsername"
         FROM "BusinessSignup"
         WHERE "telegramId" = $1`,
        [telegramId]
    );

    return rows[0] ?? null;
}

async function getChats(telegramId: number): Promise<ChatRow[]> {
    const { rows } = await pool.query<ChatRow>(
        `SELECT
            kind,
            username,
            "chatId"::text AS "chatId",
            code,
            verified
         FROM "SignupChat"
         WHERE "telegramId" = $1`,
        [telegramId]
    );

    return rows.sort(
        (a, b) =>
            KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    );
}

// Only predefined column names are accepted here.
async function updateSignup(
    telegramId: number,
    fields: Record<string, string | null>
) {
    const keys = Object.keys(fields).filter(
        (key) => SIGNUP_COLUMNS.includes(key)
    );

    if (keys.length === 0) return;

    const sets = keys
        .map((key, index) => `"${key}" = $${index + 2}`)
        .join(', ');

    await pool.query(
        `UPDATE "BusinessSignup"
         SET ${sets}, "updatedAt" = now()
         WHERE "telegramId" = $1`,
        [telegramId, ...keys.map((key) => fields[key])]
    );
}

// Determines the next registration stage from the saved chats.
function stageOf(chats: ChatRow[]): Stage {
    if (chats.some((chat) => !chat.username)) {
        return 'CHAT_USERNAME';
    }

    if (chats.some((chat) => !chat.chatId)) {
        return 'ADD_BOT';
    }

    if (chats.some((chat) => !chat.verified)) {
        return 'CODE';
    }

    return 'PAYMENT_REF';
}

async function advance(
    telegramId: number
): Promise<{ stage: Stage; chats: ChatRow[] }> {
    const chats = await getChats(telegramId);
    const stage = stageOf(chats);

    await updateSignup(telegramId, { step: stage });

    return { stage, chats };
}

function promptFor(stage: Stage, chats: ChatRow[]): string {
    if (stage === 'CHAT_USERNAME') {
        const next = chats.find((chat) => !chat.username)!;

        return `What is the username of your ${label(next.kind)}? For example @mytutors.`;
    }

    if (stage === 'ADD_BOT') {
        const next = chats.find((chat) => !chat.chatId)!;

        return `Now add @${BOT_USERNAME} to your ${label(next.kind)} as an admin, with permission to post messages. I will confirm automatically when it is added.`;
    }

    if (stage === 'CODE') {
        const waiting = chats
            .filter((chat) => !chat.verified)
            .map((chat) => label(chat.kind));

        return `Type the setup code shown in your ${waiting.join(' and ')}.`;
    }

    return '';
}

function ownerTemplate(s: Signup, chats: ChatRow[]): string {
    const chatLines = chats.map(
        (chat) =>
            `${chat.kind === 'GROUP' ? 'Group' : 'Channel'}: @${chat.username}`
    );

    return [
        'Hello, I am registering a tutoring business on NextTutor.',
        '',
        `Business name: ${s.businessName}`,
        `Business account: @${s.telegramUsername}`,
        `Owner: @${s.ownerUsername}`,
        ...chatLines,
        'Ownership: confirmed through the NextTutor bot',
        '',
        `Registration fee: ${PAYMENT_ETB.toLocaleString()} ETB`,
        '',
        'Please confirm once the payment is received so my account can be approved.',
    ].join('\n');
}

async function notifyAdmin(
    ctx: Context,
    message: string,
    keyboard?: InlineKeyboard
) {
    if (!ADMIN_TELEGRAM_ID) {
        console.error(
            'ADMIN_TELEGRAM_ID is not set, so the admin was not notified:',
            message
        );
        return;
    }

    try {
        await ctx.api.sendMessage(
            ADMIN_TELEGRAM_ID,
            message,
            keyboard ? { reply_markup: keyboard } : undefined
        );
    } catch (err) {
        console.error('Could not message the admin:', err);
    }
}

function approvalButtons(orgId: string) {
    return new InlineKeyboard()
        .text('Approve', `signup:approve:${orgId}`)
        .text('Reject', `signup:reject:${orgId}`);
}

// Called when someone chooses "I am a tutoring business".
export async function startBusinessSignup(ctx: Context) {
    const username = ctx.from?.username;

    if (!username) {
        return ctx.reply(
            'Your Telegram account needs a username before you can register. Set one in Telegram settings, then send /start.'
        );
    }

    const { rows } = await pool.query(
        `SELECT status
         FROM "Organization"
         WHERE lower("telegramUsername") = lower($1)`,
        [username]
    );

    const status = rows[0]?.status;

    if (status === 'PENDING_APPROVAL') {
        return ctx.reply(
            'Your business is waiting for approval. We will message you when it is done.'
        );
    }

    if (status === 'REJECTED' || status === 'LEFT') {
        return ctx.reply(
            'This business cannot register again here. Please contact NextTutor.'
        );
    }

    await pool.query(
        `DELETE FROM "SignupChat"
         WHERE "telegramId" = $1`,
        [ctx.from!.id]
    );

    await pool.query(
        `INSERT INTO "BusinessSignup"
         ("telegramId", "telegramUsername", step)
         VALUES ($1, $2, 'DESTINATION')
         ON CONFLICT ("telegramId") DO UPDATE SET
            "telegramUsername" = EXCLUDED."telegramUsername",
            step = 'DESTINATION',
            destination = NULL,
            "businessName" = NULL,
            "ownerUsername" = NULL,
            "updatedAt" = now()`,
        [ctx.from!.id, username]
    );

    await ctx.reply(WELCOME);

    return ctx.reply('Where will you post your offers?', {
        reply_markup: new InlineKeyboard()
            .text('Telegram group', 'biz:dest:GROUP')
            .text('Telegram channel', 'biz:dest:CHANNEL')
            .row()
            .text('Both group and channel', 'biz:dest:BOTH'),
    });
}

function adminOnly(handler: (ctx: Context) => Promise<unknown>) {
    return async (ctx: Context) => {
        if (!isAdmin(ctx)) {
            return ctx.reply('This command is for admins only.');
        }

        return handler(ctx);
    };
}

function adminCallback(handler: (ctx: Context) => Promise<unknown>) {
    return async (ctx: Context) => {
        if (!isAdmin(ctx)) {
            return ctx.answerCallbackQuery({
                text: 'Admins only.',
                show_alert: true,
            });
        }

        return handler(ctx);
    };
}

// Saves the business, notifies the admin, and clears the registration.
async function finishSignup(
    ctx: Context,
    s: Signup,
    chats: ChatRow[],
    proof: PaymentProof | null
) {
    const group = chats.find((chat) => chat.kind === 'GROUP');
    const channel = chats.find((chat) => chat.kind === 'CHANNEL');

    const orgId = randomUUID();

    await pool.query(
        `INSERT INTO "Organization"
         (
            id,
            name,
            "telegramUsername",
            "telegramUserId",
            "ownerUsername",
            "paymentReference",
            "groupChatId",
            "channelChatId",
            "postDestination",
            status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_APPROVAL')`,
        [
            orgId,
            s.businessName,
            s.telegramUsername,
            Number(s.telegramId),
            s.ownerUsername,
            proof ? `${proof.kind}:${proof.fileId}` : null,
            group?.chatId ?? null,
            channel?.chatId ?? null,
            s.destination,
        ]
    );

    await pool.query(
        `DELETE FROM "SignupChat" WHERE "telegramId" = $1`,
        [s.telegramId]
    );

    await pool.query(
        `DELETE FROM "BusinessSignup" WHERE "telegramId" = $1`,
        [s.telegramId]
    );

    // Forward proof only when a payment was actually required.
    if (proof && ADMIN_TELEGRAM_ID) {
        try {
            await ctx.api.forwardMessage(
                ADMIN_TELEGRAM_ID,
                ctx.chat!.id,
                proof.messageId
            );
        } catch (err) {
            console.error(
                'Could not forward the payment proof to the admin:',
                err
            );
        }
    }

    const chatLines = chats.map(
        (chat) =>
            `${chat.kind === 'GROUP' ? 'Group' : 'Channel'}: @${chat.username}`
    );

    const paymentMessage = proof
        ? '\n\nThe payment proof is above.'
        : '\n\nNo payment is required for this registration.';

    await notifyAdmin(
        ctx,
        `New business waiting for approval\n\n` +
        `Name: ${s.businessName}\n` +
        `Business account: @${s.telegramUsername}\n` +
        `Owner: @${s.ownerUsername}\n` +
        chatLines.join('\n') +
        paymentMessage,
        approvalButtons(orgId)
    );

    return ctx.reply(
        'Your registration has been submitted. You will receive a message when your business is approved.'
    );
}

export function registerSignupHandlers(bot: Bot) {
    // Admin command: list businesses awaiting approval.
    bot.command(
        'signups',
        adminOnly(async (ctx) => {
            const { rows } = await pool.query(
                `SELECT id, name, "telegramUsername", "paymentReference"
                 FROM "Organization"
                 WHERE status = 'PENDING_APPROVAL'
                 ORDER BY name`
            );

            if (rows.length === 0) {
                return ctx.reply('No businesses waiting for approval.');
            }

            for (const row of rows) {
                await ctx.reply(
                    `${row.name} (@${row.telegramUsername})`,
                    { reply_markup: approvalButtons(row.id) }
                );

                const [kind, ...rest] = String(
                    row.paymentReference ?? ''
                ).split(':');

                const fileId = rest.join(':');

                if (kind === 'photo' && fileId) {
                    await ctx.replyWithPhoto(fileId);
                }

                if (kind === 'document' && fileId) {
                    await ctx.replyWithDocument(fileId);
                }
            }
        })
    );

    // Business chooses where offers will be published.
    bot.callbackQuery(
        /^biz:dest:(GROUP|CHANNEL|BOTH)$/,
        async (ctx) => {
            const destination = ctx.match[1] as Destination;

            await ctx.answerCallbackQuery();

            const s = await getSignup(ctx.from.id);

            if (!s || s.step !== 'DESTINATION') {
                return ctx.reply(
                    'Send /start to register your business.'
                );
            }

            await pool.query(
                `DELETE FROM "SignupChat" WHERE "telegramId" = $1`,
                [ctx.from.id]
            );

            for (const kind of kindsFor(destination)) {
                await pool.query(
                    `INSERT INTO "SignupChat" ("telegramId", kind)
                     VALUES ($1, $2)`,
                    [ctx.from.id, kind]
                );
            }

            await updateSignup(ctx.from.id, {
                destination,
                step: 'NAME',
            });

            await ctx.editMessageText(
                `Destination: ${destinationLabel(destination)}`
            );

            return ctx.reply('What is your business name?');
        }
    );

    // Detect when the bot is added to a group or channel as an admin.
    bot.on('my_chat_member', async (ctx) => {
        const update = ctx.myChatMember;

        if (update.new_chat_member.user.id !== ctx.me.id) {
            return;
        }

        if (update.new_chat_member.status !== 'administrator') {
            return;
        }

        const telegramId = update.from.id;
        const s = await getSignup(telegramId);

        if (!s || s.step !== 'ADD_BOT') {
            return;
        }

        const chats = await getChats(telegramId);

        const kind: Kind | null =
            ctx.chat.type === 'channel'
                ? 'CHANNEL'
                : ctx.chat.type === 'group' ||
                    ctx.chat.type === 'supergroup'
                    ? 'GROUP'
                    : null;

        const target = chats.find(
            (chat) =>
                chat.kind === kind &&
                !chat.chatId &&
                chat.username
        );

        if (!target) {
            return ctx.api.sendMessage(
                telegramId,
                'This group or channel is not one of the chats you are registering. Add the bot to the one you gave me.'
            );
        }

        if (
            ctx.chat.username &&
            target.username &&
            ctx.chat.username.toLowerCase() !==
            target.username.toLowerCase()
        ) {
            return ctx.api.sendMessage(
                telegramId,
                `That is @${ctx.chat.username}, but you gave @${target.username}. Add the bot to the right ${label(target.kind)}.`
            );
        }

        const { rows } = await pool.query(
            `SELECT 1
             FROM "Organization"
             WHERE "groupChatId" = $1 OR "channelChatId" = $1`,
            [ctx.chat.id]
        );

        if (rows.length > 0) {
            return ctx.api.sendMessage(
                telegramId,
                'This group or channel is already registered with NextTutor.'
            );
        }

        const code = String(randomInt(100000, 1000000));

        await pool.query(
            `UPDATE "SignupChat"
             SET "chatId" = $3, code = $4
             WHERE "telegramId" = $1 AND kind = $2`,
            [telegramId, target.kind, ctx.chat.id, code]
        );

        await ctx.api.sendMessage(
            ctx.chat.id,
            `NextTutor setup code: ${code}\n\nThe owner should enter this code in a private chat with @${BOT_USERNAME}.`
        );

        const { stage, chats: updated } = await advance(telegramId);

        return ctx.api.sendMessage(
            telegramId,
            `The bot is an admin in your ${label(target.kind)}. ${promptFor(stage, updated)}`
        );
    });

    // Admin approves a business.
    bot.callbackQuery(
        /^signup:approve:(.+)$/,
        adminCallback(async (ctx) => {
            const orgId = (ctx.match as RegExpMatchArray)[1];

            const { rows } = await pool.query(
                `UPDATE "Organization"
                 SET status = 'ACTIVE'
                 WHERE id = $1 AND status = 'PENDING_APPROVAL'
                 RETURNING name, "telegramUsername", "telegramUserId"`,
                [orgId]
            );

            if (rows.length === 0) {
                await ctx.answerCallbackQuery({
                    text: 'Already handled.',
                });

                return ctx.editMessageText(
                    'This business was already handled.'
                );
            }

            const business = rows[0];

            if (business.telegramUserId) {
                try {
                    await ctx.api.sendMessage(
                        Number(business.telegramUserId),
                        'Your business is approved. Welcome to NextTutor!\n\n' +
                        'Send /new to create your first offer.\n' +
                        'Send /template to customize how your offers look.'
                    );
                } catch (err) {
                    console.error(
                        'Could not tell the business it was approved:',
                        err
                    );
                }
            }

            await ctx.answerCallbackQuery({ text: 'Approved.' });

            return ctx.editMessageText(
                `Approved: ${business.name} (@${business.telegramUsername}).`
            );
        })
    );

    // Admin rejects a business.
    bot.callbackQuery(
        /^signup:reject:(.+)$/,
        adminCallback(async (ctx) => {
            const orgId = (ctx.match as RegExpMatchArray)[1];

            const { rows } = await pool.query(
                `UPDATE "Organization"
                 SET status = 'REJECTED'
                 WHERE id = $1 AND status = 'PENDING_APPROVAL'
                 RETURNING name, "telegramUsername", "telegramUserId"`,
                [orgId]
            );

            if (rows.length === 0) {
                await ctx.answerCallbackQuery({
                    text: 'Already handled.',
                });

                return ctx.editMessageText(
                    'This business was already handled.'
                );
            }

            const business = rows[0];

            if (business.telegramUserId) {
                try {
                    await ctx.api.sendMessage(
                        Number(business.telegramUserId),
                        'Your business registration was not approved. Please contact NextTutor for more information.'
                    );
                } catch (err) {
                    console.error(
                        'Could not tell the business it was rejected:',
                        err
                    );
                }
            }

            await ctx.answerCallbackQuery({ text: 'Rejected.' });

            return ctx.editMessageText(
                `Rejected: ${business.name} (@${business.telegramUsername}).`
            );
        })
    );

    // Payment proof is accepted only when payment is required.
    bot.on(
        ['message:photo', 'message:document'],
        async (ctx, next) => {
            if (PAYMENT_ETB === 0) {
                return next();
            }

            const s = await getSignup(ctx.from.id);

            if (!s || s.step !== 'PAYMENT_REF') {
                return next();
            }

            let proof: PaymentProof;

            if (ctx.message.photo) {
                const largest =
                    ctx.message.photo[ctx.message.photo.length - 1];

                proof = {
                    kind: 'photo',
                    fileId: largest.file_id,
                    messageId: ctx.message.message_id,
                };
            } else {
                const doc = ctx.message.document!;

                const isPdf = doc.mime_type === 'application/pdf';
                const isImage =
                    doc.mime_type?.startsWith('image/') ?? false;

                if (!isPdf && !isImage) {
                    return ctx.reply(
                        'Please send a screenshot (image) or a PDF file.'
                    );
                }

                proof = {
                    kind: 'document',
                    fileId: doc.file_id,
                    messageId: ctx.message.message_id,
                };
            }

            const chats = await getChats(ctx.from.id);

            return finishSignup(ctx, s, chats, proof);
        }
    );

    // Process typed registration answers.
    bot.on('message:text', async (ctx, next) => {
        const text = ctx.message.text.trim();

        if (text.startsWith('/')) {
            return next();
        }

        const telegramId = ctx.from.id;
        const s = await getSignup(telegramId);

        if (!s) {
            return next();
        }

        if (s.step === 'NAME') {
            if (text.length < 2 || text.length > 100) {
                return ctx.reply(
                    'Please type a business name between 2 and 100 characters.'
                );
            }

            await updateSignup(telegramId, {
                businessName: text,
                step: 'OWNER',
            });

            return ctx.reply(
                "What is the owner's Telegram username? For example @owner_name."
            );
        }

        if (s.step === 'OWNER') {
            const owner = cleanUsername(text);

            if (!owner) {
                return ctx.reply(
                    'That is not a valid Telegram username. For example @owner_name.'
                );
            }

            await updateSignup(telegramId, {
                ownerUsername: owner,
            });

            const { stage, chats } = await advance(telegramId);

            return ctx.reply(promptFor(stage, chats));
        }

        if (s.step === 'CHAT_USERNAME') {
            const chats = await getChats(telegramId);
            const nextChat = chats.find((chat) => !chat.username);

            if (!nextChat) {
                const after = await advance(telegramId);
                return ctx.reply(
                    promptFor(after.stage, after.chats)
                );
            }

            const chatUsername = cleanUsername(text);

            if (!chatUsername) {
                return ctx.reply(
                    `That is not a valid ${label(nextChat.kind)} username. For example @mytutors.`
                );
            }

            await pool.query(
                `UPDATE "SignupChat"
                 SET username = $3
                 WHERE "telegramId" = $1 AND kind = $2`,
                [telegramId, nextChat.kind, chatUsername]
            );

            const { stage, chats: updated } =
                await advance(telegramId);

            return ctx.reply(promptFor(stage, updated));
        }

        if (s.step === 'ADD_BOT') {
            const chats = await getChats(telegramId);

            return ctx.reply(promptFor('ADD_BOT', chats));
        }

        if (s.step === 'CODE') {
            const chats = await getChats(telegramId);

            const match = chats.find(
                (chat) => !chat.verified && chat.code === text
            );

            if (!match) {
                return ctx.reply(
                    'That code is not right. Check the group or channel and try again.'
                );
            }

            await pool.query(
                `UPDATE "SignupChat"
                 SET verified = true
                 WHERE "telegramId" = $1 AND kind = $2`,
                [telegramId, match.kind]
            );

            const { stage, chats: updated } =
                await advance(telegramId);

            if (stage === 'PAYMENT_REF') {
                // Free registration: do not ask for payment details.
                if (PAYMENT_ETB === 0) {
                    return finishSignup(ctx, s, updated, null);
                }

                await ctx.reply(
                    `Ownership confirmed. Copy this message and send it to @${ADMIN_USERNAME} on Telegram:`
                );

                await ctx.reply(ownerTemplate(s, updated));

                return ctx.reply(
                    'Then send the payment screenshot or PDF here.'
                );
            }

            return ctx.reply(
                `${label(match.kind)} confirmed. ${promptFor(stage, updated)}`
            );
        }

        if (s.step === 'PAYMENT_REF') {
            if (PAYMENT_ETB === 0) {
                return ctx.reply(
                    'Your registration is already being processed. You do not need to send payment details.'
                );
            }

            return ctx.reply(
                'Please send a screenshot or a PDF.'
            );
        }

        return next();
    });
}
