import { readFile } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import { CLASSROOM_LIST_COLUMNS, CLUB_LIST_COLUMNS } from '@club-registration/shared';
import PDFDocument from 'pdfkit';
import type { ClassroomList, ClubList, ExportRound } from '../services/name-lists.js';
import { classroomListSection, clubListSection, formatExportTime } from './name-list-content.js';
import type { ListCell, ListSection } from './name-list-content.js';

// Name lists as PDF (README "Export รายชื่อ"): A4 portrait, one section per club or classroom
// starting on a new page, the table header repeated on every page a long list continues onto, and
// a footer with the export time (Thai time) and page number on every page. Pages are numbered
// within their section ("หน้า 1/2" of that club or classroom), not across the file, so each
// teacher's printout of a whole-round export starts at page 1.
//
// Every cell is a single line. pdfkit only breaks lines at spaces and Thai names have none inside
// a word, so text wider than its cell is cut at a grapheme boundary (a consonant never loses its
// vowel or tone mark) and ends in "…" instead of running into the next cell. Heading lines wrap at
// spaces (advisor names, club names) and the last allowed line is cut the same way.
//
// Text is drawn as plain glyphs; nothing in it is interpreted, so there is no markup to escape.

// Sarabun (SIL Open Font License 1.1, assets/fonts/OFL.txt) lays out Thai vowels and tone marks
// correctly with pdfkit's shaping. The path is relative to this module, which is two levels below
// apps/api both as src/export/*.ts (dev, tests) and as dist/export/*.js (built server).
const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
// Read once when the module loads, so a missing font stops the server at boot rather than failing
// the first export.
const [REGULAR_FONT, BOLD_FONT] = await Promise.all([
  readFile(new URL('Sarabun-Regular.ttf', FONT_DIR)),
  readFile(new URL('Sarabun-Bold.ttf', FONT_DIR)),
]);
const REGULAR = 'regular';
const BOLD = 'bold';

// Points (1/72 inch). A4 is 595.28 × 841.89.
const PAGE = Object.freeze({
  width: 595.28,
  height: 841.89,
  marginX: 40,
  marginTop: 36,
  // Rows stop here; the footer sits below.
  contentBottom: 841.89 - 44,
  footerY: 841.89 - 30,
});
const CONTENT_WIDTH = PAGE.width - 2 * PAGE.marginX;

const TITLE_SIZE = 15;
const HEADING_SIZE = 11;
const TABLE_SIZE = 11;
const FOOTER_SIZE = 9;
// Sarabun's ascent + descent is 1.3 em; a little more keeps stacked marks clear of the next line.
const lineHeight = (size: number): number => size * 1.35;
const ROW_HEIGHT = 17;
const CELL_PADDING_X = 4;
const HEADER_FILL = '#e5e7eb';
const TITLE_MAX_LINES = 2;
const HEADING_MAX_LINES = 3;
const GAP_BEFORE_TABLE = 6;
const ELLIPSIS = '…';
const CONTINUED = ' (ต่อ)';

type Align = 'left' | 'center';
type PdfColumn = { header: string; width: number; align: Align };

const columnsOf = <K extends string>(
  headers: Readonly<Record<K, string>>,
  specs: Readonly<Record<K, { width: number; align: Align }>>,
): readonly PdfColumn[] =>
  Object.freeze(
    (Object.keys(headers) as K[]).map((key) => ({ header: headers[key], ...specs[key] })),
  );

// Widths add up to the 515 pt between the margins.
const CLUB_COLUMNS = columnsOf(CLUB_LIST_COLUMNS, {
  order: { width: 40, align: 'center' },
  loginId: { width: 95, align: 'left' },
  fullName: { width: 246, align: 'left' },
  classroom: { width: 84, align: 'left' },
  seatNo: { width: 50, align: 'center' },
});

const CLASSROOM_COLUMNS = columnsOf(CLASSROOM_LIST_COLUMNS, {
  seatNo: { width: 40, align: 'center' },
  loginId: { width: 95, align: 'left' },
  fullName: { width: 185, align: 'left' },
  club: { width: 195, align: 'left' },
});

const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' });
// A cut right after one of these would leave a vowel written before a consonant that is gone.
const LEADING_VOWEL = /^[เแโใไ]$/u;

// One line of plain text: newlines, tabs and other control characters become a single space.
const plainLine = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, ' ').trim();

// The current font and size of doc decide the width.
const fitWidth = (doc: PDFKit.PDFDocument, text: string, width: number): string => {
  if (doc.widthOfString(text) <= width) return text;
  const parts = Array.from(graphemes.segment(text), ({ segment }) => segment);
  const fits = (count: number) =>
    doc.widthOfString(`${parts.slice(0, count).join('')}${ELLIPSIS}`) <= width;
  // The longest prefix that still fits with the ellipsis (binary search: widths only grow).
  let low = 0;
  let high = parts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const kept = parts.slice(0, low);
  while (kept.length > 0 && (LEADING_VOWEL.test(kept.at(-1) ?? '') || kept.at(-1) === ' ')) {
    kept.pop();
  }
  return `${kept.join('')}${ELLIPSIS}`;
};

// Greedy wrapping at spaces into at most maxLines lines, each cut to the width if it still does
// not fit (a single long word, or the rest of the text on the last allowed line).
const wrapLines = (
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  maxLines: number,
): string[] => {
  const lines = plainLine(text)
    .split(' ')
    .reduce<string[]>((wrapped, word) => {
      const last = wrapped.at(-1);
      return last !== undefined && doc.widthOfString(`${last} ${word}`) <= width
        ? [...wrapped.slice(0, -1), `${last} ${word}`]
        : [...wrapped, word];
    }, []);
  const kept =
    lines.length <= maxLines
      ? lines
      : [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')];
  return kept.map((line) => fitWidth(doc, line, width));
};

// lineBreak: false and no width keep pdfkit from wrapping or adding pages on its own: this module
// decides where every line goes.
//
// The ActualText span is what a viewer copies or searches: the text as written. Without it a
// viewer has only pdfkit's glyph-to-text map, which keeps the code points a glyph was first drawn
// for. Sarabun draws sara am (ำ) as nikhahit plus a sara aa glyph that carries no code point, so
// once a name with ำ came first, every later า in the file would copy as nothing.
const drawLine = (doc: PDFKit.PDFDocument, text: string, x: number, y: number): void => {
  if (text === '') return;
  doc.markContent('Span', { actual: text });
  doc.text(text, x, y, { lineBreak: false });
  doc.endMarkedContent();
};

const drawRow = (
  doc: PDFKit.PDFDocument,
  columns: readonly PdfColumn[],
  cells: readonly ListCell[],
  y: number,
  { header = false }: { header?: boolean } = {},
): number => {
  doc
    .font(header ? BOLD : REGULAR)
    .fontSize(TABLE_SIZE)
    .lineWidth(0.5);
  const textY = y + (ROW_HEIGHT - TABLE_SIZE * 1.3) / 2;
  columns.reduce<number>((x, { width, align }, index) => {
    if (header) doc.rect(x, y, width, ROW_HEIGHT).fillAndStroke(HEADER_FILL, 'black');
    else doc.rect(x, y, width, ROW_HEIGHT).stroke('black');
    doc.fillColor('black');
    const room = width - 2 * CELL_PADDING_X;
    const text = fitWidth(doc, plainLine(String(cells[index] ?? '')), room);
    const offset = align === 'center' ? (room - doc.widthOfString(text)) / 2 : 0;
    drawLine(doc, text, x + CELL_PADDING_X + offset, textY);
    return x + width;
  }, PAGE.marginX);
  return y + ROW_HEIGHT;
};

// The title, then the other heading lines; returns where the table starts.
const drawHeadings = (
  doc: PDFKit.PDFDocument,
  [title = '', ...rest]: readonly string[],
): number => {
  doc.font(BOLD).fontSize(TITLE_SIZE);
  const titleBottom = wrapLines(doc, title, CONTENT_WIDTH, TITLE_MAX_LINES).reduce<number>(
    (y, line) => {
      drawLine(doc, line, PAGE.marginX, y);
      return y + lineHeight(TITLE_SIZE);
    },
    PAGE.marginTop,
  );
  doc.font(REGULAR).fontSize(HEADING_SIZE);
  const headingsBottom = rest
    .flatMap((heading) => wrapLines(doc, heading, CONTENT_WIDTH, HEADING_MAX_LINES))
    .reduce<number>((y, line) => {
      drawLine(doc, line, PAGE.marginX, y);
      return y + lineHeight(HEADING_SIZE);
    }, titleBottom);
  return headingsBottom + GAP_BEFORE_TABLE;
};

// A page a long list continues onto names the list again, so a loose page still says whose it is.
const drawContinuedTitle = (doc: PDFKit.PDFDocument, title: string): number => {
  doc.font(BOLD).fontSize(HEADING_SIZE);
  const room = CONTENT_WIDTH - doc.widthOfString(CONTINUED);
  drawLine(
    doc,
    `${fitWidth(doc, plainLine(title), room)}${CONTINUED}`,
    PAGE.marginX,
    PAGE.marginTop,
  );
  return PAGE.marginTop + lineHeight(HEADING_SIZE) + GAP_BEFORE_TABLE;
};

const drawSection = (
  doc: PDFKit.PDFDocument,
  columns: readonly PdfColumn[],
  { headings, rows }: ListSection,
): void => {
  const header = columns.map(({ header: text }) => text);
  const tableTop = drawHeadings(doc, headings);
  rows.reduce(
    (y, row) => {
      if (y + ROW_HEIGHT <= PAGE.contentBottom) return drawRow(doc, columns, row, y);
      doc.addPage();
      const top = drawRow(doc, columns, header, drawContinuedTitle(doc, headings[0] ?? ''), {
        header: true,
      });
      return drawRow(doc, columns, row, top);
    },
    drawRow(doc, columns, header, tableTop, { header: true }),
  );
};

// The pages one section was drawn on: indexes first .. first + count - 1 of the buffered pages.
type SectionPages = { first: number; count: number };

const pageCount = (doc: PDFKit.PDFDocument): number => {
  const { start, count } = doc.bufferedPageRange();
  return start + count;
};

// Each section starts a page of its own and continues onto as many as it needs.
const drawSections = (
  doc: PDFKit.PDFDocument,
  columns: readonly PdfColumn[],
  sections: readonly ListSection[],
): SectionPages[] =>
  sections.map((section, index) => {
    if (index > 0) doc.addPage();
    const first = pageCount(doc) - 1;
    drawSection(doc, columns, section);
    return { first, count: pageCount(doc) - first };
  });

// Drawn once every page exists, so each footer knows how many pages its section has.
const drawFooters = (
  doc: PDFKit.PDFDocument,
  sectionPages: readonly SectionPages[],
  exportedAt: Date,
): void => {
  const exported = `ส่งออกเมื่อ ${formatExportTime(exportedAt)} น.`;
  sectionPages.forEach(({ first, count }) => {
    Array.from({ length: count }, (_, offset) => offset).forEach((offset) => {
      doc.switchToPage(first + offset);
      doc.font(REGULAR).fontSize(FOOTER_SIZE).fillColor('black');
      drawLine(doc, exported, PAGE.marginX, PAGE.footerY);
      const pageLabel = `หน้า ${offset + 1}/${count}`;
      drawLine(
        doc,
        pageLabel,
        PAGE.width - PAGE.marginX - doc.widthOfString(pageLabel),
        PAGE.footerY,
      );
    });
  });
};

const buildListPdf = async (
  columns: readonly PdfColumn[],
  sections: readonly ListSection[],
  exportedAt: Date,
): Promise<Buffer> => {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: PAGE.marginTop, bottom: 0, left: PAGE.marginX, right: PAGE.marginX },
    bufferPages: true,
    lang: 'th-TH',
    // Neither who exported the file nor anything about a student goes into its properties.
    info: { Creator: 'club-registration', Producer: 'club-registration' },
  });
  doc.registerFont(REGULAR, REGULAR_FONT);
  doc.registerFont(BOLD, BOLD_FONT);
  // Start reading before end() so no output is left waiting in the stream.
  const bytes = buffer(doc);
  drawFooters(doc, drawSections(doc, columns, sections), exportedAt);
  doc.end();
  return await bytes;
};

// One section per club, by club code.
export const buildClubListPdf = async (
  round: ExportRound,
  clubs: readonly ClubList[],
  exportedAt: Date,
): Promise<Buffer> =>
  await buildListPdf(
    CLUB_COLUMNS,
    clubs.map((club) => clubListSection(round, club, exportedAt)),
    exportedAt,
  );

// One section per classroom.
export const buildClassroomListPdf = async (
  round: ExportRound,
  classrooms: readonly ClassroomList[],
  exportedAt: Date,
): Promise<Buffer> =>
  await buildListPdf(
    CLASSROOM_COLUMNS,
    classrooms.map((classroom) => classroomListSection(round, classroom, exportedAt)),
    exportedAt,
  );
