import { Util } from "pdfjs-dist";
import type { PageViewport } from "pdfjs-dist";

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  fontName?: string;
};

type PdfFontStyle = {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
};

type PdfTextContent = {
  items: unknown[];
  styles?: Record<string, PdfFontStyle>;
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
  vertical: boolean;
  ascent: number;
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
  const styles = content.styles ?? {};
  const runs: TextRun[] = [];
  let text = "";
  for (const item of content.items) {
    if (!isTextItem(item)) continue;
    const style = item.fontName ? styles[item.fontName] : undefined;
    if (item.str.length > 0) {
      runs.push({
        str: item.str,
        start: text.length,
        transform: item.transform,
        width: item.width,
        height: item.height,
        vertical: !!style?.vertical,
        ascent: fontAscentRatio(style),
      });
      text += item.str;
    }
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
  for (let i = 0; i < text.length;) {
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

function fontAscentRatio(style: PdfFontStyle | undefined): number {
  if (typeof style?.ascent === "number" && style.ascent) return style.ascent;
  if (typeof style?.descent === "number" && style.descent) {
    return 1 + style.descent;
  }
  return 0.8;
}

function textRunSpans(container: HTMLElement): HTMLElement[] {
  const spans: HTMLElement[] = [];
  const visit = (node: Node) => {
    if (node instanceof HTMLElement && node.tagName === "SPAN") {
      const hasText = [...node.childNodes].some(
        (child) =>
          child.nodeType === Node.TEXT_NODE &&
          (child.nodeValue?.length ?? 0) > 0
      );
      if (hasText && !node.classList.contains("markedContent")) {
        spans.push(node);
      }
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(container);
  return spans;
}

function firstTextNode(span: HTMLElement): Text | null {
  for (const child of span.childNodes) {
    if (
      child.nodeType === Node.TEXT_NODE &&
      (child.nodeValue?.length ?? 0) > 0
    ) {
      return child as Text;
    }
  }
  return null;
}

export function clearTextLayerHighlights(container: HTMLElement) {
  for (const mark of [...container.querySelectorAll("mark")]) {
    mark.replaceWith(...mark.childNodes);
  }
  container.normalize();
}

function wrapTextSlice(node: Text, from: number, to: number, current: boolean) {
  let slice = node;
  if (from > 0) slice = node.splitText(from);
  const length = to - from;
  if (slice.data.length > length) slice.splitText(length);
  const mark = document.createElement("mark");
  if (current) mark.classList.add("is-current");
  slice.before(mark);
  mark.append(slice);
}

/**
 * Wrap matches in the pdf.js text layer so highlights share each span's
 * scaleX / rotation. Returns false if the layer does not line up with the
 * search index (caller should fall back to overlay rects).
 */
export function highlightMatchesInTextLayer(
  textContainer: HTMLElement,
  page: PageTextIndex,
  matches: { start: number; end: number; current: boolean }[]
): boolean {
  clearTextLayerHighlights(textContainer);
  const spans = textRunSpans(textContainer);
  if (spans.length !== page.runs.length) return false;

  const slicesByRun: { from: number; to: number; current: boolean }[][] =
    page.runs.map(() => []);
  for (const match of matches) {
    for (let i = 0; i < page.runs.length; i++) {
      const run = page.runs[i]!;
      const runEnd = run.start + run.str.length;
      const from = Math.max(match.start, run.start) - run.start;
      const to = Math.min(match.end, runEnd) - run.start;
      if (from >= to) continue;
      slicesByRun[i]!.push({ from, to, current: match.current });
    }
  }

  for (let i = 0; i < page.runs.length; i++) {
    const slices = slicesByRun[i]!;
    if (slices.length === 0) continue;
    const textNode = firstTextNode(spans[i]!);
    if (!textNode) {
      clearTextLayerHighlights(textContainer);
      return false;
    }
    slices.sort((a, b) => b.from - a.from);
    for (const slice of slices) {
      if (slice.to > textNode.data.length) {
        clearTextLayerHighlights(textContainer);
        return false;
      }
      wrapTextSlice(textNode, slice.from, slice.to, slice.current);
    }
  }
  return true;
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
  const raw = viewport.rawDims as {
    pageWidth: number;
    pageHeight: number;
    pageX: number;
    pageY: number;
  };
  const pageWidth = raw.pageWidth;
  const pageHeight = raw.pageHeight;
  if (!(pageWidth > 0) || !(pageHeight > 0)) return [];

  // Same unscaled, y-flipped transform the pdf.js text layer uses, so
  // highlights can be placed as % of the page box (not scaled CSS pixels).
  const layerTransform = [1, 0, 0, -1, -raw.pageX, raw.pageY + pageHeight];
  const rects: CssRect[] = [];

  for (const run of page.runs) {
    const runEnd = run.start + run.str.length;
    const a = Math.max(start, run.start);
    const b = Math.min(end, runEnd);
    if (a >= b || run.str.length === 0) continue;
    const t0 = (a - run.start) / run.str.length;
    const t1 = (b - run.start) / run.str.length;
    const tx = Util.transform(layerTransform, run.transform);
    const fontHeight = Math.hypot(Number(tx[2]) || 0, Number(tx[3]) || 0);
    const fontAscent = fontHeight * run.ascent;
    let angle = Math.atan2(Number(tx[1]) || 0, Number(tx[0]) || 0);
    if (run.vertical) angle += Math.PI / 2;
    let originX: number;
    let originY: number;
    if (Math.abs(angle) < 1e-5) {
      originX = Number(tx[4]) || 0;
      originY = (Number(tx[5]) || 0) - fontAscent;
    } else {
      originX = (Number(tx[4]) || 0) + fontAscent * Math.sin(angle);
      originY = (Number(tx[5]) || 0) - fontAscent * Math.cos(angle);
    }
    const runWidth = (run.vertical ? run.height : run.width) || 0;
    const left = originX + runWidth * t0;
    const slice = runWidth * (t1 - t0);
    if (slice < 0.01 || fontHeight < 0.01) continue;
    rects.push({
      left: (100 * left) / pageWidth,
      top: (100 * originY) / pageHeight,
      width: (100 * slice) / pageWidth,
      height: (100 * fontHeight) / pageHeight,
    });
  }
  return rects;
}
