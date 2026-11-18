import { describe, expect, it } from 'vitest';
import { parseTutorSubjects } from '../src/subjects.js';

describe('parseTutorSubjects', () => {
    it('splits comma, semicolon and newline-separated subjects', () => {
        expect(parseTutorSubjects('Mathematics, Physics; Chemistry\\nBiology')).toEqual([
            'Mathematics', 'Physics', 'Chemistry', 'Biology',
        ]);
    });

    it('trims whitespace and removes duplicates without changing display casing', () => {
        expect(parseTutorSubjects(' math , Mathematics, MATH, physics  ')).toEqual([
            'math', 'physics',
        ]);
    });

    it('returns an empty list for blank input', () => {
        expect(parseTutorSubjects('  , ;  ')).toEqual([]);
    });
});
