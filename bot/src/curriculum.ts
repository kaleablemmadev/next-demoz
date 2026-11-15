// Source: Curriculum Framework for Ethiopian Education (KG–Grade 12), MoE, May 2009.
// Grades 11–12 combine both streams. Update if the current syllabus changes.

export const GRADES = [
  'KG', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
  'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12',
] as const;

export const SUBJECTS = [
  'Mother Tongue', 'English', 'Amharic', 'Mathematics', 'Environmental Science',
  'Arts and Physical Education', 'Integrated Science', 'Civics and Ethical Education',
  'Visual Arts and Music', 'Physical Education', 'Social Studies', 'Biology',
  'Chemistry', 'Physics', 'Geography', 'History', 'Economics', 'General Business',
  'ICT', 'Technical Drawing',
] as const;

const G1_2 = ['Mother Tongue', 'English', 'Mathematics', 'Environmental Science', 'Arts and Physical Education'];
const G3_4 = [...G1_2, 'Amharic'];
const G5_6 = ['Mother Tongue', 'English', 'Amharic', 'Mathematics', 'Integrated Science',
  'Civics and Ethical Education', 'Visual Arts and Music', 'Physical Education', 'Social Studies'];
const G7_8 = ['Mother Tongue', 'English', 'Amharic', 'Mathematics', 'Biology', 'Chemistry', 'Physics',
  'Civics and Ethical Education', 'Visual Arts and Music', 'Physical Education', 'Social Studies'];
const G9_10 = ['English', 'Amharic', 'Mathematics', 'ICT', 'Civics and Ethical Education', 'Biology',
  'Chemistry', 'Physics', 'Geography', 'History', 'Physical Education'];
const G11_12 = ['English', 'Civics and Ethical Education', 'Physical Education', 'Mathematics', 'ICT',
  'Biology', 'Chemistry', 'Physics', 'Technical Drawing', 'Geography', 'History', 'Economics',
  'General Business', 'Mother Tongue', 'Amharic'];

export const SUBJECTS_BY_GRADE: Record<string, readonly string[]> = {
  'KG': [],
  'Grade 1': G1_2, 'Grade 2': G1_2,
  'Grade 3': G3_4, 'Grade 4': G3_4,
  'Grade 5': G5_6, 'Grade 6': G5_6,
  'Grade 7': G7_8, 'Grade 8': G7_8,
  'Grade 9': G9_10, 'Grade 10': G9_10,
  'Grade 11': G11_12, 'Grade 12': G11_12,
};

// Subjects offered at any of the chosen grades, in the canonical order above.
export function subjectsForGrades(grades: string[]): string[] {
  const offered = new Set<string>();
  for (const g of grades) for (const s of SUBJECTS_BY_GRADE[g] ?? []) offered.add(s);
  return SUBJECTS.filter((s) => offered.has(s));
}