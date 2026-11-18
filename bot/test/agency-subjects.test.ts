import { describe, expect, it } from 'vitest';
import { parseTutorSubjects } from '../src/subjects.js';

describe('agency offer subject input', () => {
    it('accepts multiple comma, semicolon, and newline-separated subjects', () => {
        expect(parseTutorSubjects('Mathematics, Physics; Chemistry\nBiology')).toEqual([
            'Mathematics', 'Physics', 'Chemistry', 'Biology',
        ]);
    });

    it('deduplicates case-insensitively while preserving the first label', () => {
        expect(parseTutorSubjects('Math, MATH, physics')).toEqual(['Math', 'physics']);
    });

    it('does not turn an empty entry into a subject', () => {
        expect(parseTutorSubjects(' , ;  ')).toEqual([]);
    });
});
