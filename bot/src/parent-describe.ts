// src/parent-describe.ts
// Reads a parent's description of the tutor they need and returns the request fields it found.
// Only extracts the request. It never suggests tutors or agencies. Every value is checked against the real lists.

import { askJson, aiEnabled } from './ai.js';
import { GRADES } from './curriculum.js';
import { normalizeSubCity } from '../../shared/rules/nearby-areas.js';

export type ParentFields = {
    gradeLevels: string[];
    sefer: string | null;
    subCity: string | null;
    locationDetail: string | null;
    weakSubjects: string | null;
    sessionsPerWeek: number | null;
    budgetEtb: number | null;
    preferredTutorGender: 'MALE' | 'FEMALE' | null;
    notes: string | null;
};

export const describeAvailable = aiEnabled;

const SYSTEM = `A parent in Ethiopia describes the tutor their child needs. Extract the request into JSON with these keys:
- gradeLevels: array with one value per child from this list: ${GRADES.join(', ')}. If the parent has two children in grade 8 and grade 10, return ["Grade 8", "Grade 10"]. Empty array if not said.
- sefer: the sefer (neighbourhood) name the parent wrote, as written, or null.
- subCity: one Addis Ababa sub-city name in English only if the parent named one, otherwise null.
- locationDetail: a short place or landmark the parent mentioned, or null.
- weakSubjects: the subjects the child needs help with, comma separated, or null.
- sessionsPerWeek: whole number 2 to 5, or null.
- budgetEtb: the monthly budget in birr for EACH child as a number, or null. If the parent gives one amount per child, use that amount.
- preferredTutorGender: "MALE" or "FEMALE" if the parent asked for one, otherwise null.
- notes: short text for the agency. Include the session length if stated (for example "1 hour per session", "1.5 hours per session") and any language or other requirement (for example "must speak English, knows Afaan Oromo"). Otherwise null.
Rules: use null when the text does not say. Never guess. Never include phone numbers, usernames or links. Do not suggest tutors or agencies.`;

function clean(text: unknown, max: number): string | null {
    if (typeof text !== 'string') return null;
    const t = text.replace(/\s+/g, ' ').trim().slice(0, max);
    return t.length > 0 ? t : null;
}

// Keeps only values that fit the form. Returns null when the AI is off, the limit is reached, or nothing usable came back.
export async function extractParentFields(text: string, userKey: string): Promise<ParentFields | null> {
    const raw = await askJson<Record<string, unknown>>({
        system: SYSTEM,
        prompt: `Parent's description:\n${text.slice(0, 1500)}`,
        userKey,
    });
    if (!raw || typeof raw !== 'object') return null;

    const gradeLevels = Array.isArray(raw.gradeLevels)
        ? [...new Set(raw.gradeLevels.filter((g): g is string => typeof g === 'string' && (GRADES as readonly string[]).includes(g)))]
        : [];
    const sefer = clean(raw.sefer, 60);
    const subCityRaw = clean(raw.subCity, 60);
    const subCity = subCityRaw ? normalizeSubCity(subCityRaw) : null;
    const sessions = Number(raw.sessionsPerWeek);
    const budget = Number(raw.budgetEtb);

    const fields: ParentFields = {
        gradeLevels,
        sefer,
        subCity,
        locationDetail: clean(raw.locationDetail, 40),
        weakSubjects: clean(raw.weakSubjects, 200),
        sessionsPerWeek: Number.isInteger(sessions) && sessions >= 2 && sessions <= 5 ? sessions : null,
        budgetEtb: Number.isInteger(budget) && budget >= 500 && budget <= 20000 ? budget : null,
        preferredTutorGender: raw.preferredTutorGender === 'MALE' || raw.preferredTutorGender === 'FEMALE'
            ? raw.preferredTutorGender
            : null,
        notes: clean(raw.notes, 300),
    };
    const anything = fields.gradeLevels.length || fields.sefer || fields.subCity || fields.sessionsPerWeek || fields.budgetEtb;
    return anything ? fields : null;
}
