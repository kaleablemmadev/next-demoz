import { Bot } from 'grammy';

type TelegramUpdate = Parameters<Bot['handleUpdate']>[0];

export type SentCall = {
    method: string;
    payload: Record<string, unknown>;
};

let nextUpdateId = 1;

function testUser(telegramId: number) {
    return {
        id: telegramId,
        is_bot: false,
        first_name: 'TEST User',
        username: 'TEST_user',
    };
}

function testChat(telegramId: number) {
    return {
        id: telegramId,
        type: 'private' as const,
        first_name: 'TEST User',
        username: 'TEST_user',
    };
}

export function fakeBot() {
    const bot = new Bot('123456:TEST', {
        botInfo: {
            id: 123456,
            is_bot: true,
            first_name: 'TEST Bot',
            username: 'TEST_NextTutorBot',
            can_join_groups: true,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
            can_connect_to_business: false,
            has_main_web_app: false,
            has_topics_enabled: false,
            allows_users_to_create_topics: false,
            can_manage_bots: false,
            supports_join_request_queries: false,
        },
    });
    const sent: SentCall[] = [];

    bot.api.config.use(async (_prev, method, payload) => {
        sent.push({
            method,
            payload: payload as unknown as Record<string, unknown>,
        });
        return { ok: true, result: true } as any;
    });

    return { bot, sent };
}

export function textUpdate(telegramId: number, text: string): TelegramUpdate {
    const updateId = nextUpdateId++;
    const message = {
        message_id: updateId,
        from: testUser(telegramId),
        chat: testChat(telegramId),
        date: 1,
        text,
        ...(text.startsWith('/')
            ? {
                  entities: [
                      {
                          offset: 0,
                          length: text.split(/\s/, 1)[0].length,
                          type: 'bot_command' as const,
                      },
                  ],
              }
            : {}),
    };

    return { update_id: updateId, message } as TelegramUpdate;
}

export function callbackUpdate(telegramId: number, data: string): TelegramUpdate {
    const updateId = nextUpdateId++;

    return {
        update_id: updateId,
        callback_query: {
            id: `TEST-callback-${updateId}`,
            from: testUser(telegramId),
            chat_instance: `TEST-chat-${telegramId}`,
            message: {
                message_id: updateId,
                chat: testChat(telegramId),
                date: 1,
                text: 'TEST inline keyboard',
            },
            data,
        },
    } as TelegramUpdate;
}
