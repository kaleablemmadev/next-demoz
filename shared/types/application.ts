// A tutor's application to an offer. Agencies move it forward in the real app.
export type ApplicationStatus = 'APPLIED' | 'SHORTLISTED' | 'PLACED' | 'NOT_SELECTED';

export type Application = {
    id: string;
    offerId: string;
    tutorId: string;
    status: ApplicationStatus;
    appliedAt: string; // ISO date
};