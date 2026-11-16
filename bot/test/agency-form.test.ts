import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { registerAgencyHandlers } from '../src/agency.js';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas.js';
import { callbackUpdate, fakeBot, textUpdate } from './helpers.js';

vi.mock('../src/db.js', () => ({
    pool: { query: vi.fn() },
}));

const TEST_USER_ID = 900000006;

beforeEach(() => {
    vi.mocked(pool.query).mockImplementation(async (query: string) => {
        if (query.includes('FROM "Organization"')) {
            return {
                rows: [
                    {
                        id: 'TEST-organization',
                        name: 'TEST Agency',
                        telegramUsername: 'TEST_user',
                        postHeader: null,
                        postFooter: null,
                    },
                ],
            } as never;
        }
        return { rows: [] } as never;
    });
});

function lastMessage(sent: ReturnType<typeof fakeBot>['sent']) {
    return sent.filter((call) => call.method === 'sendMessage').at(-1);
}

function callbacks(call: NonNullable<ReturnType<typeof lastMessage>>): string[] {
    const markup = call.payload.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    return markup.inline_keyboard.flat().map((button) => button.callback_data ?? '');
}

describe('agency /new form', () => {
    it('follows each step, exposes Skip buttons, and builds the confirm text', async () => {
        const { bot, sent } = fakeBot();
        registerAgencyHandlers(bot);

        await bot.handleUpdate(textUpdate(TEST_USER_ID, '/new'));
        expect(lastMessage(sent)?.payload.text).toContain('Which subjects?');
        expect(callbacks(lastMessage(sent)!)).toContain('ag:skip:subjects');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'ag:skip:subjects'));
        expect(lastMessage(sent)?.payload.text).toContain('Which grades?');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'ag:grd:ALL'));
        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'ag:grd:DONE'));
        expect(lastMessage(sent)?.payload.text).toContain('Which sub-city?');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, `ag:area:${KNOWN_SUB_CITIES[0]}`));
        expect(lastMessage(sent)?.payload.text).toContain('Optional: type a location detail');
        expect(callbacks(lastMessage(sent)!)).toContain('ag:skip:location');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'ag:skip:location'));
        expect(lastMessage(sent)?.payload.text).toContain('Sessions per week?');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'ag:sess:3'));
        expect(lastMessage(sent)?.payload.text).toContain('How is the pay set?');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'ag:unit:HOUR'));
        expect(lastMessage(sent)?.payload.text).toContain('Hourly rate in ETB?');

        await bot.handleUpdate(textUpdate(TEST_USER_ID, '150'));
        expect(lastMessage(sent)?.payload.text).toContain('How many hours is one session?');

        await bot.handleUpdate(textUpdate(TEST_USER_ID, '2'));
        expect(lastMessage(sent)?.payload.text).toContain('Preferred tutor gender?');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'ag:gen:ANY'));
        expect(lastMessage(sent)?.payload.text).toContain('Optional: type any requirements');
        expect(callbacks(lastMessage(sent)!)).toContain('ag:skip:requirements');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'ag:skip:requirements'));
        expect(lastMessage(sent)?.payload.text).toContain('Please check the offer:');
        expect(lastMessage(sent)?.payload.text).toContain('Subjects: All Subjects');
        expect(lastMessage(sent)?.payload.text).toContain('Grades: All Grades');
        expect(lastMessage(sent)?.payload.text).toContain('Sessions: 3 per week');
        expect(lastMessage(sent)?.payload.text).toContain('Pay: 150 ETB per hour (about 3,900 ETB per month)');
        expect(lastMessage(sent)?.payload.text).toContain('Tutor gender: Any');
    });
});
