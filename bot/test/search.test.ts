import { describe, expect, it } from 'vitest';
import { offerMatchesSearch, type SearchFilters, type SearchableOffer } from '../../shared/rules/search.js';

const offer: SearchableOffer = {
    subjects: ['Mathematics', 'Physics'],
    gradeLevels: ['Grade 8', 'Grade 9'],
    subCity: 'Bole',
    preferredTutorGender: 'FEMALE',
};

const noFilters: SearchFilters = {
    subjects: [],
    grades: [],
    areas: [],
    gender: null,
};

describe('offerMatchesSearch', () => {
    it('matches any selected subject', () => {
        expect(offerMatchesSearch(offer, { ...noFilters, subjects: ['Chemistry', 'Physics'] })).toBe(true);
    });

    it('rejects a grade outside the filter', () => {
        expect(offerMatchesSearch(offer, { ...noFilters, grades: ['Grade 10'] })).toBe(false);
    });

    it('requires an exact area match', () => {
        expect(offerMatchesSearch(offer, { ...noFilters, areas: ['Yeka'] })).toBe(false);
    });

    it('applies the gender filter while allowing a matching preference', () => {
        expect(offerMatchesSearch(offer, { ...noFilters, gender: 'MALE' })).toBe(false);
        expect(offerMatchesSearch(offer, { ...noFilters, gender: 'FEMALE' })).toBe(true);
    });

    it('matches everything when filters are empty', () => {
        expect(offerMatchesSearch(offer, noFilters)).toBe(true);
    });
});
