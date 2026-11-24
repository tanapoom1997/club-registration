// Text as a list search compares it: case and whitespace do not matter, and NFKC makes the two
// ways of typing sara am (one code point, or nikhahit + sara aa) the same text, so a plain
// substring test is enough for Thai.
export const normalizeSearchText = (text: string): string =>
  text.normalize('NFKC').toLocaleLowerCase('th').replace(/\s+/gu, '');
