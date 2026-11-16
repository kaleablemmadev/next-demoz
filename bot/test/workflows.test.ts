import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { registerAgencyHandlers } from '../src/agency.js';
import { registerGenderHandlers } from '../src/gender.js';
import { registerGradeHandlers } from '../src/grades.js';
import { registerOnboardingHandlers, startTutorOnboarding } from '../src/onboarding.js';
import { registerSalaryHandlers } from '../src/salary.js';
import { registerSearchHandlers } from '../src/search.js';
import { registerSubjectHandlers } from '../src/subjects.js';
import { registerRoleHandlers } from '../src/roles.js';
import { WELCOME_MESSAGE, registerWelcomeHandlers } from '../src/welcome.js';
import { SUBJECTS } from '../src/curriculum.js';
import { callbackUpdate, fakeBot, textUpdate } from './helpers.js';

vi.mock('../src/db.js', () => ({
    pool: { query: vi.fn() },
}));

type Subscriber = {
    subCity: string | null;
    subjects: string[];
    grades: string[];
    gender: string | null;
    minSalaryEtb: number | null;
};

const TEST_ONBOARDING_ID = 900000101;
const TEST_SEARCH_ID = 900000102;
const TEST_AGENCY_CANCEL_ID = 900000103;
const TEST_AGENCY_POST_ID = 900000104;

let subscriber: Subscriber;
let offers: Record<string, unknown>[];

const matchingOffer = {
    id: 'TEST-offer',
    title: 'TEST Mathematics tutor',
    subjects: ['Mathematics', 'Physics'],
    gradeLevels: ['Grade 8'],
    subCity: 'Bole',
    locationDetail: null,
    sessionsPerWeek: 3,
    sessionHours: 2,
    salaryUnit: 'MONTH',
    salaryAmountEtb: 3000,
    monthlySalaryEtb: 3000,
    preferredTutorGender: 'FEMALE',
    requirements: null,
    postHeader: null,
    postFooter: null,
    agencyName: 'TEST Agency',
    agencyUsername: 'TEST_user',
};

beforeEach(() => {
    subscriber = {
        subCity: null,
        subjects: [],
        grades: [],
        gender: null,
        minSalaryEtb: null,
    };
    offers = [{ ...matchingOffer }];

    vi.mocked(pool.query).mockImplementation(async (query: string, values?: unknown[]) => {
        if (query.includes('SELECT subjects FROM "TelegramSubscriber"')) {
            return { rows: [{ subjects: [...subscriber.subjects] }] } as never;
        }
        if (query.includes('SELECT grades FROM "TelegramSubscriber"')) {
            return { rows: [{ grades: [...subscriber.grades] }] } as never;
        }
        if (query.includes('SELECT "subCity", subjects, grades FROM "TelegramSubscriber"')) {
            return {
                rows: [{ ...subscriber, subjects: [...subscriber.subjects], grades: [...subscriber.grades] }],
            } as never;
        }
        if (query.includes('SELECT id, name, "telegramUsername"')) {
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
        if (query.includes('FROM "Organization"')) return { rows: [] } as never;
        if (query.includes('FROM "TutoringOffer"')) return { rows: offers } as never;
        if (query.includes('SET "subCity"')) subscriber.subCity = String(values?.[0]);
        if (query.includes('SET subjects')) subscriber.subjects = [...(values?.[1] as string[])];
        if (query.includes('SET grades')) subscriber.grades = [...(values?.[1] as string[])];
        if (query.includes('SET gender')) subscriber.gender = String(values?.[0]);
        if (query.includes('SET "minSalaryEtb"')) {
            subscriber.minSalaryEtb = values?.[0] == null ? null : Number(values[0]);
        }
        return { rows: [] } as never;
    });
});

function messages(sent: ReturnType<typeof fakeBot>['sent']) {
    return sent.filter((call) => call.method === 'sendMessage');
}

function lastMessage(sent: ReturnType<typeof fakeBot>['sent']) {
    return messages(sent).at(-1);
}

function callbacks(call: NonNullable<ReturnType<typeof lastMessage>>): string[] {
    const markup = call.payload.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    return markup.inline_keyboard.flat().map((button) => button.callback_data ?? '');
}

async function press(bot: ReturnType<typeof fakeBot>['bot'], userId: number, data: string) {
    await bot.handleUpdate(callbackUpdate(userId, data));
}

async function type(bot: ReturnType<typeof fakeBot>['bot'], userId: number, text: string) {
    await bot.handleUpdate(textUpdate(userId, text));
}

async function reachAgencyConfirmation(
    bot: ReturnType<typeof fakeBot>['bot'],
    userId: number,
    location: 'skip' | 'TEST Landmark',
    requirements: 'skip' | 'TEST experience'
) {
    await type(bot, userId, '/new');
    await press(bot, userId, 'ag:skip:subjects');
    await press(bot, userId, 'ag:grd:Grade 8');
    await press(bot, userId, 'ag:grd:DONE');
    await press(bot, userId, 'ag:area:Bole');
    if (location === 'skip') await press(bot, userId, 'ag:skip:location');
    else await type(bot, userId, location);
    await press(bot, userId, 'ag:sess:3');
    await press(bot, userId, 'ag:unit:MONTH');
    await type(bot, userId, '2500');
    await type(bot, userId, '2');
    await press(bot, userId, 'ag:gen:FEMALE');
    if (requirements === 'skip') await press(bot, userId, 'ag:skip:requirements');
    else await type(bot, userId, requirements);
}

describe('complete bot workflows', () => {
    it('takes a tutor from /start through role, profile setup, and salary selection', async () => {
        const { bot, sent } = fakeBot();
        registerWelcomeHandlers(bot);
        registerRoleHandlers(bot, startTutorOnboarding);
        registerOnboardingHandlers(bot);
        registerSubjectHandlers(bot);
        registerGradeHandlers(bot);
        registerGenderHandlers(bot);
        registerSalaryHandlers(bot);

        await type(bot, TEST_ONBOARDING_ID, '/start');
        expect(messages(sent)[0]?.payload.text).toBe(WELCOME_MESSAGE);
        expect(messages(sent)[1]?.payload.text).toBe('Welcome to NextTutor. Who are you?');

        await press(bot, TEST_ONBOARDING_ID, 'role:tutor:direct');
        expect(lastMessage(sent)?.payload.text).toContain('Which sub-city do you teach in?');
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO "TelegramSubscriber"'),
            [TEST_ONBOARDING_ID, 'TEST User', 'TEST_user', 'direct']
        );

        await press(bot, TEST_ONBOARDING_ID, 'area:Bole');
        await press(bot, TEST_ONBOARDING_ID, 'subj:Mathematics');
        await press(bot, TEST_ONBOARDING_ID, 'subj:DONE');
        expect(lastMessage(sent)?.payload.text).toContain('Which grades do you teach?');

        await press(bot, TEST_ONBOARDING_ID, 'grade:Grade 8');
        await press(bot, TEST_ONBOARDING_ID, 'grade:DONE');
        expect(lastMessage(sent)?.payload.text).toContain('What is your gender?');

        await press(bot, TEST_ONBOARDING_ID, 'gender:FEMALE');
        expect(lastMessage(sent)?.payload.text).toContain('what is the lowest monthly salary');

        await press(bot, TEST_ONBOARDING_ID, 'salary:2500');
        expect(subscriber).toMatchObject({
            subCity: 'Bole',
            subjects: ['Mathematics'],
            grades: ['Grade 8'],
            gender: 'FEMALE',
            minSalaryEtb: 2500,
        });
        expect(lastMessage(sent)?.payload.text).toBe('See the list of first offers?');
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('SET "minSalaryEtb"'),
            [2500, TEST_ONBOARDING_ID]
        );
    });

    it('runs /search filters and displays only offers matching the chosen filters', async () => {
        const { bot, sent } = fakeBot();
        subscriber = {
            subCity: 'Bole',
            subjects: ['Mathematics'],
            grades: ['Grade 8'],
            gender: null,
            minSalaryEtb: null,
        };
        registerSearchHandlers(bot);

        await type(bot, TEST_SEARCH_ID, '/search');
        expect(lastMessage(sent)?.payload.text).toContain('Search offers.');
        expect(callbacks(lastMessage(sent)!)).toContain('sr:show');

        await press(bot, TEST_SEARCH_ID, 'sr:pick:subjects');
        expect(sent.filter((call) => call.method === 'editMessageText').at(-1)?.payload.text).toBe(
            'Choose subjects:'
        );
        await press(bot, TEST_SEARCH_ID, 'sr:toggle:subjects:Physics');
        await press(bot, TEST_SEARCH_ID, 'sr:menu');
        await press(bot, TEST_SEARCH_ID, 'sr:gender');
        await press(bot, TEST_SEARCH_ID, 'sr:show');

        expect(lastMessage(sent)?.payload.text).toContain('No open offers match these filters.');

        await press(bot, TEST_SEARCH_ID, 'sr:gender');
        await press(bot, TEST_SEARCH_ID, 'sr:show');
        expect(messages(sent).map((call) => call.payload.text)).toContain('1 offer(s) found. Here are the newest 1.');
        expect(lastMessage(sent)?.payload.text).toContain('Agency: TEST Agency');
        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM "TutoringOffer"'));
    });

    it('cancels a confirmed agency offer without inserting it', async () => {
        const { bot, sent } = fakeBot();
        registerAgencyHandlers(bot);

        await reachAgencyConfirmation(bot, TEST_AGENCY_CANCEL_ID, 'skip', 'skip');
        expect(lastMessage(sent)?.payload.text).toContain('Please check the offer:');
        expect(callbacks(lastMessage(sent)!)).toContain('ag:post:no');

        await press(bot, TEST_AGENCY_CANCEL_ID, 'ag:post:no');
        expect(lastMessage(sent)?.payload.text).toBe('Cancelled.');
        expect(pool.query).not.toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO "TutoringOffer"'),
            expect.anything()
        );
    });

    it('posts the confirmed agency offer with the collected details', async () => {
        const { bot, sent } = fakeBot();
        registerAgencyHandlers(bot);

        await reachAgencyConfirmation(bot, TEST_AGENCY_POST_ID, 'TEST Landmark', 'TEST experience');
        expect(lastMessage(sent)?.payload.text).toContain('Location: TEST Landmark');
        expect(lastMessage(sent)?.payload.text).toContain('Requirements: TEST experience');

        await press(bot, TEST_AGENCY_POST_ID, 'ag:post:yes');

        const insert = vi.mocked(pool.query).mock.calls.find(([query]) =>
            String(query).includes('INSERT INTO "TutoringOffer"')
        );
        expect(insert?.[1]).toEqual([
            'TEST-organization',
            'All Subjects tutor (Grade 8)',
            'Mother Tongue',
            'Grade 8',
            [...SUBJECTS],
            ['Grade 8'],
            'Bole',
            'TEST Landmark',
            2500,
            'MONTH',
            2500,
            2,
            3,
            'FEMALE',
            'TEST experience',
        ]);
        expect(lastMessage(sent)?.payload.text).toContain('Offer posted.');
    });
});
