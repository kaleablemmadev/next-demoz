// FICTIONAL DEMO ACCOUNTS. Names, usernames and passwords are invented.
// Passwords are plain text ONLY because this is a demo. The real app must hash them.

import type { Tutor } from '../../shared/types';

export type DemoAccount = Tutor & { password: string };

export const demoAccounts: DemoAccount[] = [
    { id: 'demo-t1', fullName: 'Selam Tesfaye (fictional)', username: 'selam', password: 'demo1234', subCity: 'Bole', subjects: ['Mathematics', 'Physics'], grades: ['Grade 8', 'Grade 11'] },
    { id: 'demo-t2', fullName: 'Abel Girma (fictional)', username: 'abel', password: 'demo1234', subCity: 'Kirkos', subjects: ['Physics'], grades: ['Grade 11'] },
    { id: 'demo-t3', fullName: 'Hanna Mekonnen (fictional)', username: 'hanna', password: 'demo1234', subCity: 'Yeka', subjects: ['English', 'Mathematics'], grades: ['Grade 4', 'Grade 8'] },
    { id: 'demo-t4', fullName: 'Dawit Bekele (fictional)', username: 'dawit', password: 'demo1234', subCity: 'Arada', subjects: ['Mathematics'], grades: ['Grade 8'] },
    { id: 'demo-t5', fullName: 'Meron Assefa (fictional)', username: 'meron', password: 'demo1234', subCity: 'Kolfe Keranio', subjects: ['English'], grades: ['Grade 4'] },
    { id: 'demo-t6', fullName: 'Yonas Tadesse (fictional)', username: 'yonas', password: 'demo1234', subCity: 'Lideta', subjects: ['Physics', 'Mathematics'], grades: ['Grade 11'] },
];