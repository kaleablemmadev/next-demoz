import { describe, expect, it } from 'vitest';
import { areasNear } from '../../shared/rules/nearby-areas.js';
import { tutorMatchesOffer, type OfferProfile, type TutorProfile } from '../../shared/rules/offer-match.js';

const tutor: TutorProfile = {
    subCity: 'Bole',
    subjects: ['Mathematics', 'Physics'],
    grades: ['Grade 8', 'Grade 9'],
    minSalaryEtb: 2500,
    gender: 'FEMALE',
};

const offer: OfferProfile = {
    subCity: 'Bole',
    subjects: ['Mathematics', 'Physics'],
    gradeLevels: ['Grade 8', 'Grade 9'],
    monthlyEtb: 3000,
    preferredGender: 'FEMALE',
};

describe('tutorMatchesOffer', () => {
    it('requires every requested subject and grade', () => {
        expect(tutorMatchesOffer({ ...tutor, subjects: ['Mathematics'] }, offer)).toBe(false);
        expect(tutorMatchesOffer({ ...tutor, grades: ['Grade 8'] }, offer)).toBe(false);
        expect(tutorMatchesOffer(tutor, offer)).toBe(true);
    });

    it('enforces the salary minimum', () => {
        expect(tutorMatchesOffer(tutor, { ...offer, monthlyEtb: 2499 })).toBe(false);
        expect(tutorMatchesOffer(tutor, { ...offer, monthlyEtb: 2500 })).toBe(true);
    });

    it('enforces a specified gender and allows any gender when unset', () => {
        expect(tutorMatchesOffer({ ...tutor, gender: 'MALE' }, offer)).toBe(false);
        expect(tutorMatchesOffer(tutor, { ...offer, preferredGender: null })).toBe(true);
    });

    it('allows a listed nearby area but rejects a non-neighbour', () => {
        expect(areasNear('Bole')).toContain('Yeka');
        expect(tutorMatchesOffer(tutor, { ...offer, subCity: 'Yeka' })).toBe(true);
        expect(tutorMatchesOffer(tutor, { ...offer, subCity: 'Gulele' })).toBe(false);
    });
});
