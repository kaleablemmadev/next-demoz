import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { registerMenuHandlers } from '../src/menu.js';
import { registerRoleHandlers } from '../src/roles.js';
import { WELCOME_MESSAGE, registerWelcomeHandlers } from '../src/welcome.js';
import { callbackUpdate, fakeBot, textUpdate } from './helpers.js';

vi.mock('../src/db.js', () => ({
    pool: { query: vi.fn() },
}));

const TEST_USER_ID = 900000001;

beforeEach(() => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
});

describe('welcome handlers', () => {
    it('/start sends the welcome message before the normal role flow', async () => {
        const { bot, sent } = fakeBot();
        registerWelcomeHandlers(bot);
        registerRoleHandlers(bot, async () => undefined);

        await bot.handleUpdate(textUpdate(TEST_USER_ID, '/start'));

        const messages = sent.filter((call) => call.method === 'sendMessage');
        expect(messages[0]?.payload.text).toBe(WELCOME_MESSAGE);
        expect(messages[1]?.payload.text).toBe('Welcome to NextTutor. Who are you?');
    });

    it('the start:new callback sends the welcome message before the role picker', async () => {
        const { bot, sent } = fakeBot();
        registerMenuHandlers(bot);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'start:new'));

        const messages = sent.filter((call) => call.method === 'sendMessage');
        expect(messages[0]?.payload.text).toBe(WELCOME_MESSAGE);
        expect(messages[1]?.payload.text).toBe('Welcome to NextTutor. Who are you?');
    });
});
