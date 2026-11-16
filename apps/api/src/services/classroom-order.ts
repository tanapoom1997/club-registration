// Classrooms are free text ("1", "2", …, "10", "3/1"): numeric-aware so "10" sorts after "9".
const classroomCollator = new Intl.Collator('th', { numeric: true });

export const compareClassrooms = (a: string, b: string): number => classroomCollator.compare(a, b);
