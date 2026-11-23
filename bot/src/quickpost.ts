// src/quickpost.ts
// Reads an agency's own description of an offer and returns the form fields it found.
// Every value is checked against the real lists. Anything unclear comes back as null, and the agency is asked for it.

import { askJson, aiEnabled } from './ai.js';
import { GRADES } from './curriculum.js';
import { KNOWN_SUB_CITIES, normalizeSubCity } from '../../shared/rules/nearby-areas.js';

export type QuickFields = {
    grades: string[];
    subjects: string[];
    subCity: string | null;
    locationDetail: string | null;
    sessionsPerWeek: number | null;
    unit: 'MONTH' | 'HOUR' | null;
    amount: number | null;
    sessionHours: number | null;
    gender: 'MALE' | 'FEMALE' | null;
    requirements: string | null;
};

export const quickPostAvailable = aiEnabled;

const SYSTEM = `You read a tutoring agency's description of one offer in Ethiopia and extract the form fields.
Return only JSON with these keys:
- grades: array, only values from this list: ${GRADES.join(', ')}. Empty if not stated.
- subjects: array of short subject names as written. Empty if not stated.
- subCity: one value from this list, or null: ${KNOWN_SUB_CITIES.join(', ')}.
- locationDetail: short place name or landmark, or null.
- sessionsPerWeek: whole number 1 to 7, or null.
- unit: "MONTH" if the pay is per month, "HOUR" if per hour, or null.
- amount: the pay in birr as a number, or null.
- sessionHours: hours per session as a number in quarter hours between 1 and 8 (1.5 for one and a half hours), or null.
- gender: "MALE" or "FEMALE" if the tutor's gender is required, otherwise null.
- requirements: any other short requirement, or null.
Rules: use null when the text does not say. Never guess. Never include phone numbers, usernames or links.`;

function clean(text: unknown, max: number): string | null {
    if (typeof text !== 'string') return null;
    const t = text.replace(/\s+/g, ' ').trim().slice(0, max);
    return t.length > 0 ? t : null;
}

// Keeps only values that fit the form. Returns null when the AI is off, the limit is reached, or nothing usable came back.
export async function extractQuickFields(text: string, userKey: string): Promise<QuickFields | null> {
    const raw = await askJson<Record<string, unknown>>({
        system: SYSTEM,
        prompt: `Offer description:\n${text.slice(0, 1500)}`,
        userKey,
    });
    if (!raw || typeof raw !== 'object') return null;

    const grades = Array.isArray(raw.grades)
        ? [...new Set(raw.grades.filter((g): g is string => typeof g === 'string' && (GRADES as readonly string[]).includes(g)))]
        : [];
    const subjects = Array.isArray(raw.subjects)
        ? raw.subjects.map((s) => clean(s, 60)).filter((s): s is string => Boolean(s)).slice(0, 12)
        : [];
    const subCityRaw = clean(raw.subCity, 60);
    const subCity = subCityRaw ? normalizeSubCity(subCityRaw) : null;

    const sessions = Number(raw.sessionsPerWeek);
    const sessionsPerWeek = Number.isInteger(sessions) && sessions >= 1 && sessions <= 7 ? sessions : null;

    const unit = raw.unit === 'MONTH' || raw.unit === 'HOUR' ? raw.unit : null;

    const amount = Number(raw.amount);
    const amountOk = Number.isFinite(amount) && amount > 0 && amount <= 200000 ? amount : null;

    const hours = Number(raw.sessionHours);
    const sessionHours = Number.isFinite(hours) && hours >= 1 && hours <= 8 && Math.round(hours * 4) === hours * 4 ? hours : null;

    const gender = raw.gender === 'MALE' || raw.gender === 'FEMALE' ? raw.gender : null;

    const fields: QuickFields = {
        grades,
        subjects,
        subCity,
        locationDetail: clean(raw.locationDetail, 40),
        sessionsPerWeek,
        unit: amountOk ? unit : null,
        amount: amountOk,
        sessionHours,
        gender,
        requirements: clean(raw.requirements, 200),
    };
    const anything = fields.grades.length || fields.subjects.length || fields.subCity || fields.amount;
    return anything ? fields : null;
}

// The first required field that is still empty, in the order the form asks for them.
export function firstMissing(f: QuickFields): 'grades' | 'subjects' | 'area' | 'location' | 'sessions' | 'unit' | 'amount' | 'hours' | null {
    if (f.grades.length === 0) return 'grades';
    if (f.subjects.length === 0) return 'subjects';
    if (!f.subCity) return 'area';
    if (!f.locationDetail) return 'location';
    if (!f.sessionsPerWeek) return 'sessions';
    if (!f.unit || !f.amount) return 'unit';
    if (!f.sessionHours) return 'hours';
    return null;
}
