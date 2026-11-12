// FICTIONAL DEMO DATA. These agencies and offers are invented for the NextDemoz
// demo and do not represent any real organization or job.

import type { Agency, Offer } from '../../shared/types';

export const mockAgencies: Agency[] = [
    { id: 'demo-agency-a', name: 'Demo Agency A (fictional)', city: 'Addis Ababa' },
    { id: 'demo-agency-b', name: 'Demo Agency B (fictional)', city: 'Addis Ababa' },
];

export const mockOffers: Offer[] = [
    {
        id: 'demo-offer-1',
        agencyId: 'demo-agency-a',
        title: 'Grade 8 Maths tutor',
        subject: 'Mathematics',
        gradeLevel: 'Grade 8',
        city: 'Addis Ababa',
        subCity: 'Bole',
        monthlySalaryEtb: 2500,
        sessionsPerWeek: 3,
        status: 'OPEN',
        postedAt: '2026-11-10',
    },
    {
        id: 'demo-offer-2',
        agencyId: 'demo-agency-a',
        title: 'Grade 11 Physics tutor',
        subject: 'Physics',
        gradeLevel: 'Grade 11',
        city: 'Addis Ababa',
        subCity: 'Kirkos',
        monthlySalaryEtb: 3000,
        sessionsPerWeek: 4,
        preferredTutorGender: 'FEMALE',
        status: 'OPEN',
        postedAt: '2026-11-11',
    },
    {
        id: 'demo-offer-3',
        agencyId: 'demo-agency-b',
        title: 'Grade 4 English tutor',
        subject: 'English',
        gradeLevel: 'Grade 4',
        city: 'Addis Ababa',
        subCity: 'Yeka',
        monthlySalaryEtb: 2000,
        sessionsPerWeek: 2,
        status: 'CLOSED',
        postedAt: '2026-11-05',
    },
    {
        id: 'demo-offer-4',
        agencyId: 'demo-agency-a',
        title: 'Grade 8 Maths tutor',
        subject: 'Mathematics',
        gradeLevel: 'Grade 8',
        city: 'Addis Ababa',
        subCity: 'Arada',
        monthlySalaryEtb: 2200,
        sessionsPerWeek: 3,
        status: 'OPEN',
        postedAt: '2026-11-12',
    },
    {
        id: 'demo-offer-5',
        agencyId: 'demo-agency-b',
        title: 'Grade 11 Physics tutor',
        subject: 'Physics',
        gradeLevel: 'Grade 11',
        city: 'Addis Ababa',
        subCity: 'Kolfe Keranio',
        monthlySalaryEtb: 2800,
        sessionsPerWeek: 4,
        status: 'OPEN',
        postedAt: '2026-11-12',
    },
];