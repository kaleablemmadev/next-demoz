// Search filters intentionally exclude subjects. Subject metadata is descriptive only.
export type SearchFilters = {
    grades: string[];
    areas: string[];
    gender: 'MALE' | 'FEMALE' | null;
};
export type SearchableOffer = {
    gradeLevels: string[];
    subCity: string;
    preferredTutorGender: 'MALE' | 'FEMALE' | null;
};
export function offerMatchesSearch(offer: SearchableOffer, f: SearchFilters): boolean {
    const gradeOk = f.grades.length === 0 || offer.gradeLevels.some((g) => f.grades.includes(g));
    const areaOk = f.areas.length === 0 || f.areas.includes(offer.subCity);
    const genderOk = f.gender === null || offer.preferredTutorGender === null || offer.preferredTutorGender === f.gender;
    return gradeOk && areaOk && genderOk;
}
