import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { GRADES, SUBJECTS } from '../src/curriculum.js';
import { registerGenderHandlers } from '../src/gender.js';
import { registerGradeHandlers } from '../src/grades.js';
import { registerOnboardingHandlers } from '../src/onboarding.js';
import { registerSubjectHandlers } from '../src/subjects.js';
import { callbackUpdate, fakeBot } from './helpers.js';

vi.mock('../src/db.js', () => ({
    pool: { query: vi.fn() },
}));

const TEST_USER_ID = 900000002;
let selectedSubjects: string[];
let selectedGrades: string[];

beforeEach(() => {
    selectedSubjects = [];
    selectedGrades = [];
    vi.mocked(pool.query).mockImplementation(async (query: string, values?: unknown[]) => {
        if (query.includes('SELECT subjects')) {
            return { rows: [{ subjects: [...selectedSubjects] }] } as never;
        }
        if (query.includes('SELECT grades')) {
            return { rows: [{ grades: [...selectedGrades] }] } as never;
        }
        if (query.includes('SET subjects')) selectedSubjects = [...(values?.[1] as string[])];
        if (query.includes('SET grades')) selectedGrades = [...(values?.[1] as string[])];
        return { rows: [] } as never;
    });
});

function lastCall(sent: ReturnType<typeof fakeBot>['sent'], method: string) {
    return sent.filter((call) => call.method === method).at(-1);
}

function keyboardCallbacks(call: NonNullable<ReturnType<typeof lastCall>>): string[] {
    const markup = call.payload.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    return markup.inline_keyboard.flat().map((button) => button.callback_data ?? '');
}

describe('tutor onboarding handlers', () => {
    it('saves area and prompts with the full curriculum subject list', async () => {
        const { bot, sent } = fakeBot();
        registerOnboardingHandlers(bot);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'area:Bole'));

        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('SET "subCity"'),
            ['Bole', TEST_USER_ID]
        );
        expect(lastCall(sent, 'sendMessage')?.payload.text).toContain('Which subjects do you teach?');
        const subjectButtons = keyboardCallbacks(lastCall(sent, 'sendMessage')!);
        expect(subjectButtons.filter((data) => data.startsWith('subj:'))).toEqual([
            ...SUBJECTS.map((subject) => `subj:${subject}`),
            'subj:ALL',
            'subj:CLEAR',
            'subj:DONE',
        ]);
    });

    it('supports subject All, Clear, Done, and rejects an empty Done', async () => {
        const { bot, sent } = fakeBot();
        registerSubjectHandlers(bot);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'subj:DONE'));
        expect(lastCall(sent, 'answerCallbackQuery')?.payload.text).toBe('Pick at least one subject.');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'subj:ALL'));
        expect(selectedSubjects).toEqual([...SUBJECTS]);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'subj:CLEAR'));
        expect(selectedSubjects).toEqual([]);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'subj:English'));
        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'subj:DONE'));
        expect(selectedSubjects).toEqual(['English']);
        expect(lastCall(sent, 'sendMessage')?.payload.text).toContain('Which grades do you teach?');
    });

    it('supports grade All, Clear, Done, and rejects an empty Done', async () => {
        const { bot, sent } = fakeBot();
        registerGradeHandlers(bot);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'grade:DONE'));
        expect(lastCall(sent, 'answerCallbackQuery')?.payload.text).toBe('Pick at least one grade.');

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'grade:ALL'));
        expect(selectedGrades).toEqual([...GRADES]);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'grade:CLEAR'));
        expect(selectedGrades).toEqual([]);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'grade:Grade 8'));
        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'grade:DONE'));
        expect(selectedGrades).toEqual(['Grade 8']);
        expect(lastCall(sent, 'sendMessage')?.payload.text).toContain('What is your gender?');
    });

    it('saves gender and proceeds to salary selection', async () => {
        const { bot, sent } = fakeBot();
        registerGenderHandlers(bot);

        await bot.handleUpdate(callbackUpdate(TEST_USER_ID, 'gender:FEMALE'));

        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('SET gender'),
            ['FEMALE', TEST_USER_ID]
        );
        expect(lastCall(sent, 'sendMessage')?.payload.text).toContain('what is the lowest monthly salary');
    });
});
