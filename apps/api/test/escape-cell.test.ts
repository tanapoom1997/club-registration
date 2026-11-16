import { describe, expect, it } from 'vitest';
import { escapeCellText, escapeCellValue } from '../src/export/escape-cell.js';

describe('escapeCellText', () => {
  it.each([
    ['=', '=SUM(A1:A2)'],
    ['+', '+66812345678'],
    ['-', '-1+2'],
    ['@', '@SUM(A1)'],
    ['a tab', '\t=1+1'],
    ['a carriage return', '\r=1+1'],
  ])('prefixes an apostrophe to text starting with %s', (_label, text) => {
    expect(escapeCellText(text)).toBe(`'${text}`);
  });

  it.each([
    ['plain Thai text', 'นักเรียน สมมติ'],
    ['a student ID', 's1001'],
    ['a formula character later in the text', 'a=b+c-d@e'],
    ['a leading space before a formula character', ' =1+1'],
    ['an empty string', ''],
    ['an apostrophe already at the start', "'=1+1"],
  ])('leaves %s unchanged', (_label, text) => {
    expect(escapeCellText(text)).toBe(text);
  });
});

describe('escapeCellValue', () => {
  it('escapes strings and passes numbers and null through untouched', () => {
    expect([escapeCellValue('=1'), escapeCellValue(-1), escapeCellValue(null)]).toEqual([
      "'=1",
      -1,
      null,
    ]);
  });
});
