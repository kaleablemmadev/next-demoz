import { describe, expect, it, vi } from 'vitest';
import { hourlyOf, monthlyOf } from '../src/agency.js';

vi.mock('../src/db.js', () => ({
    pool: { query: vi.fn() },
}));

function draft(overrides: {
    unit: 'MONTH' | 'HOUR';
    amount: number;
    sessionsPerWeek: number;
    sessionHours: number;
}) {
    return {
        orgId: 'TEST-organization',
        orgName: 'TEST Agency',
        orgUsername: 'TEST_user',
        postHeader: null,
        postFooter: null,
        step: 'amount' as const,
        subjects: [],
        grades: [],
        ...overrides,
    };
}

describe('agency pay rounding', () => {
    it('rounds hourly pay to a monthly estimate in steps of 50', () => {
        expect(
            monthlyOf(draft({ unit: 'HOUR', amount: 150, sessionHours: 1.5, sessionsPerWeek: 3 }))
        ).toBe(2900);
    });

    it('rounds a monthly estimate to hourly pay in steps of 5', () => {
        expect(
            hourlyOf(draft({ unit: 'MONTH', amount: 2500, sessionHours: 2, sessionsPerWeek: 3 }))
        ).toBe(95);
    });
});
