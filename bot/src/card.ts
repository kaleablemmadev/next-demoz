// src/card.ts

import { SUBJECTS } from './subjects.js';
import { GRADES } from './curriculum.js';

const WEEKS_PER_MONTH = 4.33;

export type CardOffer = {
    title: string;
    subjects: string[];
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
    postHeader: string | null;
    postFooter: string | null;
    agencyUsername: string;
};

// Rounds a number to the nearest step, for example nearest 50 or nearest 5.
function roundTo(value: number, step: number): number {
    return Math.round(value / step) * step;
}

// "All Subjects" when every option is included, the list otherwise.
function listLabel(items: string[], all: readonly string[], allLabel: string): string {
    if (items.length === 0 || all.every((x) => items.includes(x))) return allLabel;
    return items.join(', ');
}

export function payLine(o: CardOffer): string {
    if (o.salaryUnit === 'HOUR') {
        return `${o.salaryAmountEtb.toLocaleString()} ETB per hour (about ${o.monthlySalaryEtb.toLocaleString()} ETB per month)`;
    }
    const hoursPerMonth = (o.sessionHours ?? 0) * o.sessionsPerWeek * WEEKS_PER_MONTH;
    const perHour = hoursPerMonth > 0 ? roundTo(o.salaryAmountEtb / hoursPerMonth, 5) : 0;
    return `${o.salaryAmountEtb.toLocaleString()} ETB per month (about ${perHour.toLocaleString()} ETB per hour)`;
}

// The offer card, one detail per line. The same layout is used for alerts and group posts.
export function offerCardText(o: CardOffer, defaultHeader = 'New tutoring offer'): string {
    const genderLabel = o.preferredTutorGender === 'MALE' ? 'Male' : o.preferredTutorGender === 'FEMALE' ? 'Female' : 'Any';
    const lines: string[] = [o.postHeader ?? defaultHeader, ''];

    lines.push(
        `Subjects: ${listLabel(o.subjects, SUBJECTS, 'All Subjects')}`,
        `Grades: ${listLabel(o.gradeLevels, GRADES, 'All Grades')}`,
        `Area: ${o.subCity}`
    );
    if (o.locationDetail) lines.push(`Location: ${o.locationDetail}`);
    lines.push(`Sessions: ${o.sessionsPerWeek} per week`);
    if (o.sessionHours) lines.push(`Session length: ${o.sessionHours} hours`);
    lines.push(`Pay: ${payLine(o)}`, `Tutor gender: ${genderLabel}`);
    if (o.requirements) lines.push(`Requirements: ${o.requirements}`);
    lines.push(`Contact: @${o.agencyUsername}`);
    if (o.postFooter) lines.push('', o.postFooter);

    return lines.join('\n');
}

// One line with subjects, grades and area, for the digest.
export function summaryLine(o: CardOffer): string {
    return `${listLabel(o.subjects, SUBJECTS, 'All Subjects')} · ${listLabel(o.gradeLevels, GRADES, 'All Grades')} · ${o.subCity}`;
}