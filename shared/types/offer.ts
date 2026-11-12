// Shared types for the NextDemoz demo and, later, the real backend.
// Demo data built from these types must be labelled as fictional.

export type Gender = 'MALE' | 'FEMALE';

export type OfferStatus = 'OPEN' | 'CLOSED';

export type Agency = {
    id: string;
    name: string;
    city: string;
};

export type Offer = {
    id: string;
    agencyId: string;
    title: string;                 // e.g. "Grade 8 Maths tutor"
    subject: string;
    gradeLevel: string;            // e.g. "Grade 8"
    city: string;
    subCity: string;
    monthlySalaryEtb: number;      // amount the tutor is paid per month
    sessionsPerWeek: number;
    preferredTutorGender?: Gender; // leave out for "no preference"
    status: OfferStatus;
    postedAt: string;              // ISO date
};