import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomInt, randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { isAdmin, ADMIN_USERNAME } from './admin.js';

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);
const BOT_USERNAME = 'NextTutorBot';

type Kind = 'GROUP' | 'CHANNEL';
type Destination = Kind | 'BOTH';
type Stage = 'DESTINATION' | 'NAME' | 'OWNER' | 'CHAT_USERNAME' | 'ADD_BOT' | 'CODE' | 'PAYMENT_REF';

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
    'Payment: ____ ETB (to be confirmed)',
    '',
    'Your business can post offers after the admin approves your payment.',
].join('\n');

const SIGNUP_COLUMNS = ['step', 'destination', 'businessName', 'ownerUsername'];

function label(kind: Kind): string {
    return kind === 'GROUP' ? 'group' : 'channel';
}

function destinationLabel(d: Destination): string {
    if (d === 'BOTH') return 'Telegram group and channel';
    return d === 'GROUP' ? 'Telegram group' : 'Telegram channel';
}

function kindsFor(d: Destination): Kind[] {
    return d === 'BOTH' ? ['GROUP', 'CHANNEL'] : [d];
}

function cleanUsername(raw: string): string | null {
    const u = raw.trim().replace(/^@/, '');
    return /^[A-Za-z0-9_]{5,32}$/.test(u) ? u : null;
}

async function getSignup(telegramId: number): Promise<Signup | null> {
    const { rows } = await pool.query<Signup>(
        `SELECT "telegramId"::text AS "telegramId", "telegramUsername", step, destination,
                "businessName", "ownerUsername"
         FROM "BusinessSignup" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0] ?? null;
}

async function getChats(telegramId: number): Promise<ChatRow[]> {
    const { rows } = await pool.query<ChatRow>(
        `SELECT kind, username, "chatId"::text AS "chatId", code, verified
         FROM "SignupChat" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

// Only fixed column names are accepted, so the query text is safe.
async function updateSignup(telegramId: number, fields: Record<string, string | null>) {
    const keys = Object.keys(fields).filter((k) => SIGNUP_COLUMNS.includes(k) || k === 'step');
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
    await pool.query(
        `UPDATE "BusinessSignup" SET ${sets}, "updatedAt" = now() WHERE "telegramId" = $1`,
        [telegramId, ...keys.map((k) => fields[k])]
    );
}

// Works out which step comes next from the saved chats.
function stageOf(chats: ChatRow[]): Stage {
    if (chats.some((c) => !c.username)) return 'CHAT_USERNAME';
    if (chats.some((c) => !c.chatId)) return 'ADD_BOT';
    if (chats.some((c) => !c.verified)) return 'CODE';
    return 'PAYMENT_REF';
}

async function advance(telegramId: number): Promise<{ stage: Stage; chats: ChatRow[] }> {
    const chats = await getChats(telegramId);
    const stage = stageOf(chats);
    await updateSignup(telegramId, { step: stage });
    return { stage, chats };
}

function promptFor(stage: Stage, chats: ChatRow[]): string {
    if (stage === 'CHAT_USERNAME') {
        const next = chats.find((c) => !c.username)!;
        return `What is the username of your ${label(next.kind)}? For example @mytutors.`;
    }
    if (stage === 'ADD_BOT') {
        const next = chats.find((c) => !c.chatId)!;
        return `Now add @${BOT_USERNAME} to your ${label(next.kind)} as an admin, with permission to post messages. I will confirm automatically when it is added.`;
    }
    if (stage === 'CODE') {
        const waiting = chats.filter((c) => !c.verified).map((c) => label(c.kind));
        return `Type the setup code shown in your ${waiting.join(' and ')}.`;
    }
    return '';
}

function ownerTemplate(s: Signup, chats: ChatRow[]): string {
    const chatLines = chats.map((c) => `${c.kind === 'GROUP' ? 'Group' : 'Channel'}: @${c.username}`);
    return [
        'Hello, I am registering a tutoring business on NextTutor.',
        '',
        `Business name: ${s.businessName}`,
        `Business account: @${s.telegramUsername}`,
        `Owner: @${s.ownerUsername}`,
        ...chatLines,
        'Ownership: confirmed through the NextTutor bot',
        '',
        'Payment: ____ ETB',
        '',
        'Please confirm once the payment is received so my account can be approved.',
    ].join('\n');
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

function approvalButtons(orgId: string) {
    return new InlineKeyboard()
        .text('Approve', `signup:approve:${orgId}`)
        .text('Reject', `signup:reject:${orgId}`);
}

// Called from roles.ts when someone who is not a registered business taps "I am a tutoring business".
export async function startBusinessSignup(ctx: Context) {
    const username = ctx.from?.username;
    if (!username) {
        return ctx.reply('Your Telegram account needs a username before you can register. Set one in Telegram settings, then send /start.');
    }

    const { rows } = await pool.query(
        `SELECT status FROM "Organization" WHERE lower("telegramUsername") = lower($1)`,
        [username]
    );
    const status = rows[0]?.status;
    if (status === 'PENDING_APPROVAL') {
        return ctx.reply('Your business is waiting for approval. We will message you when it is done.');
    }
    if (status === 'REJECTED' || status === 'LEFT') {
        return ctx.reply('This business cannot register again here. Please contact NextTutor.');
    }

    await pool.query(`DELETE FROM "SignupChat" WHERE "telegramId" = $1`, [ctx.from!.id]);
    await pool.query(
        `INSERT INTO "BusinessSignup" ("telegramId", "telegramUsername", step)
         VALUES ($1, $2, 'DESTINATION')
         ON CONFLICT ("telegramId") DO UPDATE SET
            "telegramUsername" = EXCLUDED."telegramUsername", step = 'DESTINATION',
            destination = NULL, "businessName" = NULL, "ownerUsername" = NULL, "updatedAt" = now()`,
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

// Saves the business, sends it to the admin for approval, and clears the registration.
async function finishSignup(ctx: Context, s: Signup, chats: ChatRow[], paymentRef: string) {
    const group = chats.find((c) => c.kind === 'GROUP');
    const channel = chats.find((c) => c.kind === 'CHANNEL');
    const orgId = randomUUID();

    await pool.query(
        `INSERT INTO "Organization"
         (id, name, "telegramUsername", "telegramUserId", "ownerUsername", "paymentReference",
          "groupChatId", "channelChatId", "postDestination", status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_APPROVAL')`,
        [
            orgId,
            s.businessName,
            s.telegramUsername,
            Number(s.telegramId),
            s.ownerUsername,
            paymentRef,
            group?.chatId ?? null,
            channel?.chatId ?? null,
            s.destination,
        ]
    );
    await pool.query(`DELETE FROM "SignupChat" WHERE "telegramId" = $1`, [s.telegramId]);
    await pool.query(`DELETE FROM "BusinessSignup" WHERE "telegramId" = $1`, [s.telegramId]);

    const chatLines = chats.map((c) => `${c.kind === 'GROUP' ? 'Group' : 'Channel'}: @${c.username}`);
    await notifyAdmin(
        ctx,
        `New business waiting for approval\n\n` +
        `Name: ${s.businessName}\n` +
        `Business account: @${s.telegramUsername}\n` +
        `Owner: @${s.ownerUsername}\n` +
        chatLines.join('\n') +
        `\nPayment reference: ${paymentRef}`,
        approvalButtons(orgId)
    );

    return ctx.reply('Thank you. Your registration is with the admin. You will get a message when it is approved.');
}

export function registerSignupHandlers(bot: Bot) {
    bot.command(
        'signups',
        adminOnly(async (ctx) => {
            const { rows } = await pool.query(
                `SELECT id, name, "telegramUsername", "paymentReference"
                 FROM "Organization" WHERE status = 'PENDING_APPROVAL' ORDER BY name`
            );
            if (rows.length === 0) return ctx.reply('No businesses waiting for approval.');
            for (const r of rows) {
                await ctx.reply(
                    `${r.name} (@${r.telegramUsername})\nPayment reference: ${r.paymentReference ?? 'none'}`,
                    { reply_markup: approvalButtons(r.id) }
                );
            }
        })
    );

    // Destination choice
    bot.callbackQuery(/^biz:dest:(GROUP|CHANNEL|BOTH)$/, async (ctx) => {
        const destination = ctx.match[1] as Destination;
        await ctx.answerCallbackQuery();

        const s = await getSignup(ctx.from.id);
        if (!s || s.step !== 'DESTINATION') return ctx.reply('Send /start to register your business.');

        await pool.query(`DELETE FROM "SignupChat" WHERE "telegramId" = $1`, [ctx.from.id]);
        for (const kind of kindsFor(destination)) {
            await pool.query(`INSERT INTO "SignupChat" ("telegramId", kind) VALUES ($1, $2)`, [ctx.from.id, kind]);
        }
        await updateSignup(ctx.from.id, { destination, step: 'NAME' });

        await ctx.editMessageText(`Destination: ${destinationLabel(destination)}`);
        return ctx.reply('What is your business name?');
    });

    // The bot was added to a group or channel as an admin. It binds the chat and posts the setup code.
    bot.on('my_chat_member', async (ctx) => {
        const update = ctx.myChatMember;
        if (update.new_chat_member.user.id !== ctx.me.id) return;
        if (update.new_chat_member.status !== 'administrator') return;

        const telegramId = update.from.id;
        const s = await getSignup(telegramId);
        if (!s || s.step !== 'ADD_BOT') return;

        const chats = await getChats(telegramId);
        const kind: Kind | null =
            ctx.chat.type === 'channel' ? 'CHANNEL'
                : ctx.chat.type === 'group' || ctx.chat.type === 'supergroup' ? 'GROUP'
                    : null;
        const target = chats.find((c) => c.kind === kind && !c.chatId && c.username);

        if (!target) {
            return ctx.api.sendMessage(
                telegramId,
                'This group or channel is not one of the chats you are registering. Add the bot to the one you gave me.'
            );
        }

        if (ctx.chat.username && target.username && ctx.chat.username.toLowerCase() !== target.username.toLowerCase()) {
            return ctx.api.sendMessage(
                telegramId,
                `That is @${ctx.chat.username}, but you gave @${target.username}. Add the bot to the right ${label(target.kind)}.`
            );
        }

        const { rows } = await pool.query(
            `SELECT 1 FROM "Organization" WHERE "groupChatId" = $1 OR "channelChatId" = $1`,
            [ctx.chat.id]
        );
        if (rows.length > 0) {
            return ctx.api.sendMessage(telegramId, 'This group or channel is already registered with NextTutor.');
        }

        const code = String(randomInt(100000, 1000000));
        await pool.query(
            `UPDATE "SignupChat" SET "chatId" = $3, code = $4 WHERE "telegramId" = $1 AND kind = $2`,
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

    // Approve and reject (admin only)
    bot.callbackQuery(
        /^signup:approve:(.+)$/,
        adminCallback(async (ctx) => {
            const orgId = (ctx.match as RegExpMatchArray)[1];
            const { rows } = await pool.query(
                `UPDATE "Organization" SET status = 'ACTIVE'
                 WHERE id = $1 AND status = 'PENDING_APPROVAL'
                 RETURNING name, "telegramUsername", "telegramUserId"`,
                [orgId]
            );
            if (rows.length === 0) {
                await ctx.answerCallbackQuery({ text: 'Already handled.' });
                return ctx.editMessageText('This business was already handled.');
            }

            const b = rows[0];
            if (b.telegramUserId) {
                try {
                    await ctx.api.sendMessage(
                        Number(b.telegramUserId),
                        'Your business is approved. Welcome to NextTutor!\n\n' +
                        'Your agency menu:\n' +
                        '/new - post a new tutoring offer\n' +
                        '/menu - show the agency menu\n' +
                        '/leave - request to leave NextTutor\n' +
                        '/feedback - send feedback\n' +
                        '/help - list all functions\n\n' +
                        'Send /start to show the buttons in your chat.'
                    );
                } catch (err) {
                    console.error('Could not tell the business it was approved:', err);
                }
            }

            await ctx.answerCallbackQuery({ text: 'Approved.' });
            return ctx.editMessageText(`Approved: ${b.name} (@${b.telegramUsername}).`);
        })
    );

    bot.callbackQuery(
        /^signup:reject:(.+)$/,
        adminCallback(async (ctx) => {
            const orgId = (ctx.match as RegExpMatchArray)[1];
            const { rows } = await pool.query(
                `UPDATE "Organization" SET status = 'REJECTED'
                 WHERE id = $1 AND status = 'PENDING_APPROVAL'
                 RETURNING name, "telegramUsername", "telegramUserId"`,
                [orgId]
            );
            if (rows.length === 0) {
                await ctx.answerCallbackQuery({ text: 'Already handled.' });
                return ctx.editMessageText('This business was already handled.');
            }

            const b = rows[0];
            if (b.telegramUserId) {
                try {
                    await ctx.api.sendMessage(
                        Number(b.telegramUserId),
                        'Your business registration was not approved. Please contact NextTutor for more information.'
                    );
                } catch (err) {
                    console.error('Could not tell the business it was rejected:', err);
                }
            }

            await ctx.answerCallbackQuery({ text: 'Rejected.' });
            return ctx.editMessageText(`Rejected: ${b.name} (@${b.telegramUsername}).`);
        })
    );

    // Typed answers, one step at a time.
    bot.on('message:text', async (ctx, next) => {
        const text = ctx.message.text.trim();
        if (text.startsWith('/')) return next();

        const telegramId = ctx.from.id;
        const s = await getSignup(telegramId);
        if (!s) return next();

        if (s.step === 'NAME') {
            if (text.length < 2 || text.length > 100) {
                return ctx.reply('Please type a business name between 2 and 100 characters.');
            }
            await updateSignup(telegramId, { businessName: text, step: 'OWNER' });
            return ctx.reply("What is the owner's Telegram username? For example @owner_name.");
        }

        if (s.step === 'OWNER') {
            const owner = cleanUsername(text);
            if (!owner) return ctx.reply('That is not a valid Telegram username. For example @owner_name.');
            await updateSignup(telegramId, { ownerUsername: owner });
            const { stage, chats } = await advance(telegramId);
            return ctx.reply(promptFor(stage, chats));
        }

        if (s.step === 'CHAT_USERNAME') {
            const chats = await getChats(telegramId);
            const next = chats.find((c) => !c.username);
            if (!next) {
                const after = await advance(telegramId);
                return ctx.reply(promptFor(after.stage, after.chats));
            }
            const chatUsername = cleanUsername(text);
            if (!chatUsername) {
                return ctx.reply(`That is not a valid ${label(next.kind)} username. For example @mytutors.`);
            }
            await pool.query(
                `UPDATE "SignupChat" SET username = $3 WHERE "telegramId" = $1 AND kind = $2`,
                [telegramId, next.kind, chatUsername]
            );
            const { stage, chats: updated } = await advance(telegramId);
            return ctx.reply(promptFor(stage, updated));
        }

        if (s.step === 'ADD_BOT') {
            const chats = await getChats(telegramId);
            return ctx.reply(promptFor('ADD_BOT', chats));
        }

        if (s.step === 'CODE') {
            const chats = await getChats(telegramId);
            const match = chats.find((c) => !c.verified && c.code === text);
            if (!match) {
                return ctx.reply('That code is not right. Check the group or channel and try again.');
            }

            await pool.query(
                `UPDATE "SignupChat" SET verified = true WHERE "telegramId" = $1 AND kind = $2`,
                [telegramId, match.kind]
            );
            const { stage, chats: updated } = await advance(telegramId);

            if (stage === 'PAYMENT_REF') {
                await ctx.reply(`Ownership confirmed. Copy this message and send it to @${ADMIN_USERNAME} on Telegram:`);
                await ctx.reply(ownerTemplate(s, updated));
                return ctx.reply('Then reply here with your payment reference or transaction number.');
            }
            return ctx.reply(`${label(match.kind)} confirmed. ${promptFor(stage, updated)}`);
        }

        if (s.step === 'PAYMENT_REF') {
            if (text.length < 3) return ctx.reply('Please type the payment reference or transaction number.');
            const chats = await getChats(telegramId);
            return finishSignup(ctx, s, chats, text.slice(0, 200));
        }

        return next();
    });
}