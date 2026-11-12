// A tutor as the rest of the app sees them. Passwords never belong in shared types.
export type Tutor = {
    id: string;
    fullName: string;
    username: string;
    subCity: string;
    subjects: string[];
    grades: string[];
};