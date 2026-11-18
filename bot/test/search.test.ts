import { describe, expect, it } from 'vitest';
import { offerMatchesSearch, type SearchFilters, type SearchableOffer } from '../../shared/rules/search.js';

const offer: SearchableOffer = {
    gradeLevels: ['Grade 8', 'Grade 9'],
    subCity: 'Bole',
    preferredTutorGender: 'FEMALE',
};
const noFilters: SearchFilters = { grades: [], areas: [], gender: null };

describe('offerMatchesSearch', () => {
    it('does not require subject metadata to find an offer', () => {
        expect(offerMatchesSearch(offer, noFilters)).toBe(true);
    });
    it('rejects a grade outside the filter', () => {
        expect(offerMatchesSearch(offer, { ...noFilters, grades: ['Grade 10'] })).toBe(false);
    });
    it('requires an exact area match', () => {
        expect(offerMatchesSearch(offer, { ...noFilters, areas: ['Yeka'] })).toBe(false);
    });
    it('applies the gender filter', () => {
        expect(offerMatchesSearch(offer, { ...noFilters, gender: 'MALE' })).toBe(false);
        expect(offerMatchesSearch(offer, { ...noFilters, gender: 'FEMALE' })).toBe(true);
    });
});
