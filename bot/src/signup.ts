import { Bot, InlineKeyboard, type Context } from 'grammy';
import { randomInt, randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { isAdmin, ADMIN_USERNAME } from './admin.js';

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);
const BOT_USERNAME = 'NextTutorBot';

type Signup = {
    telegramId: string;
    telegramUsername: string | null;
    step: 'DESTINATION' | 'NAME' | 'OWNER' | 'CHAT_USERNAME' | 'ADD_BOT' | 'CODE' | 'PAYMENT_REF';
    destination: 'GROUP' | 'CHANNEL' | null;
    businessName: string | null;
    ownerUsername: string | null;
    chatUsername: string | null;
    chatId: string | null;
    code: string | null;
};

const WELCOME = [
    'Welcome to NextTutor business registration.',
    '',
    'You will need:',
    '• A Telegram group or channel for your tutoring offers',
    '• The Telegram username of the business owner',
    '• Your business name',
    `• @${BOT_USERNAME} added to your group or channel as an admin, with permission to post`,
    '',
    'Payment: ____ ETB (to be confirmed)',
    '',
    'Your business can post offers after the admin approves your payment.',
].join('\n');

const SIGNUP_COLUMNS = ['step', 'destination', 'businessName', 'ownerUsername', 'chatUsername', 'chatId', 'code', 'paymentRef'];

function cleanUsername(raw: string): string | null {
    const u = raw.trim().replace(/^@/, '');
    return /^[A-Za-z0-9_]{5,32}$/.test(u) ? u : null;
}

async function getSignup(telegramId: number): Promise<Signup | null> {
    const { rows } = await pool.query<Signup>(
        `SELECT "telegramId"::text AS "telegramId", "telegramUsername", step, destination,
                "businessName", "ownerUsername", "chatUsername", "chatId"::text AS "chatId", code
         FROM "BusinessSignup" WHERE "telegramId" = $1`,
        [telegramId]
    );
    return rows[0] ?? null;
}

// Only fixed column names are accepted, so the query text is safe.
async function updateSignup(telegramId: number, fields: Record<string, string | null>) {
    const keys = Object.keys(fields).filter((k) => SIGNUP_COLUMNS.includes(k));
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
    await pool.query(
        `UPDATE "BusinessSignup" SET ${sets}, "updatedAt" = now() WHERE "telegramId" = $1`,
        [telegramId, ...keys.map((k) => fields[k])]
    );
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

function ownerTemplate(s: Signup): string {
    return [
        'Hello, I am registering a tutoring business on NextTutor.',
        '',
        `Business name: ${s.businessName}`,
        `Business account: @${s.telegramUsername}`,
        `Owner: @${s.ownerUsername}`,
        `${s.destination === 'CHANNEL' ? 'Channel' : 'Group'}: @${s.chatUsername}`,
        `Ownership code: ${s.code}`,
        '',
        'Payment: ____ ETB',
        '',
        'Please confirm once the payment is received so my account can be approved.',
    ].join('\n');
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

    await pool.query(
        `INSERT INTO "BusinessSignup" ("telegramId", "telegramUsername", step)
         VALUES ($1, $2, 'DESTINATION')
             ON CONFLICT ("telegramId") DO UPDATE SET
            "telegramUsername" = EXCLUDED."telegramUsername", step = 'DESTINATION',
                                               destination = NULL, "businessName" = NULL, "ownerUsername" = NULL,
                                               "chatUsername" = NULL, "chatId" = NULL, code = NULL, "updatedAt" = now()`,
        [ctx.from!.id, username]
    );

    await ctx.reply(WELCOME);
    return ctx.reply('Where will you post your offers?', {
        reply_markup: new InlineKeyboard()
            .text('Telegram group', 'biz:dest:GROUP')
            .row()
            .text('Telegram channel', 'biz:dest:CHANNEL'),
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
async function finishSignup(ctx: Context, s: Signup, paymentRef: string) {
    const orgId = randomUUID();
    const chatColumn = s.destination === 'CHANNEL' ? 'channelChatId' : 'groupChatId';

    await pool.query(
        `INSERT INTO "Organization"
         (id, name, "telegramUsername", "telegramUserId", "ownerUsername", "paymentReference",
          "${chatColumn}", "postDestination", status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_APPROVAL')`,
        [orgId, s.businessName, s.telegramUsername, Number(s.telegramId), s.ownerUsername, paymentRef, s.chatId, s.destination]
    );
    await pool.query(`DELETE FROM "BusinessSignup" WHERE "telegramId" = $1`, [s.telegramId]);

    await notifyAdmin(
        ctx,
        `New business waiting for approval\n\n` +
        `Name: ${s.businessName}\n` +
        `Business account: @${s.telegramUsername}\n` +
        `Owner: @${s.ownerUsername}\n` +
        `${s.destination === 'CHANNEL' ? 'Channel' : 'Group'}: @${s.chatUsername}\n` +
        `Payment reference: ${paymentRef}`,
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
    bot.callbackQuery(/^biz:dest:(GROUP|CHANNEL)$/, async (ctx) => {
        const destination = ctx.match[1];
        await ctx.answerCallbackQuery();

        const s = await getSignup(ctx.from.id);
        if (!s || s.step !== 'DESTINATION') return ctx.reply('Send /start to register your business.');

        await updateSignup(ctx.from.id, { destination, step: 'NAME' });
        await ctx.editMessageText(`Destination: Telegram ${destination === 'CHANNEL' ? 'channel' : 'group'}`);
        return ctx.reply('What is your business name?');
    });

    // The bot was added to a group or channel. When it is an admin there, the setup code is posted.
    bot.on('my_chat_member', async (ctx) => {
        const update = ctx.myChatMember;
        if (update.new_chat_member.user.id !== ctx.me.id) return;
        if (update.new_chat_member.status !== 'administrator') return;

        const s = await getSignup(update.from.id);
        if (!s || s.step !== 'ADD_BOT') return;

        const kind = s.destination === 'CHANNEL' ? 'channel' : 'group';
        const isChannel = ctx.chat.type === 'channel';
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        if ((kind === 'channel' && !isChannel) || (kind === 'group' && !isGroup)) {
            return ctx.api.sendMessage(update.from.id, `That is not a ${kind}. Add the bot to your ${kind} as an admin.`);
        }

        if (ctx.chat.username && s.chatUsername && ctx.chat.username.toLowerCase() !== s.chatUsername.toLowerCase()) {
            return ctx.api.sendMessage(
                update.from.id,
                `That is @${ctx.chat.username}, but you gave @${s.chatUsername}. Add the bot to the right ${kind}.`
            );
        }

        const { rows } = await pool.query(
            `SELECT 1 FROM "Organization" WHERE "groupChatId" = $1 OR "channelChatId" = $1`,
            [ctx.chat.id]
        );
        if (rows.length > 0) {
            return ctx.api.sendMessage(update.from.id, 'This group or channel is already registered with NextTutor.');
        }

        const code = String(randomInt(100000, 1000000));
        await updateSignup(update.from.id, { chatId: String(ctx.chat.id), code, step: 'CODE' });

        await ctx.api.sendMessage(
            ctx.chat.id,
            `NextTutor setup code: ${code}\n\nThe owner should enter this code in a private chat with @${BOT_USERNAME}.`
        );
        return ctx.api.sendMessage(
            update.from.id,
            `The bot is an admin in your ${kind}. Type the setup code shown there, here.`
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

        const s = await getSignup(ctx.from.id);
        if (!s) return next();

        const kind = s.destination === 'CHANNEL' ? 'channel' : 'group';

        if (s.step === 'NAME') {
            if (text.length < 2 || text.length > 100) {
                return ctx.reply('Please type a business name between 2 and 100 characters.');
            }
            await updateSignup(ctx.from.id, { businessName: text, step: 'OWNER' });
            return ctx.reply("What is the owner's Telegram username? For example @owner_name.");
        }

        if (s.step === 'OWNER') {
            const owner = cleanUsername(text);
            if (!owner) return ctx.reply('That is not a valid Telegram username. For example @owner_name.');
            await updateSignup(ctx.from.id, { ownerUsername: owner, step: 'CHAT_USERNAME' });
            return ctx.reply(`What is the username of your ${kind}? For example @mytutors.`);
        }

        if (s.step === 'CHAT_USERNAME') {
            const chat = cleanUsername(text);
            if (!chat) return ctx.reply(`That is not a valid ${kind} username. For example @mytutors.`);
            await updateSignup(ctx.from.id, { chatUsername: chat, step: 'ADD_BOT' });
            return ctx.reply(
                `Now add @${BOT_USERNAME} to your ${kind} as an admin, with permission to post messages. ` +
                'I will confirm automatically when it is added.'
            );
        }

        if (s.step === 'ADD_BOT') {
            return ctx.reply(`Waiting for the bot to be added as an admin to your ${kind}.`);
        }

        if (s.step === 'CODE') {
            if (text !== s.code) {
                return ctx.reply(`That code is not right. Check the ${kind} and try again.`);
            }
            await updateSignup(ctx.from.id, { step: 'PAYMENT_REF' });
            await ctx.reply(`Ownership confirmed. Copy this message and send it to @${ADMIN_USERNAME} on Telegram:`);
            await ctx.reply(ownerTemplate(s));
            return ctx.reply('Then reply here with your payment reference or transaction number.');
        }

        if (s.step === 'PAYMENT_REF') {
            if (text.length < 3) return ctx.reply('Please type the payment reference or transaction number.');
            return finishSignup(ctx, s, text.slice(0, 200));
        }

        return next();
    });
}