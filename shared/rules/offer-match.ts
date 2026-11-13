// Pure pay and matching rules, shared by the bot and the app.
import { areasNear } from './nearby-areas.js';

// Average weeks in a month, used to turn an hourly rate into a monthly figure.
export const WEEKS_PER_MONTH = 4.33;

export type PayUnit = 'MONTH' | 'HOUR';

// Monthly equivalent of the rate an agency posted.
// Hourly: rate × hours per session × sessions per week × weeks per month.
export function monthlyEquivalentEtb(input: {
    salaryUnit: PayUnit;
    salaryAmountEtb: number;
    sessionHours: number | null;
    sessionsPerWeek: number;
}): number {
    if (input.salaryUnit === 'MONTH') return input.salaryAmountEtb;

    const hours = input.sessionHours ?? 1;
    return Math.round(input.salaryAmountEtb * hours * input.sessionsPerWeek * WEEKS_PER_MONTH);
}

export type TutorProfile = {
    subCity: string;
    subjects: string[];
    grades: string[];
    minSalaryEtb: number | null;
    gender: 'MALE' | 'FEMALE' | null;
};

export type OfferProfile = {
    subCity: string;
    subjects: string[];        // every subject the offer asks for
    gradeLevels: string[];     // every grade the offer asks for
    monthlyEtb: number;        // monthly equivalent, see monthlyEquivalentEtb
    preferredGender: 'MALE' | 'FEMALE' | null;
};

// A tutor matches only if they can teach every subject and grade the offer asks for,
// the offer is in their area or a neighbouring one, and it meets their salary minimum.
export function tutorMatchesOffer(tutor: TutorProfile, offer: OfferProfile): boolean {
    if (offer.subjects.length === 0 || offer.gradeLevels.length === 0) return false;

    const inArea = areasNear(tutor.subCity).includes(offer.subCity);
    const hasSubjects = offer.subjects.every((s) => tutor.subjects.includes(s));
    const hasGrades = offer.gradeLevels.every((g) => tutor.grades.includes(g));
    const meetsSalary = tutor.minSalaryEtb === null || offer.monthlyEtb >= tutor.minSalaryEtb;
    const genderOk = offer.preferredGender === null || tutor.gender === offer.preferredGender;

    return inArea && hasSubjects && hasGrades && meetsSalary && genderOk;
}