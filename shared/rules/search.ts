// Pure search rule. Empty lists and null mean "any", so a filter only narrows when it's set.
export type SearchFilters = {
    subjects: string[];
    grades: string[];
    areas: string[];
    gender: 'MALE' | 'FEMALE' | null;
};

export type SearchableOffer = {
    subjects: string[];
    gradeLevels: string[];
    subCity: string;
    preferredTutorGender: 'MALE' | 'FEMALE' | null;
};

// Matches if the offer has at least one selected subject and grade, is in a selected area,
// and fits the gender filter. An offer with no gender preference fits any gender.
export function offerMatchesSearch(offer: SearchableOffer, f: SearchFilters): boolean {
    const subjectOk = f.subjects.length === 0 || offer.subjects.some((s) => f.subjects.includes(s));
    const gradeOk = f.grades.length === 0 || offer.gradeLevels.some((g) => f.grades.includes(g));
    const areaOk = f.areas.length === 0 || f.areas.includes(offer.subCity);
    const genderOk =
        f.gender === null || offer.preferredTutorGender === null || offer.preferredTutorGender === f.gender;

    return subjectOk && gradeOk && areaOk && genderOk;
}