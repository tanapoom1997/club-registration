import { inflateSync } from 'node:zlib';

// Just enough of a PDF reader to check what the name-list PDFs say, without a PDF library: it
// understands the files pdfkit writes (objects in order, Flate streams, Type0 fonts with a
// ToUnicode CMap, text as hex glyph IDs in TJ arrays) and nothing else.

type PdfObject = { id: number; dict: string; stream: Buffer | null };

const readObjects = (bytes: Buffer): Map<number, PdfObject> => {
  const text = bytes.toString('latin1');
  const objects = new Map<number, PdfObject>();
  for (const match of text.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const [, id = '', body = ''] = match;
    const streamAt = body.indexOf('stream');
    if (streamAt < 0) {
      objects.set(Number(id), { id: Number(id), dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt);
    const length = Number(/\/Length (\d+)/.exec(dict)?.[1]);
    const start = (match.index ?? 0) + match[0].indexOf(body) + streamAt + 'stream\n'.length;
    const raw = bytes.subarray(start, start + length);
    objects.set(Number(id), {
      id: Number(id),
      dict,
      stream: dict.includes('/FlateDecode') ? inflateSync(raw) : raw,
    });
  }
  return objects;
};

const utf16 = (hex: string): string =>
  String.fromCharCode(
    ...(hex.replace(/\s+/g, '').match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16)),
  );

// pdfkit writes each ToUnicode CMap as ranges of glyph IDs with one entry per glyph.
const readCMap = (cmap: string): Map<number, string> => {
  const glyphs = new Map<number, string>();
  for (const [, start = '', entries = ''] of cmap.matchAll(
    /<([0-9a-f]+)> <[0-9a-f]+> \[([^\]]*)\]/g,
  )) {
    [...entries.matchAll(/<([0-9a-f ]*)>/g)].forEach(([, hex = ''], offset) => {
      glyphs.set(parseInt(start, 16) + offset, utf16(hex));
    });
  }
  return glyphs;
};

export type PdfPage = {
  // One entry per text drawing operation, in drawing order (a heading line, a table cell, ...):
  // the ActualText of its span, which is what a viewer copies or searches.
  lines: string[];
  // The same operations read from the glyphs drawn, through the fonts' ToUnicode maps. These are
  // only reliable for text without sara am (see name-list-pdf.ts), such as IDs and numbers.
  glyphLines: string[];
};

const LITERAL_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
});

// A PDF literal string as pdfkit writes it: escaped bytes, UTF-16BE with a BOM when not ASCII.
const literalText = (literal: string): string => {
  const bytes = Buffer.from(
    literal.replace(/\\([\s\S])/g, (_, char: string) => LITERAL_ESCAPES[char] ?? char),
    'latin1',
  );
  return bytes[0] === 0xfe && bytes[1] === 0xff
    ? Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')
    : bytes.toString('latin1');
};

export const readPdf = (bytes: Buffer): PdfPage[] => {
  const objects = readObjects(bytes);
  const objectOf = (ref: string | undefined) => objects.get(Number(ref));

  const fontMaps = new Map<string, Map<number, string>>();
  [...objects.values()].forEach(({ dict }) => {
    const fonts = /\/Font <<([^>]*)>>/.exec(dict)?.[1];
    for (const [, name = '', ref] of fonts?.matchAll(/\/(\w+) (\d+) 0 R/g) ?? []) {
      const toUnicode = /\/ToUnicode (\d+) 0 R/.exec(objectOf(ref)?.dict ?? '')?.[1];
      const cmap = objectOf(toUnicode)?.stream;
      if (cmap) fontMaps.set(name, readCMap(cmap.toString('latin1')));
    }
  });

  // pdfkit draws each text call as one BT … ET block: a font, then one or more TJ arrays (a new
  // one wherever a mark is shifted, as Thai tone marks often are).
  const glyphText = (block: string): string => {
    const font =
      fontMaps.get(/\/(\w+) [\d.]+ Tf/.exec(block)?.[1] ?? '') ?? new Map<number, string>();
    return [...block.matchAll(/\[([^\]]*)\] TJ/g)]
      .flatMap(([, array = '']) => [...array.matchAll(/<([0-9a-f]*)>/g)])
      .flatMap(([, hex = '']) => hex.match(/.{4}/g) ?? [])
      .map((gid) => font.get(parseInt(gid, 16)) ?? '\uFFFD')
      .join('');
  };

  const pagesDict = [...objects.values()].find(({ dict }) => /\/Type \/Pages\b/.test(dict));
  const kids = [
    ...(/\/Kids \[([^\]]*)\]/.exec(pagesDict?.dict ?? '')?.[1] ?? '').matchAll(/(\d+) 0 R/g),
  ];
  return kids.map(([, ref]) => {
    const contents = /\/Contents (\d+) 0 R/.exec(objectOf(ref)?.dict ?? '')?.[1];
    const content = objectOf(contents)?.stream?.toString('latin1') ?? '';
    const spans = [
      ...content.matchAll(
        /\/Span <<\s*\/ActualText \(((?:\\[\s\S]|[^\\)])*)\)\s*>> BDC([\s\S]*?)\bEMC\b/g,
      ),
    ];
    return {
      lines: spans.map(([, literal = '']) => literalText(literal)),
      glyphLines: [...content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)].map(([, block = '']) =>
        glyphText(block),
      ),
    };
  });
};
