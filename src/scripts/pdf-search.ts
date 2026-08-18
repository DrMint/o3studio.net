import { Util } from "pdfjs-dist";
import type { PageViewport } from "pdfjs-dist";

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

type PdfTextContent = {
  items: unknown[];
};

export type SearchOptions = {
  matchCase: boolean;
  matchDiacritics: boolean;
  wholeWords: boolean;
};

export type TextRun = {
  str: string;
  start: number;
  transform: number[];
  width: number;
  height: number;
};

export type PageTextIndex = {
  page: number;
  text: string;
  runs: TextRun[];
};

export type SearchMatch = {
  page: number;
  start: number;
  end: number;
};

export type CssRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as PdfTextItem).str === "string" &&
    Array.isArray((item as PdfTextItem).transform)
  );
}

export function indexPageText(
  page: number,
  content: PdfTextContent
): PageTextIndex {
  const runs: TextRun[] = [];
  let text = "";
  for (const item of content.items) {
    if (!isTextItem(item) || item.str.length === 0) continue;
    runs.push({
      str: item.str,
      start: text.length,
      transform: item.transform,
      width: item.width,
      height: item.height,
    });
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return { page, text, runs };
}

function foldSearchText(
  text: string,
  options: SearchOptions
): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    let piece = text.slice(i, i + len);
    if (!options.matchDiacritics) {
      piece = piece.normalize("NFD").replace(/\p{M}/gu, "");
    }
    if (!options.matchCase) piece = piece.toLocaleLowerCase();
    for (let j = 0; j < piece.length; j++) map.push(i);
    out += piece;
    i += len;
  }
  map.push(text.length);
  return { text: out, map };
}

function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const cp = text.codePointAt(index);
  if (cp === undefined) return false;
  return /[\p{L}\p{N}_]/u.test(String.fromCodePoint(cp));
}

function isWholeWord(text: string, start: number, end: number): boolean {
  return !isWordChar(text, start - 1) && !isWordChar(text, end);
}

export function findMatchesInPage(
  page: PageTextIndex,
  query: string,
  options: SearchOptions
): SearchMatch[] {
  const foldedQuery = foldSearchText(query, options).text;
  if (!foldedQuery) return [];
  const folded = foldSearchText(page.text, options);
  const matches: SearchMatch[] = [];
  let from = 0;
  while (from <= folded.text.length - foldedQuery.length) {
    const index = folded.text.indexOf(foldedQuery, from);
    if (index === -1) break;
    const start = folded.map[index]!;
    const end = folded.map[index + foldedQuery.length]!;
    if (!options.wholeWords || isWholeWord(page.text, start, end)) {
      matches.push({ page: page.page, start, end });
    }
    from = index + Math.max(1, foldedQuery.length);
  }
  return matches;
}

export function rectsForMatch(
  page: PageTextIndex,
  start: number,
  end: number,
  viewport: PageViewport
): CssRect[] {
  const rects: CssRect[] = [];
  for (const run of page.runs) {
    const runEnd = run.start + run.str.length;
    const a = Math.max(start, run.start);
    const b = Math.min(end, runEnd);
    if (a >= b || run.str.length === 0) continue;
    const t0 = (a - run.start) / run.str.length;
    const t1 = (b - run.start) / run.str.length;
    const tx = Util.transform(viewport.transform, run.transform);
    const height = Math.hypot(Number(tx[2]) || 0, Number(tx[3]) || 0);
    const width = (run.width || 0) * viewport.scale;
    const left = Number(tx[4]) + width * t0;
    const top = Number(tx[5]) - height;
    const slice = width * (t1 - t0);
    if (slice < 0.5 || height < 0.5) continue;
    rects.push({ left, top, width: slice, height });
  }
  return rects;
}
