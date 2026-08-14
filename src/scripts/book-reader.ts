import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorker;

type SpreadPages = {
  left: number | null;
  right: number | null;
};

function pagesForSpread(spread: number, pageCount: number): SpreadPages {
  const left = 2 * spread;
  const right = 2 * spread + 1;
  return {
    left: left >= 1 && left <= pageCount ? left : null,
    right: right <= pageCount ? right : null,
  };
}

function maxSpread(pageCount: number): number {
  return Math.floor(pageCount / 2);
}

export async function initBookReader(root: HTMLElement): Promise<void> {
  const pdfUrl = root.dataset.pdfUrl;
  if (!pdfUrl) throw new Error("Missing data-pdf-url");

  const leftBtn = mustQuery(root, "[data-page='left']") as HTMLButtonElement;
  const rightBtn = mustQuery(root, "[data-page='right']") as HTMLButtonElement;
  const leftCanvas = mustQuery(leftBtn, "canvas") as HTMLCanvasElement;
  const rightCanvas = mustQuery(rightBtn, "canvas") as HTMLCanvasElement;

  const pdf = await getDocument({ url: pdfUrl }).promise;
  const pageCount = pdf.numPages;
  let spread = 0;
  let renderToken = 0;

  leftBtn.addEventListener("click", () => {
    if (spread <= 0) return;
    spread -= 1;
    void showSpread();
  });

  rightBtn.addEventListener("click", () => {
    if (spread >= maxSpread(pageCount)) return;
    spread += 1;
    void showSpread();
  });

  window.addEventListener("resize", () => void showSpread());

  await showSpread();

  async function showSpread() {
    const token = ++renderToken;
    const { left, right } = pagesForSpread(spread, pageCount);
    const canPrev = spread > 0;
    const canNext = spread < maxSpread(pageCount);
    const samplePageNumber = left ?? right;
    if (samplePageNumber === null) return;

    leftBtn.dataset.empty = String(left === null);
    rightBtn.dataset.empty = String(right === null);
    leftBtn.dataset.active = String(left !== null && canPrev);
    rightBtn.dataset.active = String(right !== null && canNext);

    const closed = left === null || right === null;
    const firstPage = left ?? right!;
    const lastPage = right ?? left!;
    const pagesRead = firstPage - 1;
    const pagesRemaining = pageCount - lastPage;
    const maxEdge = Math.min(
      40,
      Math.min(leftBtn.clientWidth, rightBtn.clientWidth) * 0.14,
    );
    const edgeScale = maxEdge / Math.max(pageCount - 1, 1);
    const leftEdge = closed ? 0 : edgeScale * pagesRead;
    const rightEdge = closed ? 0 : edgeScale * pagesRemaining;

    leftBtn.style.setProperty("--edge-width", `${leftEdge}px`);
    rightBtn.style.setProperty("--edge-width", `${rightEdge}px`);

    const samplePage = await pdf.getPage(samplePageNumber);
    if (token !== renderToken) return;

    const base = samplePage.getViewport({ scale: 1 });
    const maxWidth = Math.min(
      leftBtn.clientWidth - leftEdge,
      rightBtn.clientWidth - rightEdge,
    );
    const maxHeight = Math.min(leftBtn.clientHeight, rightBtn.clientHeight);
    if (maxWidth < 1 || maxHeight < 1) return;

    const fit = Math.min(maxWidth / base.width, maxHeight / base.height);
    const cssWidth = Math.floor(base.width * fit);
    const cssHeight = Math.floor(base.height * fit);

    await Promise.all([
      left !== null
        ? renderPage(pdf, left, leftCanvas, cssWidth, cssHeight, token)
        : clearCanvas(leftCanvas),
      right !== null
        ? renderPage(pdf, right, rightCanvas, cssWidth, cssHeight, token)
        : clearCanvas(rightCanvas),
    ]);
  }

  async function renderPage(
    doc: PDFDocumentProxy,
    pageNumber: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
    token: number,
  ) {
    const page: PDFPageProxy = await doc.getPage(pageNumber);
    if (token !== renderToken) return;

    const base = page.getViewport({ scale: 1 });
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({
      scale: (cssWidth / base.width) * outputScale,
    });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const context = canvas.getContext("2d");
    if (!context) return;

    await page.render({ canvas, canvasContext: context, viewport }).promise;
  }
}

function clearCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (context) context.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.width = "";
  canvas.style.height = "";
}

function mustQuery(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Missing element: ${selector}`);
  }
  return el;
}
