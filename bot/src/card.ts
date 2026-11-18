
import { GRADES } from './curriculum.js';

const WEEKS_PER_MONTH = 4.33;

export const DEFAULT_OFFER_TEMPLATE = `📢 NEW TUTORING OPPORTUNITY!

📚 Subject: {SUBJECT}
🎓 Grades: {GRADES}
📍 Area: {SUB_CITY}
📌 Location: {LOCATION}

📅 Sessions: {SESSIONS_PER_WEEK} days/week
⏰ Hours per session: {HOURS_PER_SESSION}

💵 Monthly salary: {MONTHLY_SALARY}
💰 Hourly salary: {HOURLY_SALARY}
👩‍🏫 Tutor gender: {GENDER}

📝 Requirements: {REQUIREMENTS}

📩 Contact: {CONTACT}

Share this opportunity!`;

export const OFFER_PLACEHOLDERS = {
    SUBJECT: 'Offer subject',
    GRADES: 'Selected grades',
    SUB_CITY: 'Sub-city',
    LOCATION: 'Specific location',
    SESSIONS_PER_WEEK: 'Sessions per week',
    HOURS_PER_SESSION: 'Hours per session',
    MONTHLY_SALARY: 'Monthly salary in ETB',
    HOURLY_SALARY: 'Hourly salary in ETB',
    SALARY: 'Salary in the agency selected unit',
    GENDER: 'Preferred tutor gender',
    REQUIREMENTS: 'Additional requirements',
    CONTACT: 'Agency Telegram username',
    AGENCY_NAME: 'Agency name',
    TITLE: 'Offer title',
    STATUS: 'Offer status: OPEN or CLOSED',
} as const;

export type CardOffer = {
    id?: string;
    title: string;
    subject?: string | null; // legacy: subjects were removed from offers
    gradeLevels: string[];
    subCity: string;
    locationDetail: string | null;
    sessionsPerWeek: number;
    sessionHours: number | null;
    salaryUnit: 'MONTH' | 'HOUR';
    salaryAmountEtb: number;
    monthlySalaryEtb: number;
    preferredTutorGender: 'MALE' | 'FEMALE' | null;
    requirements: string | null;
    postTemplate: string | null;
    agencyUsername: string;
    agencyName?: string;
};

function roundTo(value: number, step: number): number {
    return Math.round(value / step) * step;
}

function gradeLabel(items: string[]): string {
    if (items.length === 0 || GRADES.every((x) => items.includes(x))) {
        return 'All Grades';
    }
    return items.join(', ');
}

function hourlySalary(o: CardOffer): number {
    if (o.salaryUnit === 'HOUR') return o.salaryAmountEtb;

    const hoursPerMonth =
        (o.sessionHours ?? 0) * o.sessionsPerWeek * WEEKS_PER_MONTH;

    return hoursPerMonth > 0
        ? roundTo(o.salaryAmountEtb / hoursPerMonth, 5)
        : 0;
}

function monthlySalary(o: CardOffer): number {
    if (o.salaryUnit === 'MONTH') return o.salaryAmountEtb;
    return o.monthlySalaryEtb;
}

function money(value: number): string {
    return `${value.toLocaleString()} ETB`;
}

export function payLine(o: CardOffer): string {
    if (o.salaryUnit === 'HOUR') {
        return `${money(o.salaryAmountEtb)} per hour`;
    }
    return `${money(o.salaryAmountEtb)} per month`;
}

export function validateOfferTemplate(template: string): string[] {
    const used = [...template.matchAll(/\{([^{}]+)\}/g)]
        .map((match) => match[1].trim().toUpperCase().replace(/\s+/g, '_'));

    const supported = new Set(Object.keys(OFFER_PLACEHOLDERS));

    return [...new Set(
        used.filter((name) => !supported.has(name as keyof typeof OFFER_PLACEHOLDERS))
    )];
}

export function offerCardText(
    o: CardOffer,
    status: 'OPEN' | 'CLOSED' = 'OPEN'
): string {
    const gender =
        o.preferredTutorGender === 'MALE' ? 'Male' :
            o.preferredTutorGender === 'FEMALE' ? 'Female' :
                'Any';

    const values: Record<string, string> = {
        SUBJECT: o.subject || 'Not specified',
        GRADES: gradeLabel(o.gradeLevels),
        SUB_CITY: o.subCity || 'Not specified',
        LOCATION: o.locationDetail || 'Not specified',
        SESSIONS_PER_WEEK: String(o.sessionsPerWeek),
        HOURS_PER_SESSION: String(o.sessionHours ?? 'Not specified'),
        MONTHLY_SALARY: money(monthlySalary(o)),
        HOURLY_SALARY: money(hourlySalary(o)),
        SALARY: payLine(o),
        GENDER: gender,
        REQUIREMENTS: o.requirements || 'None specified',
        CONTACT: `@${o.agencyUsername}`,
        AGENCY_NAME: o.agencyName || 'Tutoring agency',
        TITLE: o.title,
        STATUS: status,
    };

    const template = o.postTemplate || DEFAULT_OFFER_TEMPLATE;

    return template.replace(/\{([^{}]+)\}/g, (match, rawKey: string) => {
        const key = rawKey.trim().toUpperCase().replace(/\s+/g, '_');

        return Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : match;
    });
}

export function summaryLine(o: CardOffer): string {
    return `${gradeLabel(o.gradeLevels)} · ${o.subCity}`;
}
